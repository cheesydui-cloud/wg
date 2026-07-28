const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const topology = require('./topology');

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
    version: 5,
    protocol: 'mieru',
    mode: 'agent', // v3 默认远程家宽落地
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
    topology: topology.defaultTopology(),
    server: {
      listenPort: 7901,
      protocol: 'TCP',
      endpoint: '211.136.162.184:7901',
      mtu: 1400,
      multiplexing: 'MULTIPLEXING_LOW',
      trafficPattern: 'conservative',
      interfaceName: 'wg0',
      privateKey: '',
      publicKey: '',
      address: '10.8.0.1/24',
      dns: '1.1.1.1',
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
    legacyWireGuard: null,
  };
}

/**
 * → v5：商家移动入口 → 沪日IX → 美国家宽
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
    topology: parsed.topology
      ? {
          ...base.topology,
          ...parsed.topology,
          ingress: { ...base.topology.ingress, ...(parsed.topology.ingress || {}) },
          ix: { ...base.topology.ix, ...(parsed.topology.ix || {}) },
          landing: { ...base.topology.landing, ...(parsed.topology.landing || {}) },
          panel: { ...base.topology.panel, ...(parsed.topology.panel || {}) },
        }
      : base.topology,
  };

  const version = Number(parsed.version || 1);

  // 旧 WG peers
  if (version < 4) {
    const oldClients = Array.isArray(parsed.clients) ? parsed.clients : [];
    const looksLikeWgPeers = oldClients.some((c) => c.privateKey || c.publicKey || c.address);
    if (looksLikeWgPeers) {
      state.legacyWireGuard = {
        server: { ...parsed.server },
        clients: oldClients,
        migratedAt: new Date().toISOString(),
      };
      state.clients = [];
      state.lastAppliedHash = null;
      state.lastAppliedAt = null;
    }
  }

  // mode / primary
  if (version < 4) {
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
    }
  }

  state.version = 5;
  state.protocol = state.protocol === 'wireguard' ? 'wireguard' : 'mieru';
  if (!state.server.protocol) state.server.protocol = 'TCP';
  if (!state.server.listenPort) state.server.listenPort = 7901;

  // 从旧 endpoint 推断 topology.ingress
  if (!parsed.topology || version < 5) {
    const ep = String(state.server.endpoint || '');
    if (ep.includes('114.111.176.37')) {
      state.topology.ingress.active = 'external';
      state.topology.ingress.externalHost = '114.111.176.37';
    } else if (ep.includes('211.136.162.184')) {
      state.topology.ingress.active = 'mobile';
      state.topology.ingress.mobileHost = '211.136.162.184';
    } else if (ep) {
      const host = ep.replace(/:\d+$/, '');
      if (host && host !== '211.136.162.184' && host !== '114.111.176.37') {
        state.topology.ingress.active = 'custom';
        state.topology.ingress.customHost = host;
      }
    }
    const m = ep.match(/:(\d+)$/);
    if (m) state.topology.ingress.port = Number(m[1]) || 7901;
    else if (state.server.listenPort) state.topology.ingress.port = Number(state.server.listenPort) || 7901;
  }

  // 合法化用户名（中文挪备注）在 ensure 时处理；这里先保证 topology 同步
  topology.ensureTopology(state);

  // v3 产品默认远程落地（已有 mode 则保留）
  if (version < 5 && !parsed.mode) state.mode = 'agent';

  return state;
}

function loadState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    const state = defaultState();
    topology.ensureTopology(state);
    saveState(state);
    return state;
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const state = migrateState(parsed);
    if (Number(parsed.version || 1) < 5) {
      saveState(state);
      console.log(`[panel] 已迁移 state 到 v5 拓扑 · 模式 ${state.mode}`);
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
