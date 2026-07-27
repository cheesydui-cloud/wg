const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.WG_DATA_DIR || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function defaultState() {
  return {
    version: 3,
    mode: 'local', // local | agent
    primaryNodeId: null,
    username: 'admin',
    passwordHash: null,
    passwordSalt: null,
    forcePasswordChange: false,
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    wizardDone: false,
    lastAppliedHash: null,
    lastAppliedAt: null,
    server: {
      interfaceName: 'wg0',
      listenPort: 51820,
      privateKey: '',
      publicKey: '',
      address: '10.8.0.1/24',
      endpoint: '',
      dns: '1.1.1.1',
      mtu: 1420,
      postUp: '',
      postDown: '',
      confPath: '/etc/wireguard/wg0.conf',
    },
    clients: [],
    nodes: [],
    settings: {
      theme: 'auto',
      language: 'zh',
      showAdvancedNodes: false,
    },
  };
}

/**
 * 将 v1/v2 state 迁移到 v3：单一出口模型
 * - mode: local | agent
 * - 若已有带配置的节点，优先采用 agent 模式并把节点配置提升为唯一出口
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
  if (version >= 3 && (state.mode === 'local' || state.mode === 'agent')) {
    state.version = 3;
    if (state.mode !== 'agent') state.primaryNodeId = state.primaryNodeId || null;
    return state;
  }

  state.version = 3;

  // 选择最可能的主节点：有 endpoint 或有客户端的优先
  const nodes = state.nodes || [];
  let best = null;
  let bestScore = -1;
  for (const n of nodes) {
    let score = 0;
    if (n.server?.endpoint) score += 5;
    if (n.server?.privateKey) score += 2;
    score += (n.clients || []).length * 3;
    if (n.lastSeenAt) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }

  const localHasClients = (state.clients || []).length > 0;
  const localHasEndpoint = Boolean(state.server?.endpoint);
  const nodeLooksPrimary = best && bestScore >= 3 && (!localHasClients || bestScore > (localHasClients ? 3 : 0) + (localHasEndpoint ? 5 : 0));

  if (nodeLooksPrimary && best) {
    state.mode = 'agent';
    state.primaryNodeId = best.id;
    // 提升节点配置为唯一出口
    if (best.server) {
      state.server = { ...base.server, ...best.server };
    }
    if (Array.isArray(best.clients) && best.clients.length) {
      // 若本机也有客户端，节点优先（用户更可能在用远程落地）
      state.clients = best.clients;
    }
    state.lastAppliedHash = best.lastAppliedHash || state.lastAppliedHash;
    state.lastAppliedAt = best.lastAppliedAt || state.lastAppliedAt;
  } else {
    state.mode = parsed.mode === 'agent' ? 'agent' : 'local';
    state.primaryNodeId = parsed.primaryNodeId || (state.mode === 'agent' && best ? best.id : null);
  }

  if (state.mode === 'agent' && !state.primaryNodeId && best) {
    state.primaryNodeId = best.id;
  }
  if (state.mode === 'local') {
    state.primaryNodeId = null;
  }

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
    // 迁移后写回，避免每次启动重复推断
    if (Number(parsed.version || 1) < 3 || parsed.mode === undefined) {
      saveState(state);
      console.log(`[wg-panel] 已迁移 state 到 v3，模式: ${state.mode}`);
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
const WG_QUICK = process.env.WG_QUICK_BIN || 'wg-quick';
const WG_BIN = process.env.WG_BIN || 'wg';
const ALLOW_APPLY = process.env.WG_ALLOW_APPLY !== '0';
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
  WG_QUICK,
  WG_BIN,
  ALLOW_APPLY,
  FORCE_PASSWORD_CHANGE,
  loadState,
  saveState,
  defaultState,
  migrateState,
  ensureDataDir,
};
