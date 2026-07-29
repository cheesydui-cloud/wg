const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');

const {
  PORT,
  HOST,
  PASSWORD,
  USERNAME,
  ROOT,
  DATA_DIR,
  SESSIONS_FILE,
  FORCE_PASSWORD_CHANGE,
  loadState,
  saveState,
  ensureDataDir,
  ensureClientFields,
} = require('./config');
const auth = require('./auth');
const mieru = require('./mieru');
const nodes = require('./nodes');
const topology = require('./topology');

ensureDataDir();
auth.setSessionsFile(SESSIONS_FILE);
let state = loadState();
nodes.ensureNodes(state);
topology.ensureTopology(state);
mieru.ensureMieruDefaults(state);
// 旧数据可能把用户只存在 node.clients；合并进 state.clients（唯一真源）
try {
  const n = nodes.mergeClientsFromNodes(state);
  if (n > 0) console.log(`[panel] 从落地节点恢复了 ${n} 个用户到全局列表`);
} catch (e) {
  console.warn('[panel] mergeClientsFromNodes failed:', e.message);
}
// 保证每个客户端都有 id（否则编辑保存会「用户不存在」）
for (const c of state.clients || []) ensureClientFields(c, state.primaryNodeId);
// ensure default landing bound
if (state.primaryNodeId && state.topology.landings[0] && !state.topology.landings[0].nodeId) {
  state.topology.landings[0].nodeId = state.primaryNodeId;
}
persist();

if (!state.username) {
  state.username = auth.DEFAULT_USERNAME;
  saveState(state);
}

if (!state.passwordHash && PASSWORD) {
  auth.setPassword(state, PASSWORD, USERNAME || auth.DEFAULT_USERNAME);
  state.forcePasswordChange = FORCE_PASSWORD_CHANGE;
  saveState(state);
  console.log(`[panel] 已初始化登录账号: ${state.username}`);
}

function persist() {
  if (state.mode === 'agent') nodes.syncPrimaryFromState(state);
  saveState(state);
}

function clientIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    ''
  );
}

function hasher() {
  return {
    // 与 buildBundleForNode.configHash 同一算法，避免「apply 成功但 dirty 不消」
    nodeHash: (node) => {
      if (!node) return null;
      try {
        return buildBundleForNode(node).configHash;
      } catch {
        return null;
      }
    },
    configHash: (fake) => {
      // fake may be {server, clients} from node or full state
      if (fake && fake.id) {
        try {
          return buildBundleForNode(fake).configHash;
        } catch {
          /* fall through */
        }
      }
      if (fake && fake.clients && fake.server && !fake.topology) {
        return mieru.configHash({
          server: fake.server,
          clients: fake.clients,
          primaryNodeId: state.primaryNodeId,
        });
      }
      return mieru.configHash(fake || state);
    },
  };
}

function markDirtyUnified() {
  if (state.mode === 'agent') {
    nodes.markAllNodesDirty(state);
  }
}

function markDirtyForClient(client) {
  if (state.mode !== 'agent') return;
  const nid = mieru.clientLandingNodeId(client, state) || state.primaryNodeId;
  if (nid) nodes.markDirtyForLanding(state, nid);
  else markDirtyUnified();
}

function isUnifiedDirty() {
  if (state.mode === 'agent') {
    // 用 state.clients 实时镜像到 node.clients，避免脏标记与绑定脱节
    return nodes.ensureNodes(state).some((n) => {
      try {
        n.clients = mieru.clientsForNode(state, n.id);
      } catch {
        /* ignore */
      }
      return nodes.isNodeDirty(n, hasher());
    });
  }
  return mieru.isDirty(state);
}

/** 哪些落地仍 dirty（诊断用） */
function dirtyLandingNames() {
  if (state.mode !== 'agent') return [];
  const names = [];
  for (const n of nodes.ensureNodes(state)) {
    try {
      n.clients = mieru.clientsForNode(state, n.id);
    } catch {
      /* */
    }
    if (nodes.isNodeDirty(n, hasher())) {
      const uc = (n.clients || []).length;
      names.push(`${n.name}(${uc}用户)`);
    }
  }
  return names;
}

function anyNodeDirty() {
  return isUnifiedDirty();
}

function publicServer(s) {
  return {
    listenPort: Number(s.listenPort) || 7901,
    protocol: mieru.normalizeProtocol(s.protocol),
    endpoint: s.endpoint || '',
    mtu: s.mtu ?? 1400,
    multiplexing: s.multiplexing || 'MULTIPLEXING_LOW',
    trafficPattern: s.trafficPattern || 'conservative',
  };
}

function enrichNodePublic(node) {
  if (!node) return null;
  const userCount = mieru.clientsForNode(state, node.id).length;
  const pub = nodes.publicNode(node, { hasher: hasher(), userCount });
  const jobs = node.jobs || [];
  const latest = jobs[0] || null;
  const jobOk = latest ? latest.status === 'done' : null;
  pub.latestJob = latest
    ? {
        id: latest.id,
        type: latest.type,
        status: latest.status,
        message: sanitizeAgentMessage(latest.result?.message || '', jobOk),
        createdAt: latest.createdAt,
        finishedAt: latest.finishedAt,
      }
    : null;
  pub.isPrimary = state.primaryNodeId === node.id;
  pub.agentOutdated = isAgentOutdated(node.agentVersion);
  pub.agentTargetVersion = agentBundleVersion();
  pub.panelVersion = panelVersion();
  // 最近一次任务（含 agent_update 成败），便于 UI 展示为何没更新
  try {
    const jobs = Array.isArray(node.jobs) ? node.jobs : [];
    const last = jobs.find((j) => j && (j.type === 'agent_update' || j.type === 'self_update')) || jobs[0] || null;
    if (last) {
      pub.lastJob = {
        id: last.id,
        type: last.type,
        status: last.status,
        message: last.result?.message || '',
        createdAt: last.createdAt,
        finishedAt: last.finishedAt,
        ok: last.result?.ok,
      };
    }
    if (node.lastAgentUpdateAt) pub.lastAgentUpdateAt = node.lastAgentUpdateAt;
    if (node.lastAgentUpdateMessage) pub.lastAgentUpdateMessage = node.lastAgentUpdateMessage;
  } catch {
    /* */
  }
  pub.agentTargetVersion = agentBundleVersion();
  try {
    topology.ensureTopology(state);
    const L = topology.getLandingByNodeId(state, node.id);
    if (L) {
      pub.landingId = L.id;
      pub.listenPort = Number(L.listenPort) || pub.listenPort;
      pub.homeReachableHost = L.homeReachableHost || '';
      pub.ixId = L.ixId || null;
    }
  } catch {
    /* ignore */
  }
  return pub;
}

function publicModeInfo() {
  const primary = nodes.getPrimaryNode(state);
  const pub = primary ? enrichNodePublic(primary) : null;
  return {
    mode: state.mode || 'local',
    protocol: state.protocol || 'mieru',
    primaryNodeId: state.primaryNodeId || null,
    primaryNode: pub,
    nodes: nodes.ensureNodes(state).map((n) => enrichNodePublic(n)),
    showAdvancedNodes: Boolean(state.settings?.showAdvancedNodes),
    autoApplyEnforce: state.settings?.autoApplyEnforce !== false,
    clientsNeedRescan: Boolean(state.clientsNeedRescan),
  };
}

function panelBaseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}`.replace(/\/$/, '');
}

function applyRoutePackageBody(client, body) {
  ensureClientFields(client, state.primaryNodeId);
  if (body.route && typeof body.route === 'object') {
    const r = body.route;
    if (r.landingNodeId !== undefined) {
      const raw = r.landingNodeId;
      if (raw === null || raw === '' || raw === undefined) {
        client.route.landingNodeId = state.primaryNodeId || null;
      } else {
        client.route.landingNodeId =
          mieru.resolveLandingNodeId(state, raw, { fallbackPrimary: false }) ||
          String(raw).trim() ||
          state.primaryNodeId ||
          null;
      }
    }
    if (r.ixId !== undefined) client.route.ixId = r.ixId || null;
    if (r.listenPort !== undefined) {
      client.route.listenPort = r.listenPort ? Number(r.listenPort) : null;
    }
    if (r.ingressActive !== undefined) {
      client.route.ingressActive = r.ingressActive || null;
    }
  }
  // flat fields convenience
  if (body.landingNodeId !== undefined) {
    const raw = body.landingNodeId;
    if (raw === null || raw === '' || raw === undefined) {
      client.route.landingNodeId = state.primaryNodeId || null;
    } else {
      client.route.landingNodeId =
        mieru.resolveLandingNodeId(state, raw, { fallbackPrimary: false }) ||
        String(raw).trim() ||
        state.primaryNodeId ||
        null;
    }
  }
  if (body.listenPort !== undefined) {
    client.route.listenPort = body.listenPort ? Number(body.listenPort) : null;
  }
  if (body.ixId !== undefined) client.route.ixId = body.ixId || null;
  // 落地所属 IX 为真相源：有落地绑定时强制对齐 route.ixId（防第二台 IX 用户仍挂第一台前置）
  if (client.route.landingNodeId) {
    try {
      const L = topology.getLandingByNodeId(state, client.route.landingNodeId);
      if (L?.ixId) client.route.ixId = L.ixId;
    } catch {
      /* */
    }
  }

  // 专用端口必须落在所属 IX 端口段；与落地默认相同则清空（走落地）
  if (client.route.listenPort != null && client.route.listenPort !== '') {
    const p = Number(client.route.listenPort);
    if (!Number.isFinite(p) || p < 1 || p > 65535) {
      const err = new Error('专用端口无效');
      err.code = 'BAD_LISTEN_PORT';
      err.status = 400;
      throw err;
    }
    try {
      const L = topology.getLandingByNodeId(state, client.route.landingNodeId);
      const ix = topology.resolveIx(state, {
        landingNodeId: client.route.landingNodeId,
        ixId: client.route.ixId || L?.ixId,
      });
      if (ix && !topology.portInMerchantRange(p, ix)) {
        const err = new Error(
          `专用端口 ${p} 不在 IX「${ix.name || ix.id}」端口段 ${ix.portMin}-${ix.portMax}（请留空使用落地默认 :${L?.listenPort || ix.portMin}）`
        );
        err.code = 'PORT_OUT_OF_IX_RANGE';
        err.status = 400;
        throw err;
      }
      if (L?.listenPort && Number(L.listenPort) === p) {
        client.route.listenPort = null;
      } else {
        client.route.listenPort = p;
      }
    } catch (e) {
      if (e && e.code) throw e;
      client.route.listenPort = p;
    }
  }

  if (body.package && typeof body.package === 'object') {
    const p = body.package;
    if (p.quotaMb !== undefined) client.package.quotaMb = Math.max(0, Number(p.quotaMb) || 0);
    if (p.quotaDays !== undefined) client.package.quotaDays = Math.max(0, Number(p.quotaDays) || 0);
    if (p.quotaMode !== undefined) {
      client.package.quotaMode = p.quotaMode === 'calendar' ? 'calendar' : 'rolling';
    }
    if (p.expireAt !== undefined) client.package.expireAt = String(p.expireAt || '').trim();
    if (p.bandwidthMbps !== undefined) {
      client.package.bandwidthMbps = Math.max(0, Number(p.bandwidthMbps) || 0);
    }
  }
  if (body.quotaMb !== undefined) client.package.quotaMb = Math.max(0, Number(body.quotaMb) || 0);
  if (body.expireAt !== undefined) client.package.expireAt = String(body.expireAt || '').trim();
  if (body.quotaDays !== undefined) client.package.quotaDays = Math.max(0, Number(body.quotaDays) || 0);
}

/** mita 至少需要 1 个用户；本落地全部禁用时用占位账号顶住配置，真实用户无法认证 */
const HOLD_USER_NAME = 'panelhold';

function buildBundleForNode(node) {
  mieru.ensureMieruDefaults(state);
  topology.ensureTopology(state);
  const landing = topology.getLandingByNodeId(state, node.id);
  const listenPort =
    Number(landing?.listenPort) ||
    Number(node.server?.listenPort) ||
    Number(state.server.listenPort) ||
    7901;

  // sync node.server listenPort from landing
  node.server = {
    ...(node.server || {}),
    ...state.server,
    listenPort,
    protocol: state.server.protocol || 'TCP',
  };

  const users = mieru.usersForBundle(state, node.id);
  const enabled = users.filter((u) => u.enabled !== false && u.name && u.password);
  // 禁用用户名列表：Agent 应用后对这些账号再跑 user-disable 兜底踢出
  const disabledNames = users
    .filter((u) => u.enabled === false && u.name)
    .map((u) => String(u.name));
  let holdUser = false;
  const fakeClients = enabled.map((u) => ({
    id: u.id,
    name: u.name,
    password: u.password,
    enabled: true,
  }));
  // 本落地无任何启用用户时：写入随机密码占位用户，确保 mita apply 能覆盖掉旧账号
  if (!fakeClients.length) {
    holdUser = true;
    const holdPass =
      node._holdPassword && String(node._holdPassword).length >= 12
        ? node._holdPassword
        : mieru.randomPassword(24);
    node._holdPassword = holdPass;
    fakeClients.push({
      id: '__panel_hold',
      name: HOLD_USER_NAME,
      password: holdPass,
      enabled: true,
    });
  } else if (node._holdPassword) {
    delete node._holdPassword;
  }

  const fake = {
    server: { ...state.server, listenPort, protocol: node.server.protocol },
    clients: fakeClients,
    primaryNodeId: node.id,
  };

  let serverConfig;
  try {
    serverConfig = mieru.buildServerConfig({
      server: fake.server,
      clients: fake.clients,
      primaryNodeId: node.id,
    });
  } catch (err) {
    // rethrow
    throw err;
  }
  // 强制 portBindings 与本落地 listenPort 一致（防全局 7901 渗入）
  // BOTH：TCP=base，UDP=base+1（与分享链 / portForProtocol 一致）
  // 强制 users 只含启用账号（+ 可选占位），绝不能把 disabled 写进 mita
  serverConfig.users = fakeClients.map((u) => ({ name: u.name, password: u.password }));
  const proto = mieru.normalizeProtocol(fake.server.protocol || 'TCP');
  const bindings = [];
  for (const p of mieru.protocolsForMode(proto)) {
    bindings.push({
      port: mieru.portForProtocol(listenPort, p, proto),
      protocol: p,
    });
  }
  serverConfig.portBindings = bindings;
  const hash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        serverConfig,
        users: users.map((u) => ({ n: u.name, e: u.enabled, p: u.package })),
        holdUser,
      })
    )
    .digest('hex');

  return {
    protocol: 'mieru',
    nodeId: node.id,
    server: {
      listenPort,
      protocol: mieru.normalizeProtocol(fake.server.protocol),
      endpoint: fake.server.endpoint || '',
      mtu: fake.server.mtu,
      multiplexing: fake.server.multiplexing,
    },
    users,
    serverConfig,
    configHash: hash,
    disabledNames,
    holdUser,
  };
}

function enqueueApply(node, type = 'mieru_apply') {
  nodes.markNodeDirty(node);
  // 清掉已 error 的同类旧任务展示噪音（不影响 pending 去重）
  if (Array.isArray(node.jobs)) {
    for (const j of node.jobs) {
      if (j.type === type && j.status === 'error' && j.result?.message?.includes('超时')) {
        j.status = 'cancelled';
      }
    }
  }
  return nodes.enqueueJob(node, type, {});
}

function runEnforce() {
  const { changed, nodeIds } = mieru.enforcePackages(state);
  if (!changed.length) return { changed: [], applied: [] };
  const auto = state.settings?.autoApplyEnforce !== false;
  const applied = [];
  for (const nid of nodeIds) {
    const node = nodes.findNode(state, nid);
    if (!node) continue;
    nodes.markNodeDirty(node);
    if (auto && state.mode === 'agent') {
      enqueueApply(node, 'mieru_apply');
      applied.push(nid);
    }
  }
  persist();
  if (changed.length) {
    console.log(`[panel] 套餐强制停用 ${changed.length} 用户 · 落地 ${nodeIds.join(',') || '-'}`);
  }
  return { changed, applied };
}

// periodic enforce
setInterval(() => {
  try {
    runEnforce();
  } catch (e) {
    console.warn('[panel] enforce error:', e.message);
  }
}, 60 * 1000);


/** 旧 Agent(≤4.0) 成功文案误导，面板展示时改写 */
function sanitizeAgentMessage(msg, ok) {
  const s = String(msg || '').trim();
  if (!s) return s;
  if (/脚本异常.*mita apply.*回退成功|已用 mita apply 回退成功/.test(s)) {
    return ok !== false
      ? '落地/应用成功 · mita 已更新（旧 Agent 文案已纠正；请升级 Agent 到面板同版本）'
      : s;
  }
  if (/脚本异常/.test(s) && ok) {
    return `任务成功 · ${s.replace(/脚本异常[，,]?\s*/g, '')}`;
  }
  return s;
}

function panelVersion() {
  try {
    return require(path.join(ROOT, 'package.json')).version;
  } catch {
    return '';
  }
}

/** Agent 协议版本（agent/index.js 的 VERSION），与面板 UI 版本无关 */
function agentBundleVersion() {
  try {
    const verFile = path.join(ROOT, 'agent', 'VERSION');
    if (fs.existsSync(verFile)) {
      const v = fs.readFileSync(verFile, 'utf8').trim();
      if (v) return v.replace(/^v/i, '');
    }
  } catch {
    /* */
  }
  try {
    const src = fs.readFileSync(path.join(ROOT, 'agent', 'index.js'), 'utf8');
    const m = src.match(/const VERSION\s*=\s*['"]([^'"]+)['"]/);
    if (m) return m[1];
  } catch {
    /* */
  }
  return panelVersion();
}

function parseSemver3(v) {
  const m = String(v || '')
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isAgentOutdated(agentVer) {
  // 只对比「仓库内 Agent 脚本版本」，禁止用面板 UI 版本（4.6.x）误伤 4.3.2 Agent
  const a = parseSemver3(agentVer);
  const b = parseSemver3(agentBundleVersion());
  if (!a || !b) return Boolean(agentVer) === false ? true : false;
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(auth.authMiddleware(() => state));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/health', (req, res) => {
  // 公开探针：落地机 install 脚本会 curl 此接口；禁止依赖登录态变量
  res.json({
    ok: true,
    version: panelVersion(),
    protocol: 'mieru',
    profile: state.topology?.profile || 'cm-ix-home',
    path: 'client → merchant-ix-ingress → IX → home mita',
    multiLanding: true,
    uptime: process.uptime(),
  });
});

app.get('/install-agent.sh', (req, res) => {
  res.type('text/x-shellscript');
  res.sendFile(path.join(ROOT, 'install-agent.sh'));
});

app.get('/install-mita.sh', (req, res) => {
  res.type('text/x-shellscript');
  res.sendFile(path.join(ROOT, 'scripts', 'install-mita.sh'));
});

app.get('/api/status', async (req, res) => {
  const token = req.cookies?.wg_session || req.headers['x-session-token'];
  const loggedIn = auth.isAuthed(token);
  const modeInfo = publicModeInfo();
  const dirty = loggedIn ? isUnifiedDirty() : false;
  res.json({
    needSetup: auth.needsSetup(state),
    loggedIn,
    wizardDone: Boolean(state.wizardDone),
    defaultUsername: auth.DEFAULT_USERNAME,
    username: loggedIn ? state.username || auth.DEFAULT_USERNAME : undefined,
    forcePasswordChange: loggedIn ? Boolean(state.forcePasswordChange) : false,
    dirty,
    lastAppliedAt: loggedIn ? state.lastAppliedAt : undefined,
    clientCount: (state.clients || []).length,
    version: require(path.join(ROOT, 'package.json')).version,
    agentVersion: agentBundleVersion(),
    protocol: 'mieru',
    mode: modeInfo.mode,
    primaryNodeId: modeInfo.primaryNodeId,
    primaryNode: loggedIn ? modeInfo.primaryNode : undefined,
    nodes: loggedIn ? modeInfo.nodes : undefined,
    clientsNeedRescan: loggedIn ? Boolean(state.clientsNeedRescan) : false,
    server: loggedIn ? publicServer(state.server) : undefined,
    topology: loggedIn ? topology.publicTopology(state) : undefined,
    legacyWireGuard: loggedIn ? Boolean(state.legacyWireGuard) : false,
    settings: loggedIn
      ? {
          autoApplyEnforce: state.settings?.autoApplyEnforce !== false,
          showAdvancedNodes: Boolean(state.settings?.showAdvancedNodes),
        }
      : undefined,
  });
});

/** 关闭「已从 WireGuard 迁移」提示（仅清标记，不会重新迁移） */
app.post('/api/legacy-wg/dismiss', (req, res) => {
  state.legacyWireGuard = null;
  persist();
  res.json({ ok: true, message: '已关闭迁移提示' });
});

app.post('/api/setup', (req, res) => {
  if (!auth.needsSetup(state)) return res.status(400).json({ error: '已完成初始化' });
  const username = String(req.body?.username || auth.DEFAULT_USERNAME).trim() || auth.DEFAULT_USERNAME;
  const password = String(req.body?.password || '');
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  auth.setPassword(state, password, username);
  state.forcePasswordChange = false;
  persist();
  const token = auth.createSession();
  res.cookie('wg_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true, username: state.username });
});

app.post('/api/login', (req, res) => {
  const ip = clientIp(req);
  const username = String(req.body?.username || '');
  const password = req.body?.password;
  const lock = auth.getLockStatus(ip, username);
  if (lock.locked) {
    return res.status(429).json({
      error: `登录失败次数过多，请 ${lock.retryAfterSec} 秒后重试`,
      retryAfterSec: lock.retryAfterSec,
    });
  }
  if (!auth.verifyLogin(state, username, String(password || ''))) {
    const after = auth.recordLoginFailure(ip, username);
    if (after.locked) {
      return res.status(429).json({
        error: `用户名或密码错误，账号已临时锁定`,
        retryAfterSec: after.retryAfterSec,
      });
    }
    return res.status(401).json({
      error: `用户名或密码错误，还可尝试 ${after.remainingAttempts} 次`,
    });
  }
  auth.clearLoginFailures(ip, username);
  const token = auth.createSession();
  res.cookie('wg_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({
    ok: true,
    username: state.username || auth.DEFAULT_USERNAME,
    forcePasswordChange: Boolean(state.forcePasswordChange),
  });
});

app.post('/api/logout', (req, res) => {
  auth.destroySession(req.cookies?.wg_session);
  res.clearCookie('wg_session');
  res.json({ ok: true });
});

app.post('/api/password', (req, res) => {
  const { currentPassword, newPassword, newUsername } = req.body || {};
  if (!auth.verifyPassword(state, String(currentPassword || ''))) {
    return res.status(401).json({ error: '当前密码错误' });
  }
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' });
  }
  const user =
    newUsername !== undefined
      ? String(newUsername || auth.DEFAULT_USERNAME).trim() || auth.DEFAULT_USERNAME
      : state.username || auth.DEFAULT_USERNAME;
  auth.setPassword(state, String(newPassword), user);
  state.forcePasswordChange = false;
  persist();
  res.json({ ok: true, message: '账号已更新', username: state.username });
});

// ---------- Server (mieru) ----------

app.get('/api/server', (req, res) => {
  topology.ensureTopology(state);
  res.json({
    server: publicServer(state.server),
    topology: topology.publicTopology(state),
    wizardDone: state.wizardDone,
    dirty: isUnifiedDirty(),
    lastAppliedAt: state.lastAppliedAt,
    clientsNeedRescan: Boolean(state.clientsNeedRescan),
    protocol: 'mieru',
  });
});

app.get('/api/topology', (req, res) => {
  topology.ensureTopology(state);
  const ixId = req.query.ixId || undefined;
  const landingId = req.query.landingId || undefined;
  const port = req.query.port ? Number(req.query.port) : undefined;
  const fwd = topology.buildIxForwardScript(state, { ixId, landingId, port });
  res.json({
    topology: topology.publicTopology(state),
    forwardScript: fwd.ok ? fwd.script : '',
    forwardError: fwd.error || '',
    forwardIxId: fwd.ixId || ixId || null,
    forwardRoutes: fwd.routes || [],
    server: publicServer(state.server),
    nodes: nodes.ensureNodes(state).map((n) => enrichNodePublic(n)),
  });
});

app.put('/api/topology', (req, res) => {
  const body = req.body || {};
  const prevHash = (() => {
    try {
      return mieru.configHash(state);
    } catch {
      return null;
    }
  })();
  const { endpointChanged } = topology.applyTopologyPatch(state, body);
  let serverConfChanged = false;
  try {
    serverConfChanged = prevHash !== mieru.configHash(state);
  } catch {
    serverConfChanged = true;
  }
  if (endpointChanged) state.clientsNeedRescan = true;
  if (serverConfChanged) markDirtyUnified();
  if (state.mode === 'agent') nodes.syncPrimaryFromState(state);
  if (body.wizardDone !== undefined) state.wizardDone = Boolean(body.wizardDone);
  persist();
  const tips = [];
  if (endpointChanged) tips.push('前置入口已更新，请重新复制客户端主入口链接');
  if (serverConfChanged) tips.push('监听参数有变，请在落地「应用配置/一键落地」');
  res.json({
    ok: true,
    topology: topology.publicTopology(state),
    server: publicServer(state.server),
    dirty: isUnifiedDirty(),
    endpointChanged,
    serverConfChanged,
    clientsNeedRescan: Boolean(state.clientsNeedRescan),
    tip: tips.join('。') || '拓扑已保存',
  });
});

app.get('/api/topology/forward-script', (req, res) => {
  const fwd = topology.buildIxForwardScript(state, {
    ixId: req.query.ixId,
    landingId: req.query.landingId,
    port: req.query.port ? Number(req.query.port) : undefined,
  });
  if (!fwd.ok) return res.status(400).json({ error: fwd.error, script: '' });
  if (req.query.download === '1') {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ix-forward-${fwd.listenPort || 7901}.sh"`
    );
    res.type('text/x-shellscript');
    return res.send(fwd.script);
  }
  res.json(fwd);
});

app.put('/api/server', (req, res) => {
  const body = req.body || {};
  const s = state.server;
  const prevEndpoint = String(s.endpoint || '');
  const prevPort = Number(s.listenPort);
  const prevProto = mieru.normalizeProtocol(s.protocol);
  const prevHash = (() => {
    try {
      return mieru.configHash(state);
    } catch {
      return null;
    }
  })();

  if (body.listenPort !== undefined) s.listenPort = Number(body.listenPort) || 7901;
  if (body.protocol !== undefined) s.protocol = mieru.normalizeProtocol(body.protocol);
  if (body.endpoint !== undefined) s.endpoint = String(body.endpoint || '').trim();
  if (body.mtu !== undefined) s.mtu = body.mtu === '' || body.mtu === null ? 1400 : Number(body.mtu);
  if (body.multiplexing !== undefined) s.multiplexing = body.multiplexing;
  if (body.trafficPattern !== undefined) s.trafficPattern = body.trafficPattern;

  if (body.syncEndpointPort && s.endpoint) {
    const parsed = mieru.parseEndpoint(s.endpoint);
    const host = parsed.host || String(s.endpoint).replace(/:\d+$/, '');
    if (host) s.endpoint = `${host}:${s.listenPort}`;
  } else if (s.endpoint && !String(s.endpoint).includes(':') && s.listenPort) {
    s.endpoint = `${String(s.endpoint).trim()}:${s.listenPort}`;
  }

  topology.ensureTopology(state);
  if (body.listenPort !== undefined) state.topology.ingress.port = s.listenPort;
  if (body.protocol !== undefined) state.topology.ingress.protocol = s.protocol;
  if (body.endpoint !== undefined && s.endpoint) {
    const parsed = mieru.parseEndpoint(s.endpoint);
    const host = parsed.host || '';
    if (host && host === state.topology.ingress.mobileHost) {
      state.topology.ingress.active = 'mobile';
      state.topology.ingress.mobileHost = host;
    } else if (host && host === state.topology.ingress.externalHost) {
      state.topology.ingress.active = 'external';
      state.topology.ingress.externalHost = host;
    } else if (host) {
      state.topology.ingress.active = 'custom';
      state.topology.ingress.customHost = host;
    }
    if (parsed.port) state.topology.ingress.port = parsed.port;
  }
  topology.ensureTopology(state);

  if (body.wizardDone !== undefined) state.wizardDone = Boolean(body.wizardDone);

  const endpointChanged = prevEndpoint !== String(s.endpoint || '');
  let serverConfChanged = false;
  try {
    const nextHash = mieru.configHash(state);
    serverConfChanged =
      prevHash !== nextHash ||
      prevPort !== Number(s.listenPort) ||
      prevProto !== mieru.normalizeProtocol(s.protocol);
  } catch {
    serverConfChanged = true;
  }

  if (endpointChanged) state.clientsNeedRescan = true;
  if (state.mode === 'agent') nodes.syncPrimaryFromState(state);

  if (serverConfChanged) {
    markDirtyUnified();
  }

  persist();
  const tips = [];
  if (endpointChanged) tips.push('入站地址已更新，请重新复制/扫码客户端链接');
  if (serverConfChanged && isUnifiedDirty()) tips.push('服务端参数有变，请点「应用配置」或「一键落地」');
  res.json({
    server: publicServer(state.server),
    topology: topology.publicTopology(state),
    wizardDone: state.wizardDone,
    dirty: isUnifiedDirty(),
    endpointChanged,
    serverConfChanged,
    clientsNeedRescan: Boolean(state.clientsNeedRescan),
    tip: tips.join('。') || '已保存',
  });
});

app.post('/api/clients/rescan-ack', (req, res) => {
  state.clientsNeedRescan = false;
  persist();
  res.json({ ok: true, clientsNeedRescan: false });
});

// ---------- Clients = mieru users ----------

app.get('/api/clients', (req, res) => {
  mieru.ensureMieruDefaults(state);
  res.json({
    clients: state.clients.map((c) => mieru.publicClient(c, state)),
    dirty: isUnifiedDirty(),
    clientsNeedRescan: Boolean(state.clientsNeedRescan),
    mode: state.mode,
    protocol: 'mieru',
    nodes: nodes.ensureNodes(state).map((n) => ({
      id: n.id,
      name: n.name,
      online: nodes.isNodeOnline(n),
      isPrimary: n.id === state.primaryNodeId,
    })),
    ixes: (state.topology?.ixes || []).map((x) => ({ id: x.id, name: x.name })),
  });
});

app.get('/api/clients/usage', (req, res) => {
  mieru.ensureMieruDefaults(state);
  res.json({
    clients: state.clients.map((c) => {
      const p = mieru.publicClient(c, state);
      return {
        id: p.id,
        name: p.name,
        note: p.note,
        enabled: p.enabled,
        usage: p.usage,
        package: p.package,
        statusFlags: p.statusFlags,
        landingNodeId: p.route.landingNodeId,
      };
    }),
  });
});

app.post('/api/clients', (req, res) => {
  const body = req.body || {};
  let name = (body.name || '').trim();
  const note = (body.note || '').trim();
  if (name && !mieru.isValidMieruUsername(name)) {
    return res.status(400).json({
      error: '登录用户名只能用英文/数字/._-（例如 u7af760）。「我的手机」请填到备注',
    });
  }
  if (!name) name = mieru.randomUsername();
  if (state.clients.some((c) => c.name === name)) {
    return res.status(400).json({ error: '用户名已存在' });
  }
  const client = {
    id: crypto.randomUUID(),
    name,
    password: (body.password || '').trim() || mieru.randomPassword(18),
    enabled: body.enabled !== false,
    note: note || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  ensureClientFields(client, state.primaryNodeId);
  try {
    applyRoutePackageBody(client, body);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code || 'BAD_ROUTE' });
  }
  if (!client.route.landingNodeId) client.route.landingNodeId = state.primaryNodeId;
  // 再规范化一次，保证落盘的是 nodeId 而非 landing 拓扑 id
  if (client.route.landingNodeId) {
    client.route.landingNodeId =
      mieru.resolveLandingNodeId(state, client.route.landingNodeId, { fallbackPrimary: false }) ||
      client.route.landingNodeId;
  }
  state.clients.push(client);
  state.wizardDone = true;
  markDirtyForClient(client);
  persist();
  res.status(201).json({
    client: mieru.publicClient(client, state),
    dirty: true,
    mode: state.mode,
  });
});

app.put('/api/clients/:id', (req, res) => {
  mieru.ensureMieruDefaults(state);
  // 补齐可能缺失的 id（旧 state）
  for (const x of state.clients || []) ensureClientFields(x, state.primaryNodeId);
  const id = String(req.params.id || '').trim();
  if (!id || id === 'undefined' || id === 'null') {
    return res.status(400).json({
      error: '用户 id 无效。请关闭弹窗，刷新页面后重新点「编辑」；若仍失败请删除后重建',
      code: 'BAD_CLIENT_ID',
    });
  }
  let c = state.clients.find((x) => x.id === id);
  // 兼容：偶发前端用 name 当 id（不应发生，兜底）
  if (!c && req.body?.name) {
    c = state.clients.find((x) => x.name === String(req.body.name).trim());
  }
  if (!c) {
    return res.status(404).json({
      error: '用户不存在（可能已删除或页面数据过期）。请刷新客户端页后重试',
      code: 'CLIENT_NOT_FOUND',
    });
  }
  const body = req.body || {};
  const prevLanding = mieru.clientLandingNodeId(c, state);

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return res.status(400).json({ error: '用户名不能为空' });
    if (!mieru.isValidMieruUsername(name)) {
      return res.status(400).json({
        error: '登录用户名只能用英文/数字/._-。中文名称请写在备注里',
      });
    }
    if (state.clients.some((x) => x.id !== c.id && x.name === name)) {
      return res.status(400).json({ error: '用户名已存在' });
    }
    if (c.name !== name) {
      c.name = name;
      state.clientsNeedRescan = true;
    }
  }
  if (body.password !== undefined && String(body.password).trim()) {
    c.password = String(body.password).trim();
    state.clientsNeedRescan = true;
  }
  if (body.regeneratePassword) {
    c.password = mieru.randomPassword(18);
    state.clientsNeedRescan = true;
  }
  const prevEnabled = c.enabled !== false;
  if (body.enabled !== undefined) c.enabled = Boolean(body.enabled);
  if (body.note !== undefined) c.note = String(body.note);
  try {
    applyRoutePackageBody(c, body);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code || 'BAD_ROUTE' });
  }
  c.updatedAt = new Date().toISOString();

  const nextLanding = mieru.clientLandingNodeId(c, state);
  markDirtyForClient(c);
  if (prevLanding && prevLanding !== nextLanding) {
    nodes.markDirtyForLanding(state, prevLanding);
  }
  if (body.route?.listenPort || body.listenPort) state.clientsNeedRescan = true;

  // 启用/禁用变更：服务端直接排队 apply，不依赖前端是否点「应用本落地」
  let applyJob = null;
  let applyNodeId = null;
  const enabledChanged =
    body.enabled !== undefined && prevEnabled !== (c.enabled !== false);
  if (enabledChanged && state.mode === 'agent') {
    const nid = nextLanding || prevLanding || state.primaryNodeId;
    const node = nid ? nodes.findNode(state, nid) : null;
    if (node) {
      applyNodeId = node.id;
      applyJob = enqueueApply(node, 'mieru_apply');
    }
  }

  persist();
  res.json({
    client: mieru.publicClient(c, state),
    dirty: true,
    clientsNeedRescan: state.clientsNeedRescan,
    applyQueued: Boolean(applyJob),
    applyJob,
    applyNodeId,
    message: enabledChanged
      ? c.enabled === false
        ? applyJob
          ? '已禁用并下发到落地（约 10–30 秒后生效）'
          : '已禁用（未找到落地，请手动点应用本落地）'
        : applyJob
          ? '已启用并下发到落地（约 10–30 秒后生效）'
          : '已启用（未找到落地，请手动点应用本落地）'
      : undefined,
  });
});

app.delete('/api/clients/:id', (req, res) => {
  const enabled = state.clients.filter((c) => c.enabled !== false);
  const target = state.clients.find((x) => x.id === req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (enabled.length <= 1 && target.enabled !== false) {
    return res.status(400).json({ error: '至少保留一个启用用户' });
  }
  const idx = state.clients.findIndex((x) => x.id === req.params.id);
  const [removed] = state.clients.splice(idx, 1);
  markDirtyForClient(removed);
  persist();
  res.json({ ok: true, removed: mieru.publicClient(removed, state), dirty: true });
});

app.get('/api/clients/:id/config', async (req, res) => {
  const c = state.clients.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '用户不存在' });
  const format = String(req.query.format || 'json');
  const proto = req.query.protocol || undefined;
  let dual;
  let shareLink;
  let clientJson;
  try {
    dual = mieru.buildDualShareLinks(state, c, proto);
    shareLink = dual.preferred;
    const preferHost = String(dual.endpoints?.active || dual.endpoints?.mobile || dual.endpoints?.external || '')
      .split(':')[0]
      .trim();
    clientJson = mieru.buildClientJson(state, c, proto, preferHost || undefined);
  } catch (err) {
    return res.status(400).json({ error: err.message, code: err.code });
  }

  if (format === 'link' || format === 'text') {
    return res.type('text/plain').send(shareLink);
  }
  if (format === 'download') {
    res.setHeader('Content-Disposition', `attachment; filename="${c.name || 'mieru'}.json"`);
    return res.json(clientJson);
  }
  if (format === 'yaml' || format === 'clash' || format === 'download-yaml') {
    let yaml;
    try {
      yaml = mieru.buildClashYaml(state, c, proto);
    } catch (err) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    const safe = String(c.name || 'mieru').replace(/[^\w.-]+/g, '_');
    res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}-openclash.yaml"`);
    return res.send(yaml);
  }
  if (format === 'qr') {
    const emptyPng =
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const toQr = async (text) => {
      if (!text) return emptyPng;
      try {
        return await QRCode.toDataURL(text, { margin: 1, width: 280 });
      } catch {
        return emptyPng;
      }
    };
    const [qrMobile, qrExternal, qr] = await Promise.all([
      toQr(dual.mobile),
      toQr(dual.external),
      toQr(shareLink),
    ]);
    const pub = mieru.publicClient(c, state);
    return res.json({
      name: c.name,
      note: c.note || '',
      label: pub.label,
      expireAt: pub.package?.expireAt || '',
      package: pub.package,
      usage: pub.usage,
      statusFlags: pub.statusFlags,
      endpoint: dual.endpoints.active,
      endpoints: dual.endpoints,
      shareLink,
      shareLinks: { mobile: dual.mobile, external: dual.external, preferred: dual.preferred },
      qr,
      qrMobile,
      qrExternal,
      config: JSON.stringify(clientJson, null, 2),
      tip: dual.tip,
      route: pub.route,
      path: '电脑/客户端 → 商家IX前置 → IX → 落地家宽 mita',
    });
  }
  res.json({
    name: c.name,
    note: c.note || '',
    endpoint: dual.endpoints.active,
    endpoints: dual.endpoints,
    shareLink,
    shareLinks: { mobile: dual.mobile, external: dual.external, preferred: dual.preferred },
    client: clientJson,
    tip: dual.tip,
    route: mieru.publicClient(c, state).route,
  });
});

// ---------- Nodes / Landings ----------

app.get('/api/nodes', (req, res) => {
  topology.ensureTopology(state);
  res.json({
    nodes: nodes.ensureNodes(state).map((n) => enrichNodePublic(n)),
    primaryNodeId: state.primaryNodeId,
    landings: state.topology.landings,
    mode: state.mode,
  });
});

app.post('/api/nodes', (req, res) => {
  const body = req.body || {};
  const { node, token } = nodes.createNode(state, {
    name: body.name || `落地-${nodes.ensureNodes(state).length + 1}`,
    note: body.note || '',
    template: body.template || 'cm',
  });
  topology.ensureTopology(state);
  const ixId = body.ixId || state.topology.ixes[0]?.id || null;
  // 同 IX 自动分配空闲端口，避免新落地默认 7901 与旧落地冲突
  const listenPort = body.listenPort
    ? Number(body.listenPort) || topology.allocateListenPort(state, { ixId })
    : topology.allocateListenPort(state, { ixId });
  node.server.listenPort = listenPort;
  node.nameSource = 'panel';
  const landing = topology.defaultLanding({
    id: topology.newId('landing'),
    nodeId: node.id,
    ixId,
    name: node.name,
    listenPort,
    homeReachableHost: body.homeReachableHost || '',
    homeReachablePort: body.homeReachablePort || listenPort,
  });
  state.topology.landings.push(landing);
  if (!state.primaryNodeId) {
    state.primaryNodeId = node.id;
    state.mode = 'agent';
  }
  const base = panelBaseUrl(req);
  const installCmd = nodes.installCommand({
    panelUrl: base,
    token,
    name: node.name,
  });
  persist();
  res.status(201).json({
    ok: true,
    node: enrichNodePublic(node),
    token,
    installCommand: installCmd,
    landing,
  });
});

app.put('/api/nodes/:id', (req, res) => {
  const node = nodes.findNode(state, req.params.id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  const body = req.body || {};
  if (body.name !== undefined) {
    const nm = String(body.name || '').trim();
    if (!nm) return res.status(400).json({ error: '落地显示名称不能为空' });
    if (nm.length > 40) return res.status(400).json({ error: '落地显示名称最多 40 字' });
    node.name = nm;
    node.nameSource = 'panel'; // 锁定：Agent hello 不得再覆盖
  }
  if (body.note !== undefined) node.note = String(body.note || '');
  topology.ensureTopology(state);
  let landing = topology.getLandingByNodeId(state, node.id);
  if (!landing && body.createLanding !== false) {
    const ixId0 = body.ixId || state.topology.ixes[0]?.id || null;
    const port0 =
      body.listenPort !== undefined
        ? Number(body.listenPort) || topology.allocateListenPort(state, { ixId: ixId0 })
        : topology.allocateListenPort(state, { ixId: ixId0 });
    landing = topology.defaultLanding({
      id: topology.newId('landing'),
      nodeId: node.id,
      name: node.name,
      ixId: ixId0,
      listenPort: port0,
    });
    state.topology.landings.push(landing);
    node.server.listenPort = port0;
  }
  // 先处理 IX 绑定，再校验端口（换 IX 时常仍带着旧段端口）
  if (landing && body.ixId !== undefined) {
    const prevIx = landing.ixId || null;
    const nextIx = body.ixId || null;
    landing.ixId = nextIx;
    // 换 IX 且未显式改端口：若当前端口不在新段，自动分配新段空闲端口
    if (prevIx !== nextIx && body.listenPort === undefined) {
      const ix = topology.getIx(state, nextIx);
      const cur = Number(landing.listenPort) || Number(node.server?.listenPort) || 0;
      if (ix && cur && !topology.portInMerchantRange(cur, ix)) {
        const port = topology.allocateListenPort(state, {
          ixId: nextIx,
          excludeLandingId: landing.id,
        });
        landing.listenPort = port;
        landing.homeReachablePort = port;
        node.server.listenPort = port;
        nodes.markNodeDirty(node);
        try {
          enqueueApply(node, 'mieru_apply');
        } catch (e) {
          console.warn('[panel] auto-apply after ix rebind port fix:', e.message);
        }
        // 绑到新 IX 的用户也要对齐 ixId
        for (const c of state.clients || []) {
          if (c?.route?.landingNodeId === node.id) c.route.ixId = nextIx;
        }
        state.clientsNeedRescan = true;
      }
    } else if (prevIx !== nextIx) {
      for (const c of state.clients || []) {
        if (c?.route?.landingNodeId === node.id) c.route.ixId = nextIx;
      }
      state.clientsNeedRescan = true;
    }
  }

  if (body.listenPort !== undefined) {
    let port = Number(body.listenPort);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: '监听端口无效' });
    }
    // 同 IX 端口冲突提示
    const ixId = body.ixId !== undefined ? body.ixId : landing?.ixId;
    const ix = topology.getIx(state, ixId);
    if (ix && !topology.portInMerchantRange(port, ix)) {
      return res.status(400).json({
        error: `端口 ${port} 不在 IX「${ix.name || ix.id}」端口段 ${ix.portMin}-${ix.portMax}`,
      });
    }
    const clash = (state.topology.landings || []).find(
      (L) =>
        L.nodeId !== node.id &&
        Number(L.listenPort) === port &&
        (!ixId || !L.ixId || L.ixId === ixId)
    );
    if (clash) {
      return res.status(400).json({
        error: `端口 ${port} 已被落地「${clash.name}」占用，同 IX 须用不同端口`,
      });
    }
    node.server.listenPort = port;
    if (landing) {
      landing.listenPort = port;
      // 与 mita 监听端口对齐（pro3:7902 时 home 也必须 7902，否则 IX DNAT 打到 7901）
      if (body.homeReachablePort === undefined) {
        landing.homeReachablePort = port;
      } else if (Number(body.homeReachablePort) === 7901 && port !== 7901) {
        landing.homeReachablePort = port;
      }
    }
    nodes.markNodeDirty(node);
    // 端口变更后一律排队 apply（离线挂起，上线执行），避免 mita 仍停旧端口
    try {
      enqueueApply(node, 'mieru_apply');
    } catch (e) {
      console.warn('[panel] auto-apply after port change:', e.message);
    }
  }
  if (landing) {
    if (body.homeReachableHost !== undefined) {
      landing.homeReachableHost = String(body.homeReachableHost || '').trim();
    }
    if (body.homeReachablePort !== undefined) {
      landing.homeReachablePort = topology.clampPort(
        body.homeReachablePort,
        node.server.listenPort || 7901
      );
    }
    if (body.name !== undefined) landing.name = node.name;
  }
  if (body.setPrimary) {
    state.primaryNodeId = node.id;
    state.mode = 'agent';
  }
  persist();
  res.json({ ok: true, node: enrichNodePublic(node), landing });
});

app.delete('/api/nodes/:id', (req, res) => {
  const id = req.params.id;
  const bound = (state.clients || []).filter((c) => mieru.clientLandingNodeId(c, state) === id);
  if (bound.length && !req.query.force) {
    return res.status(400).json({
      error: `仍有 ${bound.length} 个用户绑定此落地，请先改绑或加 ?force=1`,
      boundUsers: bound.map((c) => c.name),
    });
  }
  if (bound.length) {
    for (const c of bound) {
      c.route.landingNodeId = state.primaryNodeId === id ? null : state.primaryNodeId;
      ensureClientFields(c, state.primaryNodeId);
    }
  }
  topology.ensureTopology(state);
  state.topology.landings = state.topology.landings.filter((L) => L.nodeId !== id);
  if (!state.topology.landings.length) {
    state.topology.landings = [
      topology.defaultLanding({ nodeId: state.primaryNodeId === id ? null : state.primaryNodeId }),
    ];
  }
  const removed = nodes.deleteNode(state, id);
  if (!removed) return res.status(404).json({ error: '节点不存在' });
  persist();
  res.json({ ok: true, removed: { id: removed.id, name: removed.name } });
});

app.get('/api/nodes/:id/install-command', (req, res) => {
  const node = nodes.findNode(state, req.params.id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  if (!node.tokenPlain) {
    return res.status(400).json({ error: 'Token 不可见，请轮换 Token', needRotate: true });
  }
  const base = req.query.panelUrl || panelBaseUrl(req);
  res.json({
    installCommand: nodes.installCommand({
      panelUrl: base,
      token: node.tokenPlain,
      name: node.name,
    }),
    node: enrichNodePublic(node),
  });
});

app.post('/api/nodes/:id/update-agent', (req, res) => {
  const node = nodes.findNode(state, req.params.id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  if (!nodes.isNodeOnline(node)) {
    return res.status(400).json({
      error: `「${node.name}」Agent 离线，无法远程更新。请先确认在线，或用「安装命令」在家宽手动执行`,
      code: 'AGENT_OFFLINE',
    });
  }
  const target = agentBundleVersion();
  const job = nodes.enqueueJob(node, 'agent_update', {
    force: true,
    forceNew: true,
    agentTargetVersion: target,
    targetVersion: target,
    // 兼容旧 agent：仍带 panelVersion 字段，但值必须是 Agent 脚本版本
    panelVersion: target,
  });
  persist();
  res.json({
    ok: true,
    pending: true,
    jobId: job.id,
    message: `已下发「更新 Agent」到「${node.name}」（当前 v${node.agentVersion || '?'} → Agent 脚本 v${target}）。约 15–40 秒后点刷新；展开落地可看任务结果`,
    targetVersion: target,
    node: enrichNodePublic(node),
  });
});

app.post('/api/nodes/update-agent-all', (req, res) => {
  const list = nodes.ensureNodes(state);
  const jobs = [];
  const skipped = [];
  for (const node of list) {
    if (!nodes.isNodeOnline(node)) {
      skipped.push({ id: node.id, name: node.name, reason: 'offline' });
      continue;
    }
    const target = agentBundleVersion();
    const job = nodes.enqueueJob(node, 'agent_update', {
      force: true,
      forceNew: true,
      agentTargetVersion: target,
      targetVersion: target,
      panelVersion: target,
    });
    jobs.push({ nodeId: node.id, name: node.name, jobId: job.id, targetVersion: target });
  }
  persist();
  res.json({
    ok: true,
    message: `已向 ${jobs.length} 台在线落地排队更新 Agent v${agentBundleVersion()}` + (skipped.length ? `，${skipped.length} 台离线跳过` : ''),
    jobs,
    skipped,
    targetVersion: agentBundleVersion(),
  });
});

app.post('/api/nodes/:id/token', (req, res) => {
  const node = nodes.findNode(state, req.params.id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  const token = nodes.rotateNodeToken(node);
  const base = panelBaseUrl(req);
  persist();
  res.json({
    ok: true,
    installCommand: nodes.installCommand({
      panelUrl: base,
      token,
      name: node.name,
    }),
  });
});

app.post('/api/nodes/:id/apply', (req, res) => {
  const node = nodes.findNode(state, req.params.id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  mieru.ensureMieruDefaults(state);
  // 写回规范化绑定，避免 landing.id / 空格导致 apply 找不到人
  for (const c of state.clients || []) {
    if (c.route?.landingNodeId) {
      const nrm = mieru.resolveLandingNodeId(state, c.route.landingNodeId, {
        fallbackPrimary: false,
      });
      if (nrm) c.route.landingNodeId = nrm;
    }
  }
  // 含禁用用户：整落地都禁用时仍要 apply，用占位账号覆盖 mita 踢掉真实用户
  const allBound = mieru.clientsForNode(state, node.id);
  const bound = allBound.filter((c) => c.enabled !== false);
  if (!allBound.length) {
    const dist = (state.clients || [])
      .map((c) => {
        const lid = mieru.clientLandingNodeId(c, state);
        const nn = nodes.findNode(state, lid)?.name || lid || '未绑定';
        return `${c.name}→${nn}`;
      })
      .join('；');
    return res.status(400).json({
      ok: false,
      code: 'NO_USERS',
      error: `「${node.name}」还没有绑定用户（nodeId=${node.id.slice(0, 8)}…）。当前绑定：${
        dist || '无用户'
      }。请编辑用户把「绑定落地」选成「${node.name}」后保存，再点应用`,
      nodeId: node.id,
      boundSample: dist,
    });
  }
  const job = enqueueApply(node, 'mieru_apply');
  persist();
  const nEn = bound.length;
  const nDis = allBound.length - nEn;
  const tip =
    nEn === 0
      ? `已下发「${node.name}」：全部用户已禁用，将用占位账号覆盖 mita（真实用户无法认证）`
      : nDis > 0
        ? `已下发应用到「${node.name}」（启用 ${nEn} · 禁用 ${nDis}）`
        : `已下发应用到「${node.name}」（${nEn} 用户）`;
  res.json({
    ok: true,
    pending: true,
    job,
    message: node.lastSeenAt ? tip : '任务已创建，等待 Agent 上线',
    node: enrichNodePublic(node),
  });
});

app.post('/api/nodes/:id/exit', (req, res) => {
  const node = nodes.findNode(state, req.params.id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  mieru.ensureMieruDefaults(state);
  for (const c of state.clients || []) {
    if (c.route?.landingNodeId) {
      const nrm = mieru.resolveLandingNodeId(state, c.route.landingNodeId, {
        fallbackPrimary: false,
      });
      if (nrm) c.route.landingNodeId = nrm;
    }
  }
  const bound = mieru.clientsForNode(state, node.id).filter((c) => c.enabled !== false);
  if (!bound.length) {
    return res.status(400).json({
      ok: false,
      code: 'NO_USERS',
      error: `「${node.name}」没有绑定用户，无法一键落地。先到客户端把用户「绑定落地」选成「${node.name}」并保存`,
    });
  }
  const job = enqueueApply(node, 'exit');
  persist();
  res.json({
    ok: true,
    pending: true,
    job,
    message: node.lastSeenAt
      ? `已下发一键落地到「${node.name}」（${bound.length} 用户）`
      : '任务已创建，等待 Agent 上线',
    node: enrichNodePublic(node),
  });
});

// ---------- Apply / Exit ----------

app.post('/api/apply', async (req, res) => {
  mieru.ensureMieruDefaults(state);
  if (state.mode === 'agent') {
    const nodeId = req.body?.nodeId;
    if (nodeId) {
      const node = nodes.findNode(state, nodeId);
      if (!node) return res.status(404).json({ ok: false, error: '节点不存在' });
      // 含禁用用户即可 apply（全禁用用 panelhold 覆盖 mita）
      const allBound = mieru.clientsForNode(state, node.id);
      const bound = allBound.filter((c) => c.enabled !== false);
      if (!allBound.length) {
        return res.status(400).json({
          ok: false,
          code: 'NO_USERS',
          error: `「${node.name}」还没有绑定用户。请到客户端把用户改绑到本落地，再点「应用本落地」`,
        });
      }
      const job = enqueueApply(node, 'mieru_apply');
      persist();
      return res.json({
        ok: true,
        mode: 'agent',
        pending: true,
        job,
        message:
          bound.length === 0
            ? `已下发「${node.name}」：全部禁用，将覆盖 mita 踢掉真实用户`
            : `已下发应用到「${node.name}」（启用 ${bound.length}）`,
        dirty: true,
      });
    }
    // all dirty or primary
    const all = req.body?.all === true;
    const targets = all
      ? nodes.ensureNodes(state).filter((n) => {
          try {
            n.clients = mieru.clientsForNode(state, n.id);
          } catch {
            /* */
          }
          // 有绑定用户（含全禁用）且 dirty 就下发
          const uc = mieru.clientsForNode(state, n.id).length;
          return uc > 0 && nodes.isNodeDirty(n, hasher());
        })
      : (() => {
          const p = nodes.getPrimaryNode(state);
          return p ? [p] : [];
        })();
    if (!targets.length) {
      if (all) {
        return res.json({
          ok: true,
          mode: 'agent',
          pending: false,
          jobs: [],
          message: '没有需要下发的落地（均已应用或无绑定用户）',
          dirty: isUnifiedDirty(),
        });
      }
      return res.status(400).json({ ok: false, error: '远程模式但没有节点，请先安装 Agent' });
    }
    // 应用全部时跳过真正 0 绑定（全禁用仍下发）
    const jobs = [];
    const skipped = [];
    for (const node of targets) {
      const allBound = mieru.clientsForNode(state, node.id);
      if (!allBound.length) {
        skipped.push(node.name);
        continue;
      }
      jobs.push(enqueueApply(node, 'mieru_apply'));
    }
    if (!jobs.length) {
      return res.json({
        ok: true,
        mode: 'agent',
        pending: false,
        jobs: [],
        message: skipped.length
          ? `跳过无用户落地：${skipped.join('、')}`
          : '没有可下发的落地',
        dirty: isUnifiedDirty(),
      });
    }
    persist();
    return res.json({
      ok: true,
      mode: 'agent',
      pending: true,
      jobs,
      message: all
        ? `已下发应用到 ${jobs.length} 个落地`
        : `已下发「应用 mita 配置」到默认落地`,
      dirty: true,
    });
  }
  return res.status(400).json({
    ok: false,
    error: '本机模式请在本机 root 执行 mita 安装，或切换为远程落地机模式',
    tip: '推荐：落地页 → 远程落地机 → 一键落地',
  });
});

app.post('/api/exit/setup', async (req, res) => {
  mieru.ensureMieruDefaults(state);
  if (state.mode !== 'agent') {
    return res.status(400).json({
      ok: false,
      error: '一键落地请使用远程落地机模式（家宽装 Agent）',
    });
  }
  const nodeId = req.body?.nodeId;
  const node = nodeId ? nodes.findNode(state, nodeId) : nodes.getPrimaryNode(state);
  if (!node) return res.status(400).json({ ok: false, error: '没有落地节点' });
  const job = enqueueApply(node, 'exit');
  persist();
  res.json({
    ok: true,
    mode: 'agent',
    pending: true,
    job,
    message: node.lastSeenAt
      ? `已下发「一键落地」到 ${node.name}`
      : '任务已创建，等待 Agent 上线',
    node: enrichNodePublic(node),
  });
});

app.get('/api/exit/overview', async (req, res) => {
  const primary = nodes.getPrimaryNode(state);
  const report = primary?.lastReport || null;
  topology.ensureTopology(state);
  res.json({
    mode: state.mode,
    protocol: 'mieru',
    online: primary ? nodes.isNodeOnline(primary) : false,
    mita: report?.mita || null,
    exitPublicIp: report?.exitPublicIp || null,
    endpoint: state.server.endpoint,
    listenPort: state.server.listenPort,
    dirty: isUnifiedDirty(),
    topology: topology.publicTopology(state),
    nodes: nodes.ensureNodes(state).map((n) => enrichNodePublic(n)),
    path: '电脑/客户端 → 商家IX前置 → IX → 落地家宽',
  });
});

app.get('/api/diagnose', async (req, res) => {
  try {
    const primary = nodes.getPrimaryNode(state);
    const nodePubs = nodes.ensureNodes(state).map((n) => ({
      id: n.id,
      online: nodes.isNodeOnline(n),
      hostname: n.hostname,
      lastReport: n.lastReport,
    }));
    const dirtyNames = dirtyLandingNames();
    const result = mieru.diagnose(state, {
      mode: state.mode || 'local',
      report: primary?.lastReport || null,
      agentOnline: primary ? nodes.isNodeOnline(primary) : false,
      hostname: primary?.hostname,
      agentVersion: primary?.agentVersion,
      clientsNeedRescan: Boolean(state.clientsNeedRescan),
      dirty: dirtyNames.length > 0,
      dirtyLandings: dirtyNames,
      nodes: nodePubs,
    });
    result.clientsNeedRescan = Boolean(state.clientsNeedRescan);
    result.dirty = dirtyNames.length > 0;
    result.dirtyLandings = dirtyNames;
    result.topology = topology.publicTopology(state);
    result.nodes = nodes.ensureNodes(state).map((n) => enrichNodePublic(n));
    if (primary) {
      const jobs = primary.jobs || [];
      const latest = jobs[0] || null;
      result.latestJob = latest
        ? {
            id: latest.id,
            type: latest.type,
            status: latest.status,
            message: latest.result?.message || '',
            createdAt: latest.createdAt,
            finishedAt: latest.finishedAt,
          }
        : null;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Mode / settings ----------

app.get('/api/mode', (req, res) => {
  res.json(publicModeInfo());
});

app.post('/api/mode', (req, res) => {
  const mode = req.body?.mode === 'agent' ? 'agent' : 'local';
  if (mode === 'local') {
    state.mode = 'local';
    state.primaryNodeId = null;
    persist();
    return res.json({
      ok: true,
      message: '已切换本机出口（需本机自备 mita）',
      ...publicModeInfo(),
      server: publicServer(state.server),
    });
  }
  const { node, token, created } = nodes.ensurePrimaryNode(state, {
    name: req.body?.name || '落地出口',
    template: req.body?.template || 'cm',
  });
  if (!state.server.listenPort) state.server.listenPort = 7901;
  state.server.protocol = state.server.protocol || 'TCP';
  topology.ensureTopology(state);
  if (state.topology.landings[0] && !state.topology.landings[0].nodeId) {
    state.topology.landings[0].nodeId = node.id;
  }
  nodes.syncPrimaryFromState(state);
  const base = panelBaseUrl(req);
  const installCmd = nodes.installCommand({
    panelUrl: base,
    token: token || node.tokenPlain,
    name: node.name,
  });
  persist();
  res.json({
    ok: true,
    message: created ? '已创建远程出口节点' : '已切换远程落地',
    installCommand: installCmd,
    ...publicModeInfo(),
    server: publicServer(state.server),
  });
});

app.put('/api/settings', (req, res) => {
  const body = req.body || {};
  if (!state.settings) state.settings = {};
  if (body.autoApplyEnforce !== undefined) {
    state.settings.autoApplyEnforce = Boolean(body.autoApplyEnforce);
  }
  if (body.showAdvancedNodes !== undefined) {
    state.settings.showAdvancedNodes = Boolean(body.showAdvancedNodes);
  }
  if (body.theme !== undefined) state.settings.theme = body.theme;
  if (body.primaryNodeId) {
    const n = nodes.findNode(state, body.primaryNodeId);
    if (n) {
      state.primaryNodeId = n.id;
      state.mode = 'agent';
    }
  }
  persist();
  res.json({ ok: true, settings: state.settings, ...publicModeInfo() });
});

app.get('/api/primary/install-command', (req, res) => {
  if (state.mode !== 'agent') return res.status(400).json({ error: '当前不是远程出口模式' });
  const node = nodes.getPrimaryNode(state);
  if (!node) return res.status(404).json({ error: '没有主节点' });
  if (!node.tokenPlain) {
    return res.status(400).json({ error: 'Token 不可见，请轮换 Token', needRotate: true });
  }
  const base = req.query.panelUrl || panelBaseUrl(req);
  res.json({
    installCommand: nodes.installCommand({
      panelUrl: base,
      token: node.tokenPlain,
      name: node.name,
    }),
  });
});

app.post('/api/primary/token', (req, res) => {
  const node = nodes.getPrimaryNode(state);
  if (!node) return res.status(404).json({ error: '没有主节点' });
  const token = nodes.rotateNodeToken(node);
  const base = panelBaseUrl(req);
  persist();
  res.json({
    ok: true,
    installCommand: nodes.installCommand({
      panelUrl: base,
      token,
      name: node.name,
    }),
  });
});

app.get('/api/export', (req, res) => {
  res.json({
    version: state.version,
    protocol: state.protocol,
    mode: state.mode,
    server: publicServer(state.server),
    clients: state.clients.map((c) => mieru.publicClient(c, state)),
    topology: topology.publicTopology(state),
    nodes: nodes.ensureNodes(state).map((n) => enrichNodePublic(n)),
    exportedAt: new Date().toISOString(),
  });
});

// ---------- Agent ----------

function agentAuth(req, res) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : req.query.token || '';
  const node = nodes.findNodeByToken(state, token);
  if (!node) {
    res.status(401).json({ error: '无效 Agent Token' });
    return null;
  }
  return node;
}

app.post('/api/agent/hello', (req, res) => {
  const node = agentAuth(req, res);
  if (!node) return;
  const body = req.body || {};
  node.hostname = body.hostname || node.hostname;
  node.agentVersion = body.agentVersion || node.agentVersion;
  node.lastSeenAt = new Date().toISOString();
  // 显示名称只由面板管理（创建/改名）。Agent 的 WG_AGENT_NAME 不得覆盖，
  // 否则用户改名保存后，Agent 重连 hello 会把名字改回安装时的旧值。
  persist();
  res.json({ ok: true, nodeId: node.id, protocol: 'mieru' });
});

app.post('/api/agent/heartbeat', (req, res) => {
  const node = agentAuth(req, res);
  if (!node) return;
  const body = req.body || {};
  nodes.touchNode(node, {
    hostname: body.hostname,
    agentVersion: body.agentVersion,
    meta: body.meta,
    status: body.status,
  });
  // merge usage
  if (body.status?.usage) {
    try {
      mieru.mergeUsageFromReport(state, node.id, body.status.usage);
      runEnforce();
    } catch (e) {
      console.warn('[panel] usage merge failed:', e.message);
    }
  }
  nodes.reclaimStaleJobs(node);
  const pending = nodes.getPendingJobs(node, 3);
  nodes.leaseJobs(node, pending);
  if (state.mode === 'agent' && state.primaryNodeId === node.id) {
    nodes.syncStateFromPrimary(state, node);
  }
  persist();
  res.json({
    ok: true,
    jobs: pending.map((j) => ({ id: j.id, type: j.type, payload: j.payload || {} })),
    protocol: 'mieru',
    panelVersion: panelVersion(),
    // Agent 自更新只认这个（脚本版本），不是面板 UI 版本
    agentTargetVersion: agentBundleVersion(),
    agentBundleVersion: agentBundleVersion(),
    agentOutdated: isAgentOutdated(node.agentVersion),
  });
});

app.get('/api/agent/bundle', (req, res) => {
  const node = agentAuth(req, res);
  if (!node) return;
  if (state.mode === 'agent' && state.primaryNodeId === node.id) {
    nodes.syncPrimaryFromState(state);
  }
  mieru.ensureMieruDefaults(state);
  let bundle;
  try {
    bundle = buildBundleForNode(node);
  } catch (err) {
    return res.status(400).json({ error: err.message, code: err.code });
  }
  // mirror users onto node.clients for dirty hash helpers
  node.clients = mieru.clientsForNode(state, node.id);
  persist();
  res.json(bundle);
});

app.get('/api/agent/download', (req, res) => {
  const node = agentAuth(req, res);
  if (!node) return;
  const agentPath = path.join(ROOT, 'agent', 'index.js');
  if (!fs.existsSync(agentPath)) {
    return res.status(404).json({ error: '面板缺少 agent/index.js' });
  }
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('X-Agent-Version', agentBundleVersion());
  res.sendFile(agentPath);
});

app.post('/api/agent/job-result', (req, res) => {
  const node = agentAuth(req, res);
  if (!node) return;
  const { jobId, ok, message, detail } = req.body || {};
  const cleanMsg = sanitizeAgentMessage(message, ok);
  const job = nodes.completeJob(node, jobId, { ok, message: cleanMsg, detail });
  if (!job) return res.status(404).json({ error: '任务不存在' });

  if (ok && (job.type === 'agent_update' || job.type === 'self_update')) {
    if (detail?.version) node.agentVersion = String(detail.version);
    node.lastAgentUpdateAt = new Date().toISOString();
    node.lastAgentUpdateMessage = cleanMsg || '';
  }

  if (
    ok &&
    (job.type === 'apply' ||
      job.type === 'exit' ||
      job.type === 'mieru_apply' ||
      job.type === 'mieru_install')
  ) {
    // 镜像本落地用户，保证后续 dirty 比对与 bundle 一致
    try {
      node.clients = mieru.clientsForNode(state, node.id);
    } catch {
      /* ignore */
    }
    // 一律用当前 bundle 算法重算 hash（不轻信 agent 回传的旧算法值）
    let hash = null;
    try {
      hash = buildBundleForNode(node).configHash;
    } catch {
      hash = detail?.configHash || null;
    }
    if (hash) nodes.markNodeClean(node, hash);
    if (state.mode === 'agent' && state.primaryNodeId === node.id) {
      if (hash) {
        state.lastAppliedHash = hash;
        state.lastAppliedAt = node.lastAppliedAt;
      }
      nodes.syncStateFromPrimary(state, node);
    }
  }
  persist();
  res.json({ ok: true, job });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`\n  出口管理面板已启动（mieru v4 多落地）`);
  console.log(`  版本: ${require(path.join(ROOT, 'package.json')).version}`);
  console.log(`  地址: http://${HOST === '0.0.0.0' ? '服务器IP' : HOST}:${PORT}`);
  console.log(`  数据: ${DATA_DIR}`);
  if (auth.needsSetup(state)) {
    console.log(`  首次访问请设置登录账号`);
  }
  console.log('');
});
