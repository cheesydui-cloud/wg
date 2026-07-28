const crypto = require('crypto');

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
  // cm / 家宽前置：7901 TCP（mieru）；vps 也可用 7901
  const listenPort = template === 'vps' ? 8443 : 7901;
  return {
    listenPort,
    protocol: 'TCP',
    endpoint: '',
    mtu: 1400,
    multiplexing: 'MULTIPLEXING_LOW',
    trafficPattern: 'conservative',
    // legacy WG fields unused in v2
    interfaceName: 'wg0',
    privateKey: '',
    publicKey: '',
    address: '10.8.0.1/24',
    dns: '1.1.1.1',
    postUp: '',
    postDown: '',
    confPath: '',
  };
}

function ensureNodes(state) {
  if (!Array.isArray(state.nodes)) state.nodes = [];
  return state.nodes;
}

function isNodeOnline(node) {
  return Boolean(node?.lastSeenAt && Date.now() - new Date(node.lastSeenAt).getTime() < ONLINE_MS);
}

function publicNode(node, { includeToken = false, hasher = null, userCount = null } = {}) {
  if (!node) return null;
  const online = isNodeOnline(node);
  reclaimStaleJobs(node);
  const report = node.lastReport || {};
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
    lastReport: report,
    clientCount: userCount != null ? userCount : (node.clients || []).length,
    endpoint: node.server?.endpoint || '',
    listenPort: Number(node.server?.listenPort) || 7901,
    protocol: node.server?.protocol || 'TCP',
    dirty: isNodeDirty(node, hasher),
    lastAppliedAt: node.lastAppliedAt || null,
    pendingJobs: (node.jobs || []).filter((j) => j.status === 'pending' || j.status === 'running')
      .length,
    mita: report.mita || null,
    exitPublicIp: report.exitPublicIp || null,
    usageAvailable: Boolean(report.usage?.available),
  };
  if (includeToken && node.tokenPlain) out.token = node.tokenPlain;
  return out;
}

function publicNodeServer(s) {
  if (!s) return null;
  return {
    listenPort: Number(s.listenPort) || 7901,
    protocol: s.protocol || 'TCP',
    endpoint: s.endpoint || '',
    mtu: s.mtu ?? 1400,
    multiplexing: s.multiplexing || 'MULTIPLEXING_LOW',
    trafficPattern: s.trafficPattern || 'conservative',
  };
}

function publicNodeClient(c) {
  return {
    id: c.id,
    name: c.name,
    enabled: c.enabled !== false,
    note: c.note || '',
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    hasPassword: Boolean(c.password),
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
  // 只镜像服务端参数；客户端用户以 state.clients 为唯一真源
  // （多落地时绝不能把全量/过滤用户互相覆盖）
  node.server = { ...(node.server || {}), ...state.server };
  return node;
}

/**
 * 将主节点配置同步回统一 state（心跳/任务后）
 * 注意：node.clients 可能只是「本落地过滤后的子集」（bundle/apply 会写），
 * 绝不能用它覆盖 state.clients，否则其它落地的用户会在刷新/心跳后消失。
 */
function syncStateFromPrimary(state, node) {
  if (!node) return;
  if (state.mode !== 'agent') return;
  if (state.primaryNodeId && node.id !== state.primaryNodeId) return;
  // 仅同步 server 元数据与应用时间；用户列表永不从 node 回写
  if (node.server && typeof node.server === 'object') {
    const keepListen =
      state.server?.listenPort != null ? state.server.listenPort : node.server.listenPort;
    state.server = {
      ...state.server,
      // 不把 node 上可能过期的整包 server 无脑盖掉关键字段以外的业务
      protocol: node.server.protocol || state.server.protocol,
      mtu: node.server.mtu != null ? node.server.mtu : state.server.mtu,
      multiplexing: node.server.multiplexing || state.server.multiplexing,
      // endpoint 以全局/拓扑为准，避免被旧 node.server 冲掉
      endpoint: state.server.endpoint || node.server.endpoint || '',
      listenPort: keepListen,
    };
  }
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
  if (state.server?.listenPort || state.server?.endpoint) {
    node.server = { ...node.server, ...state.server };
  } else if (node.server) {
    state.server = { ...state.server, ...node.server };
  }
  // 用户只存在 state.clients；node.clients 仅作缓存/脏标记辅助，缺省留空
  if (!Array.isArray(node.clients)) node.clients = [];
  return { node, token, created };
}

/**
 * 启动/加载时：若历史数据把用户只写在 node.clients（旧单落地镜像），
 * 且 state.clients 为空或缺少这些用户，则合并回来。
 * 绝不反向用过滤后的 node.clients 覆盖 state.clients。
 */
function mergeClientsFromNodes(state) {
  if (!Array.isArray(state.clients)) state.clients = [];
  const byId = new Map();
  const byName = new Map();
  for (const c of state.clients) {
    if (c?.id) byId.set(c.id, c);
    if (c?.name) byName.set(c.name, c);
  }
  let added = 0;
  for (const node of ensureNodes(state)) {
    if (!Array.isArray(node.clients)) continue;
    for (const c of node.clients) {
      if (!c || typeof c !== 'object') continue;
      if (c.id && byId.has(c.id)) continue;
      if (c.name && byName.has(c.name)) continue;
      // 补绑落地
      if (!c.route) c.route = {};
      if (!c.route.landingNodeId) c.route.landingNodeId = node.id;
      if (!c.id) c.id = newId();
      state.clients.push(c);
      byId.set(c.id, c);
      if (c.name) byName.set(c.name, c);
      added += 1;
    }
  }
  return added;
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

function configHashForNode(node, hasher) {
  // 优先 nodeHash(整节点)：与面板 buildBundleForNode.configHash 对齐
  if (hasher && typeof hasher.nodeHash === 'function') {
    const h = hasher.nodeHash(node);
    if (h) return h;
  }
  const fakeState = { server: node.server, clients: node.clients, id: node.id };
  if (hasher && typeof hasher.configHash === 'function') {
    return hasher.configHash(fakeState);
  }
  if (hasher && typeof hasher === 'object' && hasher.configHash) {
    return hasher.configHash(fakeState);
  }
  // fallback：简单 hash
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(JSON.stringify(fakeState)).digest('hex');
}

function isNodeDirty(node, hasher) {
  const hasUsers = (node.clients || []).length > 0;
  // 无绑定用户：不需要、也无法 apply → 不算 dirty（并清掉误打的脏标记）
  // 旧逻辑：listenPort 或 _dirtyFlag 会让 pro3「用户0」永远黄条
  if (!hasUsers) {
    if (node._dirtyFlag) node._dirtyFlag = false;
    return false;
  }
  if (node._dirtyFlag) return true;
  // 从未成功应用且有用户 → dirty
  if (!node.lastAppliedHash) return true;
  if (hasher) {
    try {
      const h = configHashForNode(node, hasher);
      if (!h) return true;
      return h !== node.lastAppliedHash;
    } catch {
      return true;
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

/**
 * 兼容旧调用；v4 实际 bundle 由 server/index.js 用 mieru 按节点过滤用户
 */
function buildAgentBundle(node, hasher) {
  const fakeState = { server: node.server || {}, clients: node.clients || [] };
  let configHash = null;
  if (hasher && typeof hasher.configHash === 'function') {
    try {
      configHash = hasher.configHash(fakeState);
    } catch {
      configHash = null;
    }
  }
  return {
    protocol: 'mieru',
    nodeId: node.id,
    name: node.name,
    server: {
      listenPort: Number(node.server?.listenPort) || 7901,
      protocol: node.server?.protocol || 'TCP',
      endpoint: node.server?.endpoint || '',
      mtu: node.server?.mtu ?? 1400,
      multiplexing: node.server?.multiplexing || 'MULTIPLEXING_LOW',
    },
    users: (node.clients || []).map((c) => ({
      id: c.id,
      name: c.name,
      password: c.password,
      enabled: c.enabled !== false,
      package: c.package || null,
    })),
    configHash,
  };
}

/** 标记指定落地 dirty */
function markDirtyForLanding(state, nodeId) {
  if (!nodeId) return null;
  const node = findNode(state, nodeId);
  if (node) markNodeDirty(node);
  return node;
}

/** 所有节点 dirty（全局 server 变更） */
function markAllNodesDirty(state) {
  for (const n of ensureNodes(state)) markNodeDirty(n);
}

function listPublicNodes(state, hasher = null, userCountFn = null) {
  return ensureNodes(state).map((n) =>
    publicNode(n, {
      hasher,
      userCount: userCountFn ? userCountFn(n.id) : null,
    })
  );
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
  mergeClientsFromNodes,
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
  markDirtyForLanding,
  markAllNodesDirty,
  listPublicNodes,
};
