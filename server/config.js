const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.WG_DATA_DIR || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function defaultState() {
  return {
    version: 4,
    protocol: 'mieru', // mieru | wireguard(legacy)
    mode: 'local', // local | agent
    primaryNodeId: null,
    username: 'admin',
    passwordHash: null,
    passwordSalt: null,
    forcePasswordChange: false,
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    wizardDone: false,
    clientsNeedRescan: false,
    lastAppliedHash: null,
    lastAppliedAt: null,
    server: {
      // mieru / mita
      listenPort: 7901,
      protocol: 'TCP', // TCP | UDP | BOTH
      endpoint: '',
      mtu: 1400,
      multiplexing: 'MULTIPLEXING_LOW',
      trafficPattern: 'conservative',
      // legacy WG fields kept for migration display only
      interfaceName: 'wg0',
      privateKey: '',
      publicKey: '',
      address: '10.8.0.1/24',
      dns: '1.1.1.1',
      postUp: '',
      postDown: '',
      confPath: '/etc/wireguard/wg0.conf',
    },
    // mieru 下 clients = 代理用户；WG 遗留为 peers
    clients: [],
    nodes: [],
    settings: {
      theme: 'auto',
      language: 'zh',
      showAdvancedNodes: false,
    },
    legacyWireGuard: null,
  };
}

/**
 * v1-v3 → v4：默认切到 mieru 单一出口
 * 保留旧 WG 数据到 legacyWireGuard，避免误当当前协议
 */
function migrateState(parsed) {
  const base = defaultState();
  const state = {
    ...base,
    ...parsed,
    server: { ...base.server, ...(parsed.server || {}) },
    settings: { ...base.settings, ...(parsed.settings || {}) },
    clients: Array.isArray(parsed.clients) ? parsed.clients : [],
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
  };

  const version = Number(parsed.version || 1);

  // 已是 v4
  if (version >= 4) {
    state.version = 4;
    state.protocol = state.protocol === 'wireguard' ? 'wireguard' : 'mieru';
    if (!state.server.protocol) state.server.protocol = 'TCP';
    if (!state.server.listenPort) state.server.listenPort = 7901;
    return state;
  }

  // v3 及以下：推断 mode/primary，并切换协议为 mieru
  state.version = 4;
  state.protocol = 'mieru';

  const nodes = state.nodes || [];
  let best = null;
  let bestScore = -1;
  for (const n of nodes) {
    let score = 0;
    if (n.server?.endpoint) score += 5;
    if (n.lastSeenAt) score += 2;
    score += (n.clients || []).length;
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }

  if (parsed.mode === 'agent' || (best && bestScore >= 2)) {
    state.mode = 'agent';
    state.primaryNodeId = parsed.primaryNodeId || (best && best.id) || null;
    if (best?.server?.endpoint && !state.server.endpoint) {
      state.server.endpoint = best.server.endpoint;
    }
    if (best?.server?.listenPort) {
      state.server.listenPort = Number(best.server.listenPort) || 7901;
    }
  } else {
    state.mode = parsed.mode === 'agent' ? 'agent' : 'local';
    state.primaryNodeId = state.mode === 'agent' ? parsed.primaryNodeId || null : null;
  }

  // 归档旧 WG 客户端（含密钥的 peer），新客户端列表从空开始或转换简单用户
  const oldClients = Array.isArray(parsed.clients) ? parsed.clients : [];
  const looksLikeWgPeers = oldClients.some((c) => c.privateKey || c.publicKey || c.address);
  if (looksLikeWgPeers) {
    state.legacyWireGuard = {
      server: { ...parsed.server },
      clients: oldClients,
      migratedAt: new Date().toISOString(),
    };
    // mieru 需要 name/password 用户；不把 WG peer 当用户
    state.clients = [];
    state.lastAppliedHash = null;
    state.lastAppliedAt = null;
  } else {
    // 已是用户形态
    state.clients = oldClients.map((c) => ({
      id: c.id || crypto.randomUUID(),
      name: c.name || `u${crypto.randomBytes(3).toString('hex')}`,
      password: c.password || crypto.randomBytes(12).toString('base64url'),
      enabled: c.enabled !== false,
      note: c.note || '',
      createdAt: c.createdAt || new Date().toISOString(),
      updatedAt: c.updatedAt || new Date().toISOString(),
    }));
  }

  state.server.protocol = state.server.protocol || 'TCP';
  if (!state.server.listenPort) state.server.listenPort = 7901;
  // 清掉仅 WG 语义的脏标记
  state.clientsNeedRescan = false;

  return state;
}

function loadState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    const state = defaultState();
    saveState(state);
    return state;
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const state = migrateState(parsed);
    if (Number(parsed.version || 1) < 4 || parsed.protocol === undefined) {
      saveState(state);
      console.log(`[panel] 已迁移 state 到 v4，协议: ${state.protocol}，模式: ${state.mode}`);
    }
    return state;
  } catch (err) {
    console.error('读取状态失败，使用默认配置:', err.message);
    return defaultState();
  }
}

function saveState(state) {
  ensureDataDir();
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

const PORT = Number(process.env.WG_PORT || process.env.PORT || 51821);
const HOST = process.env.WG_HOST || '0.0.0.0';
const PASSWORD = process.env.WG_PASSWORD || '';
const USERNAME = process.env.WG_USERNAME || 'admin';
const FORCE_PASSWORD_CHANGE = process.env.WG_FORCE_PASSWORD_CHANGE === '1';

module.exports = {
  ROOT,
  DATA_DIR,
  STATE_FILE,
  SESSIONS_FILE,
  BACKUP_DIR,
  PORT,
  HOST,
  PASSWORD,
  USERNAME,
  FORCE_PASSWORD_CHANGE,
  loadState,
  saveState,
  defaultState,
  migrateState,
  ensureDataDir,
};
