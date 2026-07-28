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

function defaultClientPackage() {
  return {
    quotaMb: 0,
    quotaDays: 30,
    quotaMode: 'rolling',
    expireAt: '',
    bandwidthMbps: 0,
  };
}

function defaultClientRoute(primaryNodeId = null) {
  return {
    landingNodeId: primaryNodeId || null,
    ixId: null,
    listenPort: null,
    ingressActive: null,
  };
}

function defaultClientUsage() {
  return {
    downloadBytes: 0,
    uploadBytes: 0,
    totalBytes: 0,
    quotaUsedMb: null,
    quotaLimitMb: null,
    collectedAt: null,
    source: null,
  };
}

function defaultState() {
  return {
    version: 6,
    protocol: 'mieru',
    mode: 'agent',
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
      endpoint: '114.111.176.37:7901',
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
      showAdvancedNodes: true,
      autoApplyEnforce: true,
    },
    legacyWireGuard: null,
  };
}

/**
 * → v5 拓扑；→ v6 多 IX / 多落地 / 用户路由与套餐
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
      ? topology.migrateLegacyTopology({
          ...base.topology,
          ...parsed.topology,
          ingress: { ...base.topology.ingress, ...(parsed.topology.ingress || {}) },
          panel: { ...base.topology.panel, ...(parsed.topology.panel || {}) },
          ix: parsed.topology.ix,
          landing: parsed.topology.landing,
          ixes: parsed.topology.ixes,
          landings: parsed.topology.landings,
        })
      : base.topology,
  };

  const version = Number(parsed.version || 1);

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

  // v6: bind landings to primary; ensure client route/package/usage
  topology.ensureTopology(state);
  if (state.primaryNodeId && state.topology.landings[0] && !state.topology.landings[0].nodeId) {
    state.topology.landings[0].nodeId = state.primaryNodeId;
  }
  // copy v3 ix homeReachable into default landing if needed
  if (parsed.topology?.ix?.homeReachableHost) {
    const L = state.topology.landings[0];
    if (L && !L.homeReachableHost) {
      L.homeReachableHost = String(parsed.topology.ix.homeReachableHost).trim();
      L.homeReachablePort =
        Number(parsed.topology.ix.homeReachablePort) || state.topology.ingress.port;
    }
    if (state.topology.ixes[0] && !state.topology.ixes[0].homeReachableHost) {
      state.topology.ixes[0].homeReachableHost = String(parsed.topology.ix.homeReachableHost).trim();
      state.topology.ixes[0].homeReachablePort =
        Number(parsed.topology.ix.homeReachablePort) || state.topology.ingress.port;
      state.topology.ixes[0].forwardConfigured = Boolean(parsed.topology.ix.forwardConfigured);
    }
  }

  for (const c of state.clients) {
    ensureClientFields(c, state.primaryNodeId);
  }

  if (version < 5 && !parsed.mode) state.mode = 'agent';
  if (state.settings.autoApplyEnforce === undefined) state.settings.autoApplyEnforce = true;
  if (state.settings.showAdvancedNodes === undefined) state.settings.showAdvancedNodes = true;

  state.version = 6;
  return state;
}

function ensureClientFields(c, primaryNodeId = null) {
  // 旧数据/手工导入可能没有 id，编辑保存会 PUT /api/clients/undefined →「用户不存在」
  if (!c.id || typeof c.id !== 'string' || !String(c.id).trim()) {
    c.id = crypto.randomUUID();
  }
  if (!c.route || typeof c.route !== 'object') c.route = defaultClientRoute(primaryNodeId);
  else {
    c.route = {
      ...defaultClientRoute(primaryNodeId),
      ...c.route,
      landingNodeId: c.route.landingNodeId || primaryNodeId || null,
    };
  }
  if (!c.package || typeof c.package !== 'object') c.package = defaultClientPackage();
  else c.package = { ...defaultClientPackage(), ...c.package };
  if (!c.usage || typeof c.usage !== 'object') c.usage = defaultClientUsage();
  else c.usage = { ...defaultClientUsage(), ...c.usage };
  return c;
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
    if (Number(parsed.version || 1) < 6) {
      // backup before rewrite
      try {
        const bak = path.join(BACKUP_DIR, `state-v${parsed.version || 1}-${Date.now()}.json`);
        fs.writeFileSync(bak, raw, 'utf8');
        console.log(`[panel] 已备份旧 state → ${bak}`);
      } catch (e) {
        console.warn('[panel] 备份旧 state 失败:', e.message);
      }
      saveState(state);
      console.log(`[panel] 已迁移 state 到 v6 多落地/套餐 · 模式 ${state.mode}`);
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
  ensureClientFields,
  defaultClientPackage,
  defaultClientRoute,
  defaultClientUsage,
};
