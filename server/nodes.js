const crypto = require('crypto');
const cryptoWg = require('./crypto-wg');

const ONLINE_MS = 90 * 1000;
const JOB_KEEP = 40;
const JOB_LEASE_MS = 120 * 1000; // running 超过 2 分钟可回收重试

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function newId() {
  return crypto.randomUUID();
}

function defaultNodeServer(template = 'cm') {
  const kp = cryptoWg.generateKeyPair();
  // cm: 7901；vps: 51820
  const listenPort = template === 'vps' ? 51820 : 7901;
  return {
    interfaceName: 'wg0',
    listenPort,
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    address: '10.8.0.1/24',
    endpoint: '',
    dns: '1.1.1.1',
    mtu: 1420,
    postUp: '',
    postDown: '',
    confPath: '/etc/wireguard/wg0.conf',
  };
}

function ensureNodes(state) {
  if (!Array.isArray(state.nodes)) state.nodes = [];
  return state.nodes;
}

function isNodeOnline(node) {
  return Boolean(node?.lastSeenAt && Date.now() - new Date(node.lastSeenAt).getTime() < ONLINE_MS);
}

function publicNode(node, { includeToken = false } = {}) {
  if (!node) return null;
  const online = isNodeOnline(node);
  reclaimStaleJobs(node);
  const out = {
    id: node.id,
    name: node.name,
    note: node.note || '',
    online,
    lastSeenAt: node.lastSeenAt || null,
    createdAt: node.createdAt,
    hostname: node.hostname || '',
    agentVersion: node.agentVersion || '',
    meta: node.meta || {},
    lastReport: node.lastReport || null,
    clientCount: (node.clients || []).length,
    endpoint: node.server?.endpoint || '',
    listenPort: Number(node.server?.listenPort) || 7901,
    publicKey: node.server?.publicKey || '',
    interfaceName: node.server?.interfaceName || 'wg0',
    dirty: isNodeDirty(node, null),
    lastAppliedAt: node.lastAppliedAt || null,
    pendingJobs: (node.jobs || []).filter((j) => j.status === 'pending' || j.status === 'running')
      .length,
  };
  if (includeToken && node.tokenPlain) out.token = node.tokenPlain;
  return out;
}

function publicNodeServer(s) {
  if (!s) return null;
  return {
    interfaceName: s.interfaceName,
    listenPort: Number(s.listenPort) || 7901,
    publicKey: s.publicKey,
    address: s.address,
    endpoint: s.endpoint,
    dns: s.dns,
    mtu: s.mtu,
    postUp: s.postUp,
    postDown: s.postDown,
    confPath: s.confPath,
    hasPrivateKey: Boolean(s.privateKey),
  };
}

function publicNodeClient(c) {
  return {
    id: c.id,
    name: c.name,
    publicKey: c.publicKey,
    address: c.address,
    allowedIPs: c.allowedIPs,
    persistentKeepalive: c.persistentKeepalive,
    enabled: c.enabled !== false,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    note: c.note || '',
    hasPresharedKey: Boolean(c.presharedKey),
    online: Boolean(c._online),
    latestHandshake: c._latestHandshake || '',
    transfer: c._transfer || '',
    transferRx: c._transferRx || '',
    transferTx: c._transferTx || '',
  };
}

function findNode(state, id) {
  return ensureNodes(state).find((n) => n.id === id) || null;
}

function findNodeByToken(state, token) {
  if (!token) return null;
  const h = hashToken(token);
  return ensureNodes(state).find((n) => n.tokenHash === h) || null;
}

function getPrimaryNode(state) {
  if (state.mode !== 'agent') return null;
  if (state.primaryNodeId) {
    const n = findNode(state, state.primaryNodeId);
    if (n) return n;
  }
  // fallback: first node
  const list = ensureNodes(state);
  return list[0] || null;
}

/**
 * 将当前统一 server/clients 同步到主节点（agent 模式）
 */
function syncPrimaryFromState(state) {
  const node = getPrimaryNode(state);
  if (!node) return null;
  node.server = { ...(node.server || {}), ...state.server };
  node.clients = Array.isArray(state.clients) ? state.clients : [];
  return node;
}

/**
 * 将主节点配置同步回统一 state（心跳/任务后）
 */
function syncStateFromPrimary(state, node) {
  if (!node) return;
  if (state.mode !== 'agent') return;
  if (state.primaryNodeId && node.id !== state.primaryNodeId) return;
  state.server = { ...state.server, ...node.server };
  state.clients = Array.isArray(node.clients) ? node.clients : state.clients;
  if (node.lastAppliedHash) state.lastAppliedHash = node.lastAppliedHash;
  if (node.lastAppliedAt) state.lastAppliedAt = node.lastAppliedAt;
}

function createNode(state, { name, note, template } = {}) {
  const token = newToken();
  const node = {
    id: newId(),
    name: (name || '').trim() || `出口-${ensureNodes(state).length + 1}`,
    note: note || '',
    tokenHash: hashToken(token),
    tokenPlain: token,
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    hostname: '',
    agentVersion: '',
    meta: {},
    lastReport: null,
    server: defaultNodeServer(template || 'cm'),
    clients: [],
    jobs: [],
    lastAppliedHash: null,
    lastAppliedAt: null,
  };
  ensureNodes(state).push(node);
  return { node, token };
}

/**
 * 确保 agent 模式下有主节点；没有则创建
 */
function ensurePrimaryNode(state, { name, template } = {}) {
  let node = getPrimaryNode(state);
  let token = null;
  let created = false;
  if (!node) {
    const res = createNode(state, {
      name: name || '落地出口',
      template: template || 'cm',
    });
    node = res.node;
    token = res.token;
    created = true;
  }
  state.mode = 'agent';
  state.primaryNodeId = node.id;
  // 若统一 state 已有配置，同步到节点
  if (state.server?.privateKey) {
    node.server = { ...node.server, ...state.server };
  } else if (node.server) {
    state.server = { ...state.server, ...node.server };
  }
  if (Array.isArray(state.clients) && state.clients.length && !(node.clients || []).length) {
    node.clients = state.clients;
  } else if ((node.clients || []).length && !(state.clients || []).length) {
    state.clients = node.clients;
  }
  return { node, token, created };
}

function rotateNodeToken(node) {
  const token = newToken();
  node.tokenHash = hashToken(token);
  node.tokenPlain = token;
  return token;
}

function deleteNode(state, id) {
  const list = ensureNodes(state);
  const idx = list.findIndex((n) => n.id === id);
  if (idx < 0) return null;
  const [removed] = list.splice(idx, 1);
  if (state.primaryNodeId === id) {
    state.primaryNodeId = list[0]?.id || null;
    if (!state.primaryNodeId && state.mode === 'agent') {
      // 无节点时退回 local，避免卡死
      state.mode = 'local';
    }
  }
  return removed;
}

function configHashForNode(node, wg) {
  const fakeState = { server: node.server, clients: node.clients };
  wg.ensureServerKeys(fakeState);
  node.server = fakeState.server;
  return wg.configHash(fakeState);
}

function isNodeDirty(node, wg) {
  if (node._dirtyFlag) return true;
  if (!node.lastAppliedHash) {
    return (node.clients || []).length > 0 || Boolean(node.server?.privateKey);
  }
  // 有 wg 时用配置 hash 校准，避免 flag 卡住
  if (wg) {
    try {
      const h = configHashForNode(node, wg);
      return h !== node.lastAppliedHash;
    } catch {
      return Boolean(node._dirtyFlag);
    }
  }
  return false;
}

function markNodeDirty(node) {
  node._dirtyFlag = true;
}

function markNodeClean(node, hash) {
  node.lastAppliedHash = hash;
  node.lastAppliedAt = new Date().toISOString();
  node._dirtyFlag = false;
}

function reclaimStaleJobs(node) {
  if (!node || !Array.isArray(node.jobs)) return 0;
  const now = Date.now();
  let n = 0;
  for (const job of node.jobs) {
    if (job.status !== 'running') continue;
    const started = job.startedAt ? new Date(job.startedAt).getTime() : 0;
    const leaseEnd = job.leaseUntil ? new Date(job.leaseUntil).getTime() : started + JOB_LEASE_MS;
    if (!started || now > leaseEnd) {
      job.status = 'pending';
      job.startedAt = null;
      job.leaseUntil = null;
      job.result = job.result || { ok: false, message: '任务超时，已重新排队' };
      n += 1;
    }
  }
  return n;
}

function enqueueJob(node, type, payload = {}) {
  if (!Array.isArray(node.jobs)) node.jobs = [];
  // 同类 pending 去重，避免狂点
  const existing = node.jobs.find(
    (j) => j.status === 'pending' && j.type === type && !payload.forceNew
  );
  if (existing && !payload.forceNew) {
    existing.payload = { ...existing.payload, ...payload };
    existing.createdAt = new Date().toISOString();
    return existing;
  }
  const job = {
    id: newId(),
    type,
    payload,
    status: 'pending',
    createdAt: new Date().toISOString(),
    startedAt: null,
    leaseUntil: null,
    finishedAt: null,
    result: null,
  };
  node.jobs.unshift(job);
  if (node.jobs.length > JOB_KEEP) node.jobs.length = JOB_KEEP;
  return job;
}

function getPendingJobs(node, limit = 5) {
  reclaimStaleJobs(node);
  return (node.jobs || []).filter((j) => j.status === 'pending').slice(0, limit);
}

function leaseJobs(node, jobs, leaseMs = JOB_LEASE_MS) {
  const until = new Date(Date.now() + leaseMs).toISOString();
  for (const j of jobs) {
    j.status = 'running';
    j.startedAt = new Date().toISOString();
    j.leaseUntil = until;
  }
}

function completeJob(node, jobId, result) {
  const job = (node.jobs || []).find((j) => j.id === jobId);
  if (!job) return null;
  job.status = result?.ok ? 'done' : 'error';
  job.finishedAt = new Date().toISOString();
  job.leaseUntil = null;
  job.result = {
    ok: Boolean(result?.ok),
    message: result?.message || '',
    detail: result?.detail || null,
  };
  return job;
}

function touchNode(node, report = {}) {
  node.lastSeenAt = new Date().toISOString();
  if (report.hostname) node.hostname = report.hostname;
  if (report.agentVersion) node.agentVersion = report.agentVersion;
  if (report.meta) node.meta = { ...(node.meta || {}), ...report.meta };
  if (report.status) node.lastReport = report.status;
  if (report.status?.interface?.peers && Array.isArray(node.clients)) {
    const map = new Map();
    for (const p of report.status.interface.peers) {
      if (p.publicKey) map.set(p.publicKey, p);
    }
    for (const c of node.clients) {
      const live = map.get(c.publicKey);
      c._online = Boolean(live?.online);
      c._latestHandshake = live?.latestHandshake || '';
      c._transfer = live?.transfer || '';
      c._transferRx = live?.transferRx || '';
      c._transferTx = live?.transferTx || '';
    }
  }
}

function buildAgentBundle(node, wg) {
  const fakeState = { server: node.server, clients: node.clients || [] };
  wg.ensureServerKeys(fakeState);
  node.server = fakeState.server;
  const skipped = [];
  for (const c of node.clients || []) {
    if (c.enabled === false) continue;
    if (wg.isValidClientAddress(c.address)) continue;
    try {
      c.address = wg.nextClientAddress(
        node.server.address,
        node.clients.filter((x) => x.id !== c.id)
      );
    } catch {
      skipped.push(c.name || c.id);
    }
  }
  const config = wg.buildServerConfig(fakeState);
  const hash = wg.configHash(fakeState);
  const peerCount = (node.clients || []).filter(
    (c) => c.enabled !== false && c.publicKey && wg.peerAllowedIps(c)
  ).length;
  return {
    nodeId: node.id,
    name: node.name,
    server: {
      interfaceName: node.server.interfaceName,
      listenPort: node.server.listenPort,
      address: node.server.address,
      endpoint: node.server.endpoint,
      dns: node.server.dns,
      mtu: node.server.mtu,
      postUp: node.server.postUp,
      postDown: node.server.postDown,
      confPath: node.server.confPath,
      publicKey: node.server.publicKey,
    },
    privateKey: node.server.privateKey,
    clients: (node.clients || []).map((c) => ({
      id: c.id,
      name: c.name,
      publicKey: c.publicKey,
      address: c.address,
      enabled: c.enabled !== false,
      presharedKey: c.presharedKey || '',
    })),
    config,
    configHash: hash,
    expectedPeers: peerCount,
    skippedClients: skipped,
  };
}

function installCommand({ panelUrl, token, name }) {
  const base = String(panelUrl || '').replace(/\/$/, '');
  const safeName = String(name || 'node').replace(/"/g, '').replace(/'/g, '');
  return (
    `curl -fsSL "${base}/install-agent.sh" | ` +
    `sudo env WG_PANEL_URL="${base}" WG_AGENT_TOKEN="${token}" WG_AGENT_NAME="${safeName}" bash`
  );
}

module.exports = {
  ONLINE_MS,
  JOB_LEASE_MS,
  ensureNodes,
  publicNode,
  publicNodeServer,
  publicNodeClient,
  findNode,
  findNodeByToken,
  getPrimaryNode,
  ensurePrimaryNode,
  syncPrimaryFromState,
  syncStateFromPrimary,
  createNode,
  rotateNodeToken,
  deleteNode,
  enqueueJob,
  getPendingJobs,
  leaseJobs,
  reclaimStaleJobs,
  completeJob,
  touchNode,
  buildAgentBundle,
  installCommand,
  markNodeDirty,
  markNodeClean,
  isNodeDirty,
  configHashForNode,
  defaultNodeServer,
  hashToken,
  isNodeOnline,
};
