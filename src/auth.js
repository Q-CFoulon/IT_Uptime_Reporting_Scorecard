import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb } from './db.js';
import { getSecret, setSecrets } from './secrets.js';

const sessions = new Map(); // sid -> { user, expires }
let CFG;

function hash(pw, salt) { return scryptSync(pw, salt, 32).toString('hex'); }

export function initAuth(cfg) {
  CFG = cfg;
  const db = getDb();

  // Bootstrap the admin user on first run.
  const existing = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (existing === 0) {
    const pw = process.env.ADMIN_PASSWORD || randomBytes(9).toString('base64url');
    const salt = randomBytes(16).toString('hex');
    db.prepare('INSERT INTO users(username,pw_hash,salt,role,created) VALUES(?,?,?,?,?)')
      .run('admin', hash(pw, salt), salt, 'admin', Date.now());
    if (process.env.ADMIN_PASSWORD) console.log('[auth] created user "admin" from ADMIN_PASSWORD');
    else console.log(`\n[auth] ===== FIRST-RUN ADMIN PASSWORD (shown once) =====\n[auth]   username: admin\n[auth]   password: ${pw}\n[auth] Set ADMIN_PASSWORD to control this. Change it after login.\n`);
  }

  // API token for automation (X-Api-Token header).
  if (!getSecret('api.token')) {
    const t = randomBytes(24).toString('base64url');
    setSecrets({ 'api.token': t });
    console.log(`[auth] generated API token (data/secrets.json): ${t}`);
  }
}

export function login(username, password) {
  const u = getDb().prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u) return null;
  const cand = Buffer.from(hash(password, u.salt), 'hex');
  const real = Buffer.from(u.pw_hash, 'hex');
  if (cand.length !== real.length || !timingSafeEqual(cand, real)) return null;
  const sid = randomBytes(24).toString('base64url');
  sessions.set(sid, { user: u.username, expires: Date.now() + CFG.auth.sessionTtlHours * 3600000 });
  return sid;
}

export function changePassword(username, newPw) {
  const salt = randomBytes(16).toString('hex');
  getDb().prepare('UPDATE users SET pw_hash=?, salt=? WHERE username=?').run(hash(newPw, salt), salt, username);
}

export function logout(sid) { sessions.delete(sid); }

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => { const i = c.indexOf('='); if (i > -1) out[c.slice(0, i).trim()] = c.slice(i + 1).trim(); });
  return out;
}

// Returns the authenticated principal, or null.
export function authenticate(req) {
  if (!CFG.auth.enabled) return { user: 'anonymous', via: 'disabled' };
  const tok = req.headers['x-api-token'];
  if (tok && getSecret('api.token') && tok === getSecret('api.token')) return { user: 'api', via: 'token' };
  const sid = parseCookies(req).sid;
  const s = sid && sessions.get(sid);
  if (s && s.expires > Date.now()) return { user: s.user, via: 'session', sid };
  if (s) sessions.delete(sid);
  return null;
}
