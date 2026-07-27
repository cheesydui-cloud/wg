const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
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
} = require('./config');
const auth = require('./auth');
const mieru = require('./mieru');
const nodes = require('./nodes');

ensureDataDir();
auth.setSessionsFile(SESSIONS_FILE);
let state = loadState();
nodes.ensureNodes(state);
mieru.ensureMieruDefaults(state);
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

function markDirtyUnified() {
  if (state.mode === 'agent') {
    const node = nodes.getPrimaryNode(state);
    if (node) nodes.markNodeDirty(node);
  }
}

function isUnifiedDirty() {
  if (state.mode === 'agent') {
    const primary = nodes.getPrimaryNode(state);
    return primary ? nodes.isNodeDirty(primary, { configHash: mieru.configHash }) : mieru.isDirty(state);
  }
  return mieru.isDirty(state);
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

function publicModeInfo() {
  const primary = nodes.getPrimaryNode(state);
  const pub = primary ? nodes.publicNode(primary) : null;
  if (pub && primary) {
    pub.dirty = nodes.isNodeDirty(primary, { configHash: mieru.configHash });
    const jobs = primary.jobs || [];
    const latest = jobs[0] || null;
    pub.latestJob = latest
      ? {
          id: latest.id,
          type: latest.type,
          status: latest.status,
          message: latest.result?.message || '',
          createdAt: latest.createdAt,
          finishedAt: latest.finishedAt,
        }
      : null;
    const report = primary.lastReport || {};
    pub.mita = report.mita || null;
    pub.exitPublicIp = report.exitPublicIp || null;
  }
  return {
    mode: state.mode || 'local',
    protocol: state.protocol || 'mieru',
    primaryNodeId: state.primaryNodeId || null,
    primaryNode: pub,
    showAdvancedNodes: Boolean(state.settings?.showAdvancedNodes),
    clientsNeedRescan: Boolean(state.clientsNeedRescan),
  };
}

function panelBaseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}`.replace(/\/$/, '');
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(auth.authMiddleware(() => state));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: require(path.join(ROOT, 'package.json')).version,
    protocol: 'mieru',
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
  // 注意：/api/status 在 auth 中间件里放行，不会挂 req.user；必须自己读 cookie
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
    protocol: 'mieru',
    mode: modeInfo.mode,
    primaryNodeId: modeInfo.primaryNodeId,
    primaryNode: loggedIn ? modeInfo.primaryNode : undefined,
    clientsNeedRescan: loggedIn ? Boolean(state.clientsNeedRescan) : false,
    server: loggedIn ? publicServer(state.server) : undefined,
    legacyWireGuard: loggedIn ? Boolean(state.legacyWireGuard) : false,
  });
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
  res.json({
    server: publicServer(state.server),
    wizardDone: state.wizardDone,
    dirty: isUnifiedDirty(),
    lastAppliedAt: state.lastAppliedAt,
    clientsNeedRescan: Boolean(state.clientsNeedRescan),
    protocol: 'mieru',
  });
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
  } else if (state.mode === 'agent') {
    const node = nodes.getPrimaryNode(state);
    if (node && node.lastAppliedHash) {
      try {
        if (mieru.configHash(state) === node.lastAppliedHash) node._dirtyFlag = false;
      } catch {
        /* */
      }
    }
  }

  persist();
  const tips = [];
  if (endpointChanged) tips.push('入站地址已更新，请重新复制/扫码客户端链接');
  if (serverConfChanged && isUnifiedDirty()) tips.push('服务端参数有变，请点「应用配置」或「一键落地」');
  res.json({
    server: publicServer(state.server),
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
    clients: state.clients.map((c) => mieru.publicClient(c)),
    dirty: isUnifiedDirty(),
    clientsNeedRescan: Boolean(state.clientsNeedRescan),
    mode: state.mode,
    protocol: 'mieru',
  });
});

app.post('/api/clients', (req, res) => {
  const body = req.body || {};
  let name = (body.name || '').trim();
  const note = (body.note || '').trim();
  // 中文备注不能当 mita 登录名
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
  state.clients.push(client);
  state.wizardDone = true;
  markDirtyUnified();
  persist();
  res.status(201).json({
    client: mieru.publicClient(client),
    dirty: true,
    mode: state.mode,
  });
});

app.put('/api/clients/:id', (req, res) => {
  const c = state.clients.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '用户不存在' });
  const body = req.body || {};
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
  if (body.enabled !== undefined) c.enabled = Boolean(body.enabled);
  if (body.note !== undefined) c.note = String(body.note);
  c.updatedAt = new Date().toISOString();
  markDirtyUnified();
  persist();
  res.json({ client: mieru.publicClient(c), dirty: true, clientsNeedRescan: state.clientsNeedRescan });
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
  markDirtyUnified();
  persist();
  res.json({ ok: true, removed: mieru.publicClient(removed), dirty: true });
});

app.get('/api/clients/:id/config', async (req, res) => {
  const c = state.clients.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '用户不存在' });
  const format = String(req.query.format || 'json');
  const proto = req.query.protocol || undefined;
  let shareLink;
  let clientJson;
  try {
    shareLink = mieru.buildShareLink(state, c, proto);
    clientJson = mieru.buildClientJson(state, c, proto);
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
  if (format === 'qr') {
    const qr = await QRCode.toDataURL(shareLink, { margin: 1, width: 280 });
    return res.json({
      name: c.name,
      endpoint: state.server.endpoint,
      shareLink,
      config: JSON.stringify(clientJson, null, 2),
      qr,
      tip: '使用支持 mieru 的客户端导入链接或 JSON（小火箭/NekoBox/官方 mieru）',
    });
  }
  res.json({
    name: c.name,
    endpoint: state.server.endpoint,
    shareLink,
    client: clientJson,
    tip: '手机导入 mierus:// 或 JSON，不要用 WireGuard',
  });
});

// ---------- Apply / Exit ----------

app.post('/api/apply', async (req, res) => {
  mieru.ensureMieruDefaults(state);
  if (state.mode === 'agent') {
    const node = nodes.getPrimaryNode(state);
    if (!node) {
      return res.status(400).json({ ok: false, error: '远程模式但没有主节点，请先安装 Agent' });
    }
    nodes.syncPrimaryFromState(state);
    nodes.markNodeDirty(node);
    const job = nodes.enqueueJob(node, 'mieru_apply', {});
    persist();
    return res.json({
      ok: true,
      mode: 'agent',
      pending: true,
      job,
      message: node.lastSeenAt
        ? '已下发「应用 mita 配置」到落地机'
        : '任务已创建，但 Agent 尚未上线',
      dirty: true,
    });
  }
  // local：提示需在本机有 mita；面板尽量不直接装（root 环境）
  return res.status(400).json({
    ok: false,
    error: '本机模式请在本机 root 执行 mita 安装，或切换为远程落地机模式',
    tip: '推荐：出口服务器 → 远程落地机 → 一键落地',
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
  const node = nodes.getPrimaryNode(state);
  if (!node) return res.status(400).json({ ok: false, error: '没有主节点' });
  nodes.syncPrimaryFromState(state);
  nodes.markNodeDirty(node);
  const job = nodes.enqueueJob(node, 'exit', {});
  persist();
  res.json({
    ok: true,
    mode: 'agent',
    pending: true,
    job,
    message: node.lastSeenAt
      ? '已下发「一键落地」：安装/配置 mita 并放行端口'
      : '任务已创建，等待 Agent 上线',
    node: nodes.publicNode(node),
  });
});

app.get('/api/exit/overview', async (req, res) => {
  const primary = nodes.getPrimaryNode(state);
  const report = primary?.lastReport || null;
  res.json({
    mode: state.mode,
    protocol: 'mieru',
    online: primary ? nodes.isNodeOnline(primary) : false,
    mita: report?.mita || null,
    exitPublicIp: report?.exitPublicIp || null,
    endpoint: state.server.endpoint,
    listenPort: state.server.listenPort,
    dirty: isUnifiedDirty(),
  });
});

app.get('/api/diagnose', async (req, res) => {
  try {
    const primary = nodes.getPrimaryNode(state);
    const result = mieru.diagnose(state, {
      mode: state.mode || 'local',
      report: primary?.lastReport || null,
      agentOnline: primary ? nodes.isNodeOnline(primary) : false,
      hostname: primary?.hostname,
      agentVersion: primary?.agentVersion,
      clientsNeedRescan: Boolean(state.clientsNeedRescan),
      dirty: isUnifiedDirty(),
    });
    result.clientsNeedRescan = Boolean(state.clientsNeedRescan);
    result.dirty = isUnifiedDirty();
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

// ---------- Mode ----------

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
  // mieru 默认端口
  if (!state.server.listenPort) state.server.listenPort = 7901;
  state.server.protocol = state.server.protocol || 'TCP';
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
    clients: state.clients.map((c) => mieru.publicClient(c)),
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
  if (body.name) node.name = body.name;
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
  nodes.reclaimStaleJobs(node);
  const pending = nodes.getPendingJobs(node, 3);
  nodes.leaseJobs(node, pending);
  // 主节点同步
  if (state.mode === 'agent' && state.primaryNodeId === node.id) {
    nodes.syncStateFromPrimary(state, node);
  }
  persist();
  res.json({
    ok: true,
    jobs: pending.map((j) => ({ id: j.id, type: j.type, payload: j.payload || {} })),
    protocol: 'mieru',
  });
});

app.get('/api/agent/bundle', (req, res) => {
  const node = agentAuth(req, res);
  if (!node) return;
  if (state.mode === 'agent' && state.primaryNodeId === node.id) {
    nodes.syncPrimaryFromState(state);
  }
  mieru.ensureMieruDefaults(state);
  // 用统一 state 构建（用户在 state.clients）
  const fake = {
    server: { ...state.server, ...(node.server || {}) },
    clients: state.clients,
  };
  let serverConfig;
  try {
    serverConfig = mieru.buildServerConfig(fake);
  } catch (err) {
    return res.status(400).json({ error: err.message, code: err.code });
  }
  const hash = mieru.configHash(fake);
  const bundle = {
    protocol: 'mieru',
    server: {
      listenPort: Number(fake.server.listenPort) || 7901,
      protocol: mieru.normalizeProtocol(fake.server.protocol),
      endpoint: fake.server.endpoint || '',
      mtu: fake.server.mtu,
      multiplexing: fake.server.multiplexing,
    },
    users: (fake.clients || []).map((c) => ({
      id: c.id,
      name: c.name,
      password: c.password,
      enabled: c.enabled !== false,
    })),
    serverConfig,
    configHash: hash,
  };
  persist();
  res.json(bundle);
});

app.get('/api/agent/download', (req, res) => {
  const node = agentAuth(req, res);
  if (!node) return;
  res.type('application/javascript; charset=utf-8');
  res.sendFile(path.join(ROOT, 'agent', 'index.js'));
});

app.post('/api/agent/job-result', (req, res) => {
  const node = agentAuth(req, res);
  if (!node) return;
  const { jobId, ok, message, detail } = req.body || {};
  const job = nodes.completeJob(node, jobId, { ok, message, detail });
  if (!job) return res.status(404).json({ error: '任务不存在' });

  if (ok && (job.type === 'apply' || job.type === 'exit' || job.type === 'mieru_apply' || job.type === 'mieru_install')) {
    const hash = detail?.configHash || (() => {
      try {
        return mieru.configHash(state);
      } catch {
        return null;
      }
    })();
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
  console.log(`\n  出口管理面板已启动（mieru）`);
  console.log(`  版本: ${require(path.join(ROOT, 'package.json')).version}`);
  console.log(`  地址: http://${HOST === '0.0.0.0' ? '服务器IP' : HOST}:${PORT}`);
  console.log(`  数据: ${DATA_DIR}`);
  if (auth.needsSetup(state)) {
    console.log(`  首次访问请设置登录账号`);
  }
  console.log('');
});
