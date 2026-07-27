const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sessions = new Map(); // token -> { exp }
const loginAttempts = new Map(); // key -> { count, lockedUntil, firstAt }

const DEFAULT_USERNAME = 'admin';
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let sessionsFile = null;

function setSessionsFile(filePath) {
  sessionsFile = filePath;
  loadSessionsFromDisk();
}

function loadSessionsFromDisk() {
  if (!sessionsFile || !fs.existsSync(sessionsFile)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    const now = Date.now();
    for (const [token, exp] of Object.entries(raw || {})) {
      if (exp > now) sessions.set(token, { exp });
    }
  } catch {
    /* ignore */
  }
}

function saveSessionsToDisk() {
  if (!sessionsFile) return;
  try {
    const out = {};
    const now = Date.now();
    for (const [token, s] of sessions.entries()) {
      if (s.exp > now) out[token] = s.exp;
    }
    const dir = path.dirname(sessionsFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = sessionsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
    fs.renameSync(tmp, sessionsFile);
  } catch (err) {
    console.error('[auth] 保存会话失败:', err.message);
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function setPassword(state, password, username) {
  const salt = crypto.randomBytes(16).toString('hex');
  state.passwordSalt = salt;
  state.passwordHash = hashPassword(password, salt);
  state.username = String(username || state.username || DEFAULT_USERNAME).trim() || DEFAULT_USERNAME;
}

function verifyPassword(state, password) {
  if (!state.passwordHash || !state.passwordSalt) return false;
  const hash = hashPassword(password, state.passwordSalt);
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(state.passwordHash, 'hex'));
  } catch {
    return false;
  }
}

function verifyLogin(state, username, password) {
  const expectedUser = String(state.username || DEFAULT_USERNAME);
  const inputUser = String(username || '').trim() || DEFAULT_USERNAME;
  const a = Buffer.from(inputUser);
  const b = Buffer.from(expectedUser);
  let userOk = a.length === b.length;
  if (userOk) {
    try {
      userOk = crypto.timingSafeEqual(a, b);
    } catch {
      userOk = false;
    }
  } else {
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
  }
  const passOk = verifyPassword(state, password);
  return userOk && passOk;
}

function attemptKey(ip, username) {
  return `${ip || 'unknown'}|${String(username || DEFAULT_USERNAME).trim() || DEFAULT_USERNAME}`;
}

function getLockStatus(ip, username) {
  const key = attemptKey(ip, username);
  const rec = loginAttempts.get(key);
  if (!rec) return { locked: false, remainingAttempts: MAX_ATTEMPTS };
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) {
    return {
      locked: true,
      retryAfterSec: Math.ceil((rec.lockedUntil - Date.now()) / 1000),
      remainingAttempts: 0,
    };
  }
  if (rec.lockedUntil && Date.now() >= rec.lockedUntil) {
    loginAttempts.delete(key);
    return { locked: false, remainingAttempts: MAX_ATTEMPTS };
  }
  if (rec.firstAt && Date.now() - rec.firstAt > WINDOW_MS) {
    loginAttempts.delete(key);
    return { locked: false, remainingAttempts: MAX_ATTEMPTS };
  }
  return {
    locked: false,
    remainingAttempts: Math.max(0, MAX_ATTEMPTS - (rec.count || 0)),
  };
}

function recordLoginFailure(ip, username) {
  const key = attemptKey(ip, username);
  const now = Date.now();
  let rec = loginAttempts.get(key);
  if (!rec || (rec.firstAt && now - rec.firstAt > WINDOW_MS) || (rec.lockedUntil && now >= rec.lockedUntil)) {
    rec = { count: 0, firstAt: now, lockedUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCK_MS;
  }
  loginAttempts.set(key, rec);
  return getLockStatus(ip, username);
}

function clearLoginFailures(ip, username) {
  loginAttempts.delete(attemptKey(ip, username));
}

function createSession(ttlMs = SESSION_TTL_MS) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { exp: Date.now() + ttlMs });
  saveSessionsToDisk();
  return token;
}

function destroySession(token) {
  if (token) sessions.delete(token);
  saveSessionsToDisk();
}

function isAuthed(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() > s.exp) {
    sessions.delete(token);
    saveSessionsToDisk();
    return false;
  }
  s.exp = Date.now() + SESSION_TTL_MS;
  return true;
}

function needsSetup(state) {
  return !state.passwordHash;
}

function generateRandomPassword(length = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function authMiddleware(getState) {
  return (req, res, next) => {
    const state = getState();
    if (needsSetup(state)) {
      if (req.path === '/api/setup' || req.path === '/api/status' || req.path.startsWith('/api/setup')) {
        return next();
      }
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({ error: '请先完成初始化设置', needSetup: true });
      }
    }

    if (!req.path.startsWith('/api/')) return next();
    if (req.path === '/api/login' || req.path === '/api/status' || req.path === '/api/health') return next();

    const token = req.cookies?.wg_session || req.headers['x-session-token'];
    if (!isAuthed(token)) {
      return res.status(401).json({ error: '未登录或会话已过期', needLogin: true });
    }
    // 滑动续期时偶尔落盘
    if (Math.random() < 0.05) saveSessionsToDisk();
    req.sessionToken = token;
    next();
  };
}

module.exports = {
  DEFAULT_USERNAME,
  MAX_ATTEMPTS,
  LOCK_MS,
  setSessionsFile,
  setPassword,
  verifyPassword,
  verifyLogin,
  getLockStatus,
  recordLoginFailure,
  clearLoginFailures,
  createSession,
  destroySession,
  isAuthed,
  needsSetup,
  generateRandomPassword,
  authMiddleware,
  saveSessionsToDisk,
};
