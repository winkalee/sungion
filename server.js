const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3700);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = path.join(__dirname, 'data.json');

// 公用邮箱 SMTP
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const FROM = process.env.FROM || SMTP_USER || '位置服务';
let mailer = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) { try { const nodemailer = require('nodemailer'); mailer = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } }); } catch (e) {} }

// MySQL（可选）：配置了 DB_* 环境变量就用 MySQL 永久保存，否则回退 data.json 文件
const DB_HOST = process.env.DB_HOST || '';
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = process.env.DB_USER || '';
const DB_PASS = process.env.DB_PASS || '';
const DB_NAME = process.env.DB_NAME || '';
let useDb = !!(DB_HOST && DB_USER && DB_NAME);
let pool = null;
function getPool() {
  if (!pool) {
    const mysql = require('mysql2/promise');
    pool = mysql.createPool({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, database: DB_NAME, waitForConnections: true, connectionLimit: 5, charset: 'utf8mb4' });
  }
  return pool;
}

let db = { users: {}, sessions: {} };
function newRule() { return { interval: 30, precision: 'city', enabled: false }; }
function newUser(name) { return { salt: '', hash: '', recipients: [], rule: newRule(), location: null, records: [], lastSendAt: 0 }; }

function loadFile() {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { db = { users: {}, sessions: {} }; }
  if (!db.users) db.users = {};
  if (!db.sessions) db.sessions = {};
  for (const n in db.users) {
    const u = db.users[n];
    if (!u.rule) u.rule = newRule();
    if (!u.recipients) u.recipients = [];
    if (!u.records) u.records = [];
  }
}

async function loadDb() {
  const p = getPool();
  await p.query('CREATE TABLE IF NOT EXISTS users (username VARCHAR(20) PRIMARY KEY, salt VARCHAR(32) NOT NULL, hash VARCHAR(128) NOT NULL, data JSON NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
  const [rows] = await p.query('SELECT username, salt, hash, data FROM users');
  db.users = {};
  db.sessions = {};
  for (const r of rows) {
    let d = {};
    try { d = (typeof r.data === 'string') ? JSON.parse(r.data) : (r.data || {}); } catch (e) {}
    db.users[r.username] = { salt: r.salt, hash: r.hash, recipients: d.recipients || [], rule: Object.assign(newRule(), d.rule || {}), location: d.location || null, records: d.records || [], lastSendAt: d.lastSendAt || 0 };
  }
}

let saveChain = Promise.resolve();
function save() {
  if (!useDb) { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db), 'utf8'); } catch (e) {} return; }
  const jobs = Object.keys(db.users).map(n => {
    const u = db.users[n];
    const data = JSON.stringify({ recipients: u.recipients || [], rule: u.rule, location: u.location || null, records: u.records || [], lastSendAt: u.lastSendAt || 0 });
    return { name: n, salt: u.salt, hash: u.hash, data };
  });
  saveChain = saveChain.then(async () => {
    const p = getPool();
    for (const j of jobs) {
      await p.query('INSERT INTO users (username, salt, hash, data) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE salt = VALUES(salt), hash = VALUES(hash), data = VALUES(data)', [j.name, j.salt, j.hash, j.data]);
    }
  }).catch(e => console.error('save err:', e && e.message));
}

function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }

const NL = String.fromCharCode(10);
function fmt(t) { return new Date(t).toLocaleString('zh-CN', { hour12: false }); }
function mapLink(loc) { return 'https://uri.amap.com/marker?position=' + loc.lng + ',' + loc.lat; }
function json(res, code, obj) { try { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); } catch (e) {} }
function file(res, name, mime) { try { const p = path.join(__dirname, name); if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(p)); } catch (e) { try { res.writeHead(500); res.end('err'); } catch (_) {} } }
function readBody(req) { return new Promise(resolve => { let b = ''; req.on('data', c => { b += c; if (b.length > 20 * 1024 * 1024) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve(null); } }); req.on('error', () => resolve(null)); }); }
function getUser(req) { const a = req.headers['authorization'] || ''; const t = a.indexOf('Bearer ') === 0 ? a.slice(7) : ''; return t && db.sessions[t] ? db.sessions[t] : null; }

function stateOf(u) {
  const user = db.users[u];
  const canAuto = user.rule.enabled && user.recipients.length > 0 && user.location;
  const next = canAuto && user.lastSendAt ? user.lastSendAt + user.rule.interval * 60000 : null;
  return { username: u, recipients: user.recipients, rule: user.rule, location: user.location, records: user.records.slice(0, 100), nextSendAt: next, smtp: !!mailer };
}

async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=jsonv2&accept-language=zh-CN', { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'location-web/1.0' } });
    const j = await r.json(); const a = j.address || {};
    return a.city || a.town || a.county || a.state_district || a.state || '';
  } catch (e) { return ''; }
}

async function doSend(u, trigger) {
  const user = db.users[u];
  if (!user.location) { user.records.unshift({ t: Date.now(), trigger, result: 'fail', reason: '无可用位置' }); save(); return { ok: false, reason: '无可用位置' }; }
  if (!user.recipients.length) { user.records.unshift({ t: Date.now(), trigger, result: 'fail', reason: '无接收人' }); save(); return { ok: false, reason: '无接收人' }; }
  const loc = user.location;
  const addr = user.rule.precision === 'city' ? (loc.city || loc.address) : (loc.full || loc.address);
  const text = ['位置更新', '时间：' + fmt(Date.now()), '当前位置：' + addr, '坐标：' + loc.lat.toFixed(6) + ', ' + loc.lng.toFixed(6), '精度：约 ' + Math.round(loc.acc) + ' 米', '触发：' + trigger, '地图：' + mapLink(loc)].join(NL);
  const subject = '位置更新 - ' + fmt(Date.now());
  const rec = { t: Date.now(), trigger, address: addr, recipients: user.recipients.slice(), result: 'sent', body: text, simulated: false, error: '' };
  if (!mailer) { rec.result = 'fail'; rec.simulated = true; rec.error = 'SMTP 未配置'; user.records.unshift(rec); save(); return { ok: false, reason: 'SMTP 未配置', text }; }
  try {
    const attachments = loc.imageBase64 ? [{ filename: 'snapshot.jpg', content: Buffer.from(loc.imageBase64, 'base64'), contentType: 'image/jpeg' }] : [];
    await mailer.sendMail({ from: FROM, to: user.recipients.join(','), subject, text, attachments });
  } catch (e) { rec.result = 'fail'; rec.error = (e && e.message) || 'send fail'; }
  user.records.unshift(rec); if (user.records.length > 500) user.records = user.records.slice(0, 500); user.lastSendAt = Date.now(); save();
  return { ok: rec.result === 'sent', reason: rec.error, text };
}

setInterval(function () {
  for (const u in db.users) {
    const user = db.users[u];
    if (user.rule.enabled && user.recipients.length && user.location && Date.now() - user.lastSendAt >= user.rule.interval * 60000) doSend(u, '定时');
  }
}, 20000);

const srv = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', 'http://x');
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) return file(res, 'index.html', 'text/html; charset=utf-8');
    if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true, smtp: !!mailer, storage: useDb ? 'mysql' : 'file', users: Object.keys(db.users).length });

    if (req.method === 'POST' && u.pathname === '/api/register') {
      const o = await readBody(req);
      if (!o) return json(res, 400, { error: 'bad request' });
      const name = String(o.username || '').trim();
      const pw = String(o.password || '');
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(name)) return json(res, 400, { error: '用户名需 3-20 位字母数字下划线' });
      if (pw.length < 6) return json(res, 400, { error: '密码至少 6 位' });
      if (db.users[name]) return json(res, 400, { error: '用户名已存在' });
      const salt = crypto.randomBytes(16).toString('hex');
      const user = newUser(name); user.salt = salt; user.hash = hashPw(pw, salt);
      db.users[name] = user; save();
      const token = crypto.randomBytes(32).toString('hex'); db.sessions[token] = name; save();
      return json(res, 200, { ok: true, token, username: name });
    }
    if (req.method === 'POST' && u.pathname === '/api/login') {
      const o = await readBody(req);
      if (!o) return json(res, 400, { error: 'bad request' });
      const name = String(o.username || '').trim(); const pw = String(o.password || '');
      const user = db.users[name];
      if (!user || user.hash !== hashPw(pw, user.salt)) return json(res, 401, { error: '用户名或密码错误' });
      const token = crypto.randomBytes(32).toString('hex'); db.sessions[token] = name; save();
      return json(res, 200, { ok: true, token, username: name });
    }
    if (req.method === 'POST' && u.pathname === '/api/logout') {
      const a = req.headers['authorization'] || ''; const t = a.indexOf('Bearer ') === 0 ? a.slice(7) : '';
      if (t) { delete db.sessions[t]; save(); }
      return json(res, 200, { ok: true });
    }

    const me = getUser(req);
    if (!me) return json(res, 401, { error: '未登录' });
    if (req.method === 'GET' && u.pathname === '/api/state') return json(res, 200, stateOf(me));
    if (req.method === 'POST' && u.pathname === '/api/location') {
      const o = await readBody(req);
      if (!o) return json(res, 400, { error: 'bad request' });
      const lat = Number(o.lat), lng = Number(o.lng);
      if (!isFinite(lat) || !isFinite(lng)) return json(res, 400, { error: '缺少坐标' });
      const city = await reverseGeocode(lat, lng);
      const full = String(o.full || city || '');
      db.users[me].location = { lat, lng, city, full, address: city || full || (lat.toFixed(5) + ', ' + lng.toFixed(5)), acc: Number(o.accuracy) || 0, imageBase64: String(o.imageBase64 || ''), t: Date.now() };
      save(); return json(res, 200, stateOf(me));
    }
    if (req.method === 'POST' && u.pathname === '/api/recipients/add') {
      const o = await readBody(req); if (!o) return json(res, 400, { error: 'bad request' });
      const email = String(o.email || '').trim().toLowerCase();
      const ok = email.indexOf('@') > 0 && email.indexOf('.') > email.indexOf('@') + 1;
      if (!ok) return json(res, 400, { error: '邮箱格式不对' });
      if (!db.users[me].recipients.includes(email)) db.users[me].recipients.push(email);
      save(); return json(res, 200, stateOf(me));
    }
    if (req.method === 'POST' && u.pathname === '/api/recipients/remove') {
      const o = await readBody(req); if (!o) return json(res, 400, { error: 'bad request' });
      db.users[me].recipients = db.users[me].recipients.filter(x => x !== String(o.email || '').trim().toLowerCase());
      save(); return json(res, 200, stateOf(me));
    }
    if (req.method === 'POST' && u.pathname === '/api/rule') {
      const o = await readBody(req); if (!o) return json(res, 400, { error: 'bad request' });
      const r = db.users[me].rule;
      if (o.interval !== undefined) r.interval = Math.max(1, Math.min(1440, Number(o.interval) || 30));
      if (o.precision !== undefined) r.precision = (o.precision === 'exact') ? 'exact' : 'city';
      if (o.enabled !== undefined) r.enabled = !!o.enabled;
      save(); return json(res, 200, stateOf(me));
    }
    if (req.method === 'POST' && u.pathname === '/api/send-now') {
      const r = await doSend(me, '手动');
      return json(res, 200, Object.assign({ result: r }, stateOf(me)));
    }
    if (req.method === 'POST' && u.pathname === '/api/records/clear') {
      db.users[me].records = []; save(); return json(res, 200, stateOf(me));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found');
  } catch (e) {
    console.error('err:', e && e.message);
    try { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('server error'); } catch (_) {}
  }
});

(async function start() {
  if (useDb) {
    try { await loadDb(); console.log('MySQL loaded, users=' + Object.keys(db.users).length); }
    catch (e) { console.error('MySQL load failed, fallback to file:', e && e.message); useDb = false; loadFile(); }
  } else {
    loadFile();
  }
  srv.on('error', e => console.error('srv err:', e.message));
  process.on('uncaughtException', e => console.error('ue:', e.message));
  srv.listen(PORT, HOST, () => console.log('location-app on ' + HOST + ':' + PORT + (useDb ? ' (MySQL)' : ' (file)') + (mailer ? ' (SMTP ready)' : ' (SMTP 未配置)') + ' users=' + Object.keys(db.users).length));
})();
