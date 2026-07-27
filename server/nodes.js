const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cryptoWg = require('./crypto-wg');

const ONLINE_MS = 90 * 1000;
const JOB_KEEP = 40;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function newId() {
  return crypto.randomUUID();
}

function defaultNodeServer() {
  const kp = cryptoWg.generateKeyPair();
  return {
    interfaceName: 'wg0',
    // 商家 CM 等机器常用 7900-7999；默认 7901，避免与 SSH 7900 冲突。可按节点修改。
    listenPort: 7901,
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

function publicNode(node, { includeToken = false } = {}) {
  if (!node) return null;
  const online = Boolean(node.lastSeenAt && Date.now() - new Date(node.lastSeenAt).getTime() < ONLINE_MS);
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
    listenPort: node.server?.listenPort || 51820,
    publicKey: node.server?.publicKey || '',
    interfaceName: node.server?.interfaceName || 'wg0',
    dirty: isNodeDirty(node),
    lastAppliedAt: node.lastAppliedAt || null,
    pendingJobs: (node.jobs || []).filter((j) => j.status === 'pending').length,
  };
  if (includeToken && node.tokenPlain) out.token = node.tokenPlain;
  return out;
}

function publicNodeServer(s) {
  if (!s) return null;
  return {
    interfaceName: s.interfaceName,
    listenPort: s.listenPort,
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

function createNode(state, { name, note } = {}) {
  const token = newToken();
  const node = {
    id: newId(),
    name: (name || '').trim() || `节点-${ensureNodes(state).length + 1}`,
    note: note || '',
    tokenHash: hashToken(token),
    tokenPlain: token, // 仅创建时返回；可轮换
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    hostname: '',
    agentVersion: '',
    meta: {},
    lastReport: null,
    server: defaultNodeServer(),
    clients: [],
    jobs: [],
    lastAppliedHash: null,
    lastAppliedAt: null,
  };
  ensureNodes(state).push(node);
  return { node, token };
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
  return removed;
}

function configHashForNode(node, wg) {
  const fakeState = { server: node.server, clients: node.clients };
  wg.ensureServerKeys(fakeState);
  node.server = fakeState.server;
  return wg.configHash(fakeState);
}

function isNodeDirty(node) {
  if (!node.lastAppliedHash) {
    return (node.clients || []).length > 0 || Boolean(node.server?.privateKey);
  }
  // lightweight: compare stored hash field set on apply job success
  return Boolean(node._dirtyFlag);
}

function markNodeDirty(node) {
  node._dirtyFlag = true;
}

function markNodeClean(node, hash) {
  node.lastAppliedHash = hash;
  node.lastAppliedAt = new Date().toISOString();
  node._dirtyFlag = false;
}

function enqueueJob(node, type, payload = {}) {
  if (!Array.isArray(node.jobs)) node.jobs = [];
  const job = {
    id: newId(),
    type,
    payload,
    status: 'pending',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    result: null,
  };
  node.jobs.unshift(job);
  if (node.jobs.length > JOB_KEEP) node.jobs.length = JOB_KEEP;
  return job;
}

function getPendingJobs(node, limit = 5) {
  return (node.jobs || []).filter((j) => j.status === 'pending').slice(0, limit);
}

function completeJob(node, jobId, result) {
  const job = (node.jobs || []).find((j) => j.id === jobId);
  if (!job) return null;
  job.status = result?.ok ? 'done' : 'error';
  job.finishedAt = new Date().toISOString();
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
  // merge live peer info into clients
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
    }
  }
}

function buildAgentBundle(node, wg) {
  const fakeState = { server: node.server, clients: node.clients || [] };
  wg.ensureServerKeys(fakeState);
  node.server = fakeState.server;
  // heal empty client IPs
  for (const c of node.clients || []) {
    if (c.enabled === false) continue;
    if (wg.isValidClientAddress(c.address)) continue;
    try {
      c.address = wg.nextClientAddress(
        node.server.address,
        node.clients.filter((x) => x.id !== c.id)
      );
    } catch {
      /* leave */
    }
  }
  const config = wg.buildServerConfig(fakeState);
  const hash = wg.configHash(fakeState);
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
    // agent needs private key to write conf
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
  };
}

function installCommand({ panelUrl, token, name }) {
  const base = String(panelUrl || '').replace(/\/$/, '');
  const safeName = String(name || 'node').replace(/"/g, '').replace(/'/g, '');
  // 单行，避免 JSON/复制时反斜杠续行出问题
  return (
    `curl -fsSL "${base}/install-agent.sh" | ` +
    `sudo env WG_PANEL_URL="${base}" WG_AGENT_TOKEN="${token}" WG_AGENT_NAME="${safeName}" bash`
  );
}

module.exports = {
  ONLINE_MS,
  ensureNodes,
  publicNode,
  publicNodeServer,
  publicNodeClient,
  findNode,
  findNodeByToken,
  createNode,
  rotateNodeToken,
  deleteNode,
  enqueueJob,
  getPendingJobs,
  completeJob,
  touchNode,
  buildAgentBundle,
  installCommand,
  markNodeDirty,
  markNodeClean,
  configHashForNode,
  defaultNodeServer,
  hashToken,
};
