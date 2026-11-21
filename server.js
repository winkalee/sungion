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

let db = { users: {}, sessions: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { db = { users: {}, sessions: {} }; }
if (!db.users) db.users = {}; if (!db.sessions) db.sessions = {};
function save() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db), 'utf8'); } catch (e) {} }

function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function newUser(name) { return { salt: '', hash: '', recipients: [], rule: { interval: 30, precision: 'city', enabled: false }, location: null, records: [], lastSendAt: 0 }; }

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
  const text = ['位置更新', '时间：' + fmt(Date.now()), '当前位置：' + addr, '坐标：' + loc.lat.toFixed(6) + ', ' + loc.lng.toFixed(6), '精度：约 ' + Math.round(loc.acc) + ' 米', '触发：' + trigger, '地图：' + mapLink(loc)].join('\n');
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
    if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true, smtp: !!mailer, users: Object.keys(db.users).length });

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

    // 以下需登录
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
srv.on('error', e => console.error('srv err:', e.message));
process.on('uncaughtException', e => console.error('ue:', e.message));
srv.listen(PORT, HOST, () => console.log('location-app on ' + HOST + ':' + PORT + (mailer ? ' (SMTP ready)' : ' (SMTP 未配置)') + ' users=' + Object.keys(db.users).length));
