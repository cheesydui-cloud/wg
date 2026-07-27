const crypto = require('crypto');

const sessions = new Map(); // token -> { exp }

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function setPassword(state, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  state.passwordSalt = salt;
  state.passwordHash = hashPassword(password, salt);
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
  // 滑动续期
  s.exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  return true;
}

function needsSetup(state) {
  return !state.passwordHash;
}

function authMiddleware(getState) {
  return (req, res, next) => {
    const state = getState();
    // 未设置密码时，允许访问 setup 相关接口
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
  setPassword,
  verifyPassword,
  createSession,
  destroySession,
  isAuthed,
  needsSetup,
  authMiddleware,
};
