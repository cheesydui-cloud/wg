const crypto = require('crypto');

const sessions = new Map(); // token -> { exp }
const DEFAULT_USERNAME = 'admin';

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
  // 用户名用固定时间比较，避免简单泄露
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
    // 长度不同也做一次 dummy 比较，降低时序差异
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
  }
  const passOk = verifyPassword(state, password);
  return userOk && passOk;
}

function createSession(ttlMs = 7 * 24 * 60 * 60 * 1000) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { exp: Date.now() + ttlMs });
  return token;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function isAuthed(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() > s.exp) {
    sessions.delete(token);
    return false;
  }
  s.exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
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
    if (req.path === '/api/login' || req.path === '/api/status') return next();

    const token = req.cookies?.wg_session || req.headers['x-session-token'];
    if (!isAuthed(token)) {
      return res.status(401).json({ error: '未登录或会话已过期', needLogin: true });
    }
    req.sessionToken = token;
    next();
  };
}

module.exports = {
  DEFAULT_USERNAME,
  setPassword,
  verifyPassword,
  verifyLogin,
  createSession,
  destroySession,
  isAuthed,
  needsSetup,
  generateRandomPassword,
  authMiddleware,
};
