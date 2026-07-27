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
const wg = require('./wg-manager');
const nodes = require('./nodes');

ensureDataDir();
auth.setSessionsFile(SESSIONS_FILE);
let state = loadState();
nodes.ensureNodes(state);

if (!state.username) {
  state.username = auth.DEFAULT_USERNAME;
  saveState(state);
}

// 环境变量密码：若未设置面板密码且提供了 WG_PASSWORD，则初始化
if (!state.passwordHash && PASSWORD) {
  auth.setPassword(state, PASSWORD, USERNAME || auth.DEFAULT_USERNAME);
  // 安装脚本会设 WG_FORCE_PASSWORD_CHANGE=1；手动指定密码默认不强制
  state.forcePasswordChange = FORCE_PASSWORD_CHANGE;
  saveState(state);
  console.log(`[wg-panel] 已初始化登录账号: ${state.username}（来自环境变量）`);
}

function persist() {
  // agent 模式：统一 server/clients 同步到主节点
  if (state.mode === 'agent') {
    nodes.syncPrimaryFromState(state);
  }
  saveState(state);
}

function clientIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    ''
  );
}

function healClientIps(list, serverAddress) {
  let healed = 0;
  for (const c of list || []) {
    if (c.enabled === false) continue;
    if (wg.isValidClientAddress(c.address)) continue;
    try {
      c.address = wg.nextClientAddress(
        serverAddress,
        (list || []).filter((x) => x.id !== c.id)
      );
      c.updatedAt = new Date().toISOString();
      healed += 1;
    } catch {
      /* leave for apply to report */
    }
  }
  return healed;
}

function markDirtyUnified() {
  if (state.mode === 'agent') {
    const node = nodes.getPrimaryNode(state);
    if (node) nodes.markNodeDirty(node);
  }
}

function publicModeInfo() {
  const primary = nodes.getPrimaryNode(state);
  return {
    mode: state.mode || 'local',
    primaryNodeId: state.primaryNodeId || null,
    primaryNode: primary ? nodes.publicNode(primary) : null,
    showAdvancedNodes: Boolean(state.settings?.showAdvancedNodes),
  };
}

function publicServer(s) {
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

function publicClient(c, livePeer) {
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
    online: Boolean(livePeer?.online),
    latestHandshake: livePeer?.latestHandshake || '',
    transfer: livePeer?.transfer || '',
    transferRx: livePeer?.transferRx || '',
    transferTx: livePeer?.transferTx || '',
    endpointLive: livePeer?.endpoint || '',
  };
}

function peerMapFromStatus(iface) {
  const map = new Map();
  for (const p of iface?.peers || []) {
    if (p.publicKey) map.set(p.publicKey, p);
  }
  return map;
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(auth.authMiddleware(() => state));
app.use(express.static(path.join(ROOT, 'public')));

// ---------- Public ----------

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: require(path.join(ROOT, 'package.json')).version,
    uptime: process.uptime(),
  });
});

app.get('/api/status', async (req, res) => {
  const tools = await wg.checkTools();
  const token = req.cookies?.wg_session;
  const loggedIn = auth.isAuthed(token);
  let iface = { up: false, peers: [] };
  const modeInfo = publicModeInfo();
  if (loggedIn) {
    if (state.mode === 'agent') {
      const primary = nodes.getPrimaryNode(state);
      const report = primary?.lastReport?.interface;
      if (report) iface = report;
      else if (primary?.lastReport) iface = primary.lastReport.interface || iface;
    } else if (state.server.interfaceName) {
      iface = await wg.getInterfaceStatus(state.server.interfaceName);
    }
  }
  let dirty = false;
  if (loggedIn) {
    if (state.mode === 'agent') {
      const primary = nodes.getPrimaryNode(state);
      dirty = primary ? nodes.isNodeDirty(primary) : false;
    } else {
      dirty = wg.isDirty(state);
    }
  }
  res.json({
    needSetup: auth.needsSetup(state),
    loggedIn,
    wizardDone: Boolean(state.wizardDone),
    defaultUsername: auth.DEFAULT_USERNAME,
    username: loggedIn ? state.username || auth.DEFAULT_USERNAME : undefined,
    forcePasswordChange: loggedIn ? Boolean(state.forcePasswordChange) : false,
    dirty,
    lastAppliedAt: loggedIn ? state.lastAppliedAt : undefined,
    tools,
    interface: loggedIn ? iface : undefined,
    clientCount: state.clients.length,
    version: require(path.join(ROOT, 'package.json')).version,
    mode: modeInfo.mode,
    primaryNodeId: modeInfo.primaryNodeId,
    primaryNode: loggedIn ? modeInfo.primaryNode : undefined,
    showAdvancedNodes: modeInfo.showAdvancedNodes,
    server: loggedIn
      ? {
          interfaceName: state.server.interfaceName,
          endpoint: state.server.endpoint,
          listenPort: state.server.listenPort,
          address: state.server.address,
          publicKey: state.server.publicKey,
        }
      : undefined,
  });
});

app.post('/api/setup', (req, res) => {
  if (!auth.needsSetup(state)) {
    return res.status(400).json({ error: '已完成初始化，请直接登录' });
  }
  const { password, username } = req.body || {};
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }
  const user = String(username || auth.DEFAULT_USERNAME).trim() || auth.DEFAULT_USERNAME;
  auth.setPassword(state, String(password), user);
  state.forcePasswordChange = false;
  wg.ensureServerKeys(state);
  if (!state.server.postUp) {
    state.server.postUp = wg.defaultPostUp(state.server.interfaceName);
    state.server.postDown = wg.defaultPostDown(state.server.interfaceName);
  }
  persist();
  const token = auth.createSession();
  res.cookie('wg_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true, message: '初始化成功', username: state.username });
});

app.post('/api/login', (req, res) => {
  const { password, username } = req.body || {};
  const ip = clientIp(req);
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
        error: `用户名或密码错误，账号已临时锁定 ${Math.ceil(auth.LOCK_MS / 60000)} 分钟`,
        retryAfterSec: after.retryAfterSec,
      });
    }
    return res.status(401).json({
      error: `用户名或密码错误，还可尝试 ${after.remainingAttempts} 次`,
      remainingAttempts: after.remainingAttempts,
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

// ---------- Server ----------

app.get('/api/server', (req, res) => {
  res.json({
    server: publicServer(state.server),
    wizardDone: state.wizardDone,
    dirty: wg.isDirty(state),
    lastAppliedAt: state.lastAppliedAt,
  });
});

app.put('/api/server', (req, res) => {
  const body = req.body || {};
  const s = state.server;
  const fields = [
    'interfaceName',
    'listenPort',
    'address',
    'endpoint',
    'dns',
    'mtu',
    'postUp',
    'postDown',
    'confPath',
  ];
  for (const f of fields) {
    if (body[f] !== undefined) s[f] = body[f];
  }
  if (body.listenPort !== undefined) {
    const fallback = state.mode === 'agent' ? 7901 : 51820;
    s.listenPort = Number(body.listenPort) || fallback;
  }
  if (body.mtu !== undefined) s.mtu = body.mtu === '' || body.mtu === null ? null : Number(body.mtu);

  // 端口变更时，若 endpoint 只有 host 或端口不一致，可自动同步
  if (body.syncEndpointPort && s.endpoint) {
    const host = String(s.endpoint).split(':')[0];
    if (host) s.endpoint = `${host}:${s.listenPort}`;
  }

  if (body.regenerateKeys) {
    const kp = wg.generateKeyPair();
    s.privateKey = kp.privateKey;
    s.publicKey = kp.publicKey;
  } else if (body.privateKey) {
    if (!wg.isValidKey(body.privateKey)) {
      return res.status(400).json({ error: '私钥格式无效（需要 32 字节 base64）' });
    }
    s.privateKey = body.privateKey.trim();
    s.publicKey = wg.derivePublicKey(s.privateKey);
  }

  wg.ensureServerKeys(state);
  if (body.wizardDone !== undefined) state.wizardDone = Boolean(body.wizardDone);
  markDirtyUnified();
  persist();
  res.json({
    server: publicServer(state.server),
    wizardDone: state.wizardDone,
    dirty: state.mode === 'agent'
      ? Boolean(nodes.getPrimaryNode(state) && nodes.isNodeDirty(nodes.getPrimaryNode(state)))
      : wg.isDirty(state),
    mode: state.mode,
  });
});

app.post('/api/server/nat-template', async (req, res) => {
  const iface = state.server.interfaceName || 'wg0';
  const egress = await wg.detectDefaultInterface();
  const egressIface = req.body?.egressIface || egress.iface || 'eth0';
  state.server.postUp = wg.defaultPostUp(iface, egressIface);
  state.server.postDown = wg.defaultPostDown(iface, egressIface);
  persist();
  res.json({
    postUp: state.server.postUp,
    postDown: state.server.postDown,
    egressIface,
    detected: egress,
    tip: `已使用出口网卡 ${egressIface}。如不正确可手动修改。`,
    dirty: wg.isDirty(state),
  });
});

// ---------- 落地 / 网关出口 ----------

app.get('/api/exit/status', async (req, res) => {
  try {
    const status = await wg.getExitStatus(state);
    res.json(status);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * 一键落地（统一）：
 * - local：本机 setupExit + apply
 * - agent：同步到主节点并下发 exit job
 */
app.post('/api/exit/setup', async (req, res) => {
  try {
    const body = req.body || {};
    healClientIps(state.clients, state.server.address);

    // 客户端全局代理
    if (body.fullTunnelClients !== false) {
      for (const c of state.clients || []) {
        c.allowedIPs = '0.0.0.0/0, ::/0';
        if (!c.persistentKeepalive) c.persistentKeepalive = 25;
        c.updatedAt = new Date().toISOString();
      }
    }

    if (state.mode === 'agent') {
      const node = nodes.getPrimaryNode(state);
      if (!node) {
        return res.status(400).json({
          ok: false,
          error: '当前为远程出口模式，但还没有落地节点。请先在向导或出口页安装 Agent',
        });
      }
      nodes.syncPrimaryFromState(state);
      // 预写 NAT 模板到 state（agent 会按目标机网卡重写并回传）
      if (!state.server.postUp || !/MASQUERADE/i.test(state.server.postUp)) {
        const iface = state.server.interfaceName || 'wg0';
        state.server.postUp = wg.defaultPostUp(iface, body.egressIface || 'eth0');
        state.server.postDown = wg.defaultPostDown(iface, body.egressIface || 'eth0');
        node.server.postUp = state.server.postUp;
        node.server.postDown = state.server.postDown;
      }
      nodes.markNodeDirty(node);
      const job = nodes.enqueueJob(node, 'exit', { fullTunnel: true });
      persist();
      return res.json({
        ok: true,
        mode: 'agent',
        job,
        applied: false,
        pending: true,
        message: node.lastSeenAt
          ? '已向落地节点下发「一键落地」，请等待 Agent 执行（约 10 秒）'
          : '任务已创建，但 Agent 尚未上线，请先在落地机安装 Agent',
        server: publicServer(state.server),
        node: nodes.publicNode(node),
        dirty: true,
      });
    }

    const result = await wg.setupExit(state, {
      apply: body.apply !== false,
      fullTunnelClients: false, // 已在上面处理
      egressIface: body.egressIface || undefined,
    });
    persist();
    const iface = await wg.getInterfaceStatus(state.server.interfaceName);
    res.status(result.ok && (result.applied || body.apply === false) ? 200 : 500).json({
      ...result,
      mode: 'local',
      server: publicServer(state.server),
      interface: iface,
      dirty: wg.isDirty(state),
      lastAppliedAt: state.lastAppliedAt,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/server/config', (req, res) => {
  wg.ensureServerKeys(state);
  const config = wg.buildServerConfig(state);
  if (req.query.format === 'download') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${state.server.interfaceName || 'wg0'}.conf"`
    );
    return res.send(config);
  }
  res.json({ config, path: state.server.confPath, dirty: wg.isDirty(state) });
});

// ---------- Clients ----------

app.get('/api/clients', async (req, res) => {
  let iface = { up: false, peers: [] };
  if (state.mode === 'agent') {
    const primary = nodes.getPrimaryNode(state);
    iface = primary?.lastReport?.interface || iface;
    // 合并节点上客户端的 live 字段
    if (primary?.clients) {
      const liveMap = new Map(primary.clients.map((c) => [c.id, c]));
      for (const c of state.clients) {
        const live = liveMap.get(c.id);
        if (live) {
          c._online = live._online;
          c._latestHandshake = live._latestHandshake;
          c._transfer = live._transfer;
        }
      }
    }
  } else {
    iface = await wg.getInterfaceStatus(state.server.interfaceName);
  }
  const map = peerMapFromStatus(iface);
  const dirty =
    state.mode === 'agent'
      ? Boolean(nodes.getPrimaryNode(state) && nodes.isNodeDirty(nodes.getPrimaryNode(state)))
      : wg.isDirty(state);
  res.json({
    clients: state.clients.map((c) => {
      const live = map.get(c.publicKey);
      const pub = publicClient(c, live);
      if (!live && c._online) {
        pub.online = Boolean(c._online);
        pub.latestHandshake = c._latestHandshake || '';
        pub.transfer = c._transfer || '';
      }
      return pub;
    }),
    dirty,
    interfaceUp: Boolean(iface.up),
    mode: state.mode,
  });
});

app.get('/api/clients/export/zip-json', (req, res) => {
  wg.ensureServerKeys(state);
  try {
    const files = state.clients.map((c) => ({
      name: `${wg.sanitizeName(c.name)}.conf`,
      content: wg.buildClientConfig(state, c),
    }));
    res.json({ files, count: files.length });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

app.post('/api/clients', (req, res) => {
  const body = req.body || {};
  const name = (body.name || '').trim() || `客户端-${state.clients.length + 1}`;
  wg.ensureServerKeys(state);

  let address = (body.address || '').trim();
  if (!address) {
    try {
      address = wg.nextClientAddress(state.server.address, state.clients);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  try {
    address = wg.normalizeClientAddress(address);
  } catch (err) {
    return res.status(400).json({ error: `客户端 IP 无效: ${err.message}` });
  }
  if (!address) {
    return res.status(400).json({ error: '客户端内网 IP 不能为空' });
  }

  const kp = wg.generateKeyPair();
  const usePsk = body.usePresharedKey !== false;
  const client = {
    id: crypto.randomUUID(),
    name,
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    presharedKey: usePsk ? wg.generatePresharedKey() : '',
    address,
    allowedIPs: (body.allowedIPs && String(body.allowedIPs).trim()) || '0.0.0.0/0, ::/0',
    persistentKeepalive:
      body.persistentKeepalive !== undefined ? Number(body.persistentKeepalive) : 25,
    enabled: body.enabled !== false,
    note: body.note || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.clients.push(client);
  state.wizardDone = true;
  markDirtyUnified();
  persist();
  res.status(201).json({
    client: publicClient(client),
    dirty: true,
    mode: state.mode,
  });
});

app.put('/api/clients/:id', (req, res) => {
  const c = state.clients.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '客户端不存在' });
  const body = req.body || {};
  if (body.name !== undefined) c.name = String(body.name).trim() || c.name;
  if (body.address !== undefined) {
    let address = String(body.address).trim();
    if (!address) {
      try {
        address = wg.nextClientAddress(
          state.server.address,
          state.clients.filter((x) => x.id !== c.id)
        );
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }
    try {
      address = wg.normalizeClientAddress(address);
    } catch (err) {
      return res.status(400).json({ error: `客户端 IP 无效: ${err.message}` });
    }
    if (!address) return res.status(400).json({ error: '客户端内网 IP 不能为空' });
    c.address = address;
  }
  // 修复历史脏数据：已有客户端若无 IP，保存时自动补齐
  if (!wg.isValidClientAddress(c.address)) {
    try {
      c.address = wg.nextClientAddress(
        state.server.address,
        state.clients.filter((x) => x.id !== c.id)
      );
    } catch (err) {
      return res.status(400).json({ error: `客户端缺少内网 IP：${err.message}` });
    }
  }
  if (body.allowedIPs !== undefined) {
    const a = String(body.allowedIPs).trim();
    c.allowedIPs = a || '0.0.0.0/0, ::/0';
  }
  if (body.persistentKeepalive !== undefined) {
    c.persistentKeepalive = Number(body.persistentKeepalive) || 0;
  }
  if (body.enabled !== undefined) c.enabled = Boolean(body.enabled);
  if (body.note !== undefined) c.note = String(body.note);
  if (body.regenerateKeys) {
    const kp = wg.generateKeyPair();
    c.privateKey = kp.privateKey;
    c.publicKey = kp.publicKey;
  }
  if (body.regeneratePsk) c.presharedKey = wg.generatePresharedKey();
  if (body.removePsk) c.presharedKey = '';
  c.updatedAt = new Date().toISOString();
  markDirtyUnified();
  persist();
  res.json({ client: publicClient(c), dirty: true });
});

app.delete('/api/clients/:id', (req, res) => {
  const idx = state.clients.findIndex((x) => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '客户端不存在' });
  const [removed] = state.clients.splice(idx, 1);
  markDirtyUnified();
  persist();
  res.json({ ok: true, removed: publicClient(removed), dirty: true });
});

app.get('/api/clients/:id/config', async (req, res) => {
  const c = state.clients.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '客户端不存在' });
  if (!state.server.publicKey) wg.ensureServerKeys(state);
  let config;
  try {
    config = wg.buildClientConfig(state, c);
  } catch (err) {
    return res.status(400).json({ error: err.message, code: err.code || 'CONFIG' });
  }
  const format = req.query.format || 'text';
  if (format === 'download') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${wg.sanitizeName(c.name)}.conf"`
    );
    return res.send(config);
  }
  if (format === 'qr') {
    try {
      const dataUrl = await QRCode.toDataURL(config, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 280,
      });
      return res.json({
        config,
        qr: dataUrl,
        name: c.name,
        endpoint: state.server.endpoint,
        mode: state.mode,
        tip:
          state.mode === 'agent'
            ? '请确认手机连的是落地机 Endpoint，不是面板 IP'
            : '扫码后打开隧道，到「诊断」页查看是否握手',
      });
    } catch (err) {
      return res.status(500).json({ error: '二维码生成失败: ' + err.message, config });
    }
  }
  res.json({ config, name: c.name, endpoint: state.server.endpoint });
});

// ---------- System / apply ----------

app.get('/api/preflight', async (req, res) => {
  wg.ensureServerKeys(state);
  const result = await wg.preflight(state);
  res.json(result);
});

app.post('/api/apply', async (req, res) => {
  wg.ensureServerKeys(state);
  const healed = healClientIps(state.clients, state.server.address);
  if (healed) persist();

  // 远程模式：下发到主节点
  if (state.mode === 'agent') {
    const node = nodes.getPrimaryNode(state);
    if (!node) {
      return res.status(400).json({
        ok: false,
        error: '远程出口模式但没有主节点，请先安装 Agent',
      });
    }
    nodes.syncPrimaryFromState(state);
    nodes.markNodeDirty(node);
    const job = nodes.enqueueJob(node, 'apply', {});
    persist();
    return res.json({
      ok: true,
      mode: 'agent',
      pending: true,
      job,
      healedClients: healed,
      message: node.lastSeenAt
        ? '已向落地节点下发「应用配置」，等待 Agent 执行'
        : '任务已创建，但 Agent 尚未上线',
      node: nodes.publicNode(node),
      dirty: true,
    });
  }

  const result = await wg.applyConfig(state);
  if (result.ok) persist();
  const iface = await wg.getInterfaceStatus(state.server.interfaceName);
  res.status(result.ok ? 200 : 500).json({
    ...result,
    mode: 'local',
    healedClients: healed,
    interface: iface,
    dirty: wg.isDirty(state),
    lastAppliedAt: state.lastAppliedAt,
  });
});

app.post('/api/interface/stop', async (req, res) => {
  const result = await wg.stopInterface(state.server.interfaceName);
  res.status(result.ok ? 200 : 500).json(result);
});

app.get('/api/interface/status', async (req, res) => {
  const iface = await wg.getInterfaceStatus(state.server.interfaceName);
  const tools = await wg.checkTools();
  res.json({
    interface: iface,
    tools,
    dirty: wg.isDirty(state),
    lastAppliedAt: state.lastAppliedAt,
  });
});

app.get('/api/system/public-ip', async (req, res) => {
  const result = await wg.detectPublicIp();
  res.status(result.ok ? 200 : 500).json(result);
});

app.get('/api/system/egress', async (req, res) => {
  const result = await wg.detectDefaultInterface();
  res.json(result);
});

app.post('/api/system/fill-endpoint', async (req, res) => {
  const port = state.server.listenPort || 51820;
  let host = (req.body && req.body.host) || '';
  let source = 'manual';
  if (!host) {
    // agent 模式禁止自动用面板出网 IP 当 Endpoint
    if (state.mode === 'agent' && !req.body?.force) {
      return res.status(400).json({
        ok: false,
        error:
          '远程出口模式请手动填写落地机的入站地址（外部连接 IP 或移动入口），不要使用面板出网 IP',
        tip: '例如 114.x.x.x:7901 或 211.x.x.x:7901',
      });
    }
    const ip = await wg.detectPublicIp();
    if (!ip.ok) return res.status(500).json(ip);
    host = ip.ip;
    source = ip.source || 'detect';
  }
  state.server.endpoint = `${host}:${port}`;
  markDirtyUnified();
  persist();
  res.json({
    ok: true,
    endpoint: state.server.endpoint,
    source,
    warning:
      source !== 'manual'
        ? '探测到的是「出网 IP」，入口前置/CM 机器请改成商家给的外部连接或移动入口 IP'
        : undefined,
    server: publicServer(state.server),
    dirty: true,
  });
});

// ---------- 模式 / 诊断 / 统一出口 ----------

app.get('/api/mode', (req, res) => {
  res.json(publicModeInfo());
});

/**
 * 切换出口模式
 * body: { mode: 'local'|'agent', template?: 'cm'|'vps', name?: string, panelUrl?: string }
 */
app.post('/api/mode', (req, res) => {
  const body = req.body || {};
  const mode = body.mode === 'agent' ? 'agent' : 'local';

  if (mode === 'local') {
    state.mode = 'local';
    // 保留 primaryNodeId 以便再切回，但不强制清除节点数据
    persist();
    return res.json({
      ok: true,
      ...publicModeInfo(),
      message: '已切换为本机出口：WireGuard 跑在面板这台机器上',
    });
  }

  const { node, token, created } = nodes.ensurePrimaryNode(state, {
    name: body.name || '落地出口',
    template: body.template || 'cm',
  });
  // CM 模板默认端口
  if (body.template === 'cm' || (!body.template && created)) {
    if (!node.server.listenPort || node.server.listenPort === 51820) {
      node.server.listenPort = 7901;
    }
    if (!state.server.listenPort || state.server.listenPort === 51820) {
      state.server.listenPort = 7901;
    }
  }
  if (body.template === 'vps' && created) {
    node.server.listenPort = 51820;
    state.server.listenPort = 51820;
  }
  // 同步密钥：优先已有 state
  wg.ensureServerKeys(state);
  node.server = { ...node.server, ...state.server };
  node.clients = state.clients;
  const base = body.panelUrl || panelBaseUrl(req);
  const installCmd =
    token || node.tokenPlain
      ? nodes.installCommand({
          panelUrl: base,
          token: token || node.tokenPlain,
          name: node.name,
        })
      : null;
  persist();
  res.json({
    ok: true,
    ...publicModeInfo(),
    created,
    token: token || (created ? node.tokenPlain : undefined),
    installCommand: installCmd,
    panelUrl: base,
    server: publicServer(state.server),
    message: created
      ? '已创建远程出口，请在落地机执行安装命令'
      : '已切换为远程出口模式',
  });
});

app.get('/api/exit/overview', async (req, res) => {
  const modeInfo = publicModeInfo();
  let exitStatus = null;
  let agent = null;
  if (state.mode === 'local') {
    try {
      exitStatus = await wg.getExitStatus(state);
    } catch (err) {
      exitStatus = { ok: false, error: err.message };
    }
  } else {
    const node = nodes.getPrimaryNode(state);
    agent = node ? nodes.publicNode(node) : null;
    const report = node?.lastReport || null;
    exitStatus = {
      ok: true,
      mode: 'agent',
      ready: Boolean(
        agent?.online &&
          state.server?.endpoint &&
          report?.interface?.up &&
          report?.forward &&
          report?.natActive
      ),
      forward: report?.forward ?? null,
      natActive: report?.natActive ?? null,
      interfaceUp: Boolean(report?.interface?.up),
      endpoint: state.server?.endpoint || '',
      egressIface: report?.egressIface || '',
      exitPublicIp: report?.exitPublicIp || null,
      tips: [
        !agent ? '请先安装落地 Agent' : null,
        agent && !agent.online ? 'Agent 离线' : null,
        !state.server?.endpoint ? '请填写 Endpoint' : null,
        report && !report.interface?.up ? '接口未启动，请一键落地/应用' : null,
        report && !report.natActive ? 'NAT 未生效，请一键落地' : null,
      ].filter(Boolean),
    };
  }
  res.json({
    ...modeInfo,
    server: publicServer(state.server),
    clientCount: state.clients.length,
    dirty:
      state.mode === 'agent'
        ? Boolean(modeInfo.primaryNode?.dirty)
        : wg.isDirty(state),
    lastAppliedAt: state.lastAppliedAt,
    exitStatus,
  });
});

app.get('/api/diagnose', async (req, res) => {
  try {
    const primary = nodes.getPrimaryNode(state);
    const result = await wg.diagnose(state, {
      mode: state.mode || 'local',
      report: primary?.lastReport || null,
      agentOnline: primary ? nodes.isNodeOnline(primary) : false,
      hostname: primary?.hostname,
      agentVersion: primary?.agentVersion,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/primary/install-command', (req, res) => {
  if (state.mode !== 'agent') {
    return res.status(400).json({ error: '当前不是远程出口模式' });
  }
  const node = nodes.getPrimaryNode(state);
  if (!node) return res.status(404).json({ error: '没有主节点' });
  if (!node.tokenPlain) {
    return res.status(400).json({
      error: 'Token 不可见，请轮换 Token 后重新安装',
      needRotate: true,
    });
  }
  const base = req.query.panelUrl || panelBaseUrl(req);
  res.json({
    installCommand: nodes.installCommand({
      panelUrl: base,
      token: node.tokenPlain,
      name: node.name,
    }),
    token: node.tokenPlain,
    panelUrl: base,
    node: nodes.publicNode(node, { includeToken: true }),
  });
});

app.post('/api/primary/token', (req, res) => {
  if (state.mode !== 'agent') {
    return res.status(400).json({ error: '当前不是远程出口模式' });
  }
  const node = nodes.getPrimaryNode(state);
  if (!node) return res.status(404).json({ error: '没有主节点' });
  const token = nodes.rotateNodeToken(node);
  const base = req.body?.panelUrl || panelBaseUrl(req);
  persist();
  res.json({
    ok: true,
    token,
    installCommand: nodes.installCommand({ panelUrl: base, token, name: node.name }),
    tip: '旧 Token 已失效，请在落地机重新执行安装命令',
  });
});

app.get('/api/backups', (req, res) => {
  res.json({ backups: wg.listBackups() });
});

app.get('/api/next-ip', (req, res) => {
  try {
    const ip = wg.nextClientAddress(state.server.address, state.clients);
    res.json({ address: ip });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/export', (req, res) => {
  const dump = {
    version: state.version,
    wizardDone: state.wizardDone,
    server: state.server,
    clients: state.clients,
    exportedAt: new Date().toISOString(),
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="wg-panel-backup.json"');
  res.send(JSON.stringify(dump, null, 2));
});

app.post('/api/import', (req, res) => {
  const body = req.body || {};
  if (!body.server || !Array.isArray(body.clients)) {
    return res.status(400).json({ error: '备份文件格式无效' });
  }
  const passwordHash = state.passwordHash;
  const passwordSalt = state.passwordSalt;
  const sessionSecret = state.sessionSecret;
  const username = state.username || auth.DEFAULT_USERNAME;
  const forcePasswordChange = state.forcePasswordChange;
  state.server = { ...state.server, ...body.server };
  state.clients = body.clients;
  state.wizardDone = body.wizardDone !== false;
  state.passwordHash = passwordHash;
  state.passwordSalt = passwordSalt;
  state.sessionSecret = sessionSecret;
  state.username = username;
  state.forcePasswordChange = forcePasswordChange;
  state.lastAppliedHash = null;
  persist();
  res.json({ ok: true, message: `已导入 ${state.clients.length} 个客户端`, dirty: true });
});

// ---------- 节点（中心面板 + 边缘 Agent） ----------

function agentAuth(req, res) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : req.headers['x-agent-token'];
  const node = nodes.findNodeByToken(state, token);
  if (!node) {
    res.status(401).json({ error: '无效的 Agent Token' });
    return null;
  }
  return node;
}

function panelBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`).toString();
  return `${proto}://${host}`;
}

app.get('/install-agent.sh', (req, res) => {
  res.type('text/plain; charset=utf-8');
  res.sendFile(path.join(ROOT, 'install-agent.sh'));
});

app.get('/api/nodes', (req, res) => {
  nodes.ensureNodes(state);
  res.json({
    nodes: state.nodes.map((n) => nodes.publicNode(n)),
    count: state.nodes.length,
  });
});

app.post('/api/nodes', (req, res) => {
  const body = req.body || {};
  const { node, token } = nodes.createNode(state, {
    name: body.name,
    note: body.note,
  });
  persist();
  const base = body.panelUrl || panelBaseUrl(req);
  res.status(201).json({
    node: nodes.publicNode(node, { includeToken: true }),
    token,
    installCommand: nodes.installCommand({ panelUrl: base, token, name: node.name }),
    panelUrl: base,
    tip: '请复制安装命令，在「落地服务器」上以 root 执行。Token 请妥善保管。',
  });
});

app.get('/api/nodes/:id', (req, res) => {
  const node = nodes.findNode(state, req.params.id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  res.json({
    node: nodes.publicNode(node, { includeToken: Boolean(node.tokenPlain) }),
    server: nodes.publicNodeServer(node.server),
    clients: (node.clients || []).map((c) => nodes.publicNodeClient(c)),
    jobs: (node.jobs || []).slice(0, 20),
    tokenAvailable: Boolean(node.tokenPlain),
  });
});

app.put('/api/nodes/:id', (req, res) => {
  const node = nodes.findNode(state, req.params.id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  const body = req.body || {};
  if (body.name !== undefined) node.name = String(body.name).trim() || node.name;
  if (body.note !== undefined) node.note = String(body.note);
  if (body.server && typeof body.server === 'object') {
    const fields = [
      'interfaceName',
      'listenPort',
      'address',
      'endpoint',
      'dns',
      'mtu',
      'postUp',
      'postDown',
      'confPath',
    ];
    for (const f of fields) {
      if (body.server[f] !== undefined) node.server[f] = body.server[f];
    }
    if (body.server.listenPort !== undefined) {
      node.server.listenPort = Number(body.server.listenPort) || 7901;
    }
    if (body.server.mtu !== undefined) {
      node.server.mtu =
        body.server.mtu === '' || body.server.mtu === null ? null : Number(body.server.mtu);
    }
    if (body.server.regenerateKeys) {
      const kp = wg.generateKeyPair();
      node.server.privateKey = kp.privateKey;
      node.server.publicKey = kp.publicKey;
    }
    nodes.markNodeDirty(node);
  }
  persist();
  res.json({ node: nodes.publicNode(node), server: nodes.publicNodeServer(node.server) });
});

app.delete('/api/nodes/:id', (req, res) => {
  const removed = nodes.deleteNode(state, req.params.id);
  if (!removed) return res.status(404).json({ error: '节点不存在' });
  persist();
  res.json({ ok: true, removed: nodes.publicNode(removed) });
});

app.post('/api/nodes/:id/token', (req, res) => {
  const node = nodes.findNode(state, req.params.id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  const token = nodes.rotateNodeToken(node);
  persist();
  const base = req.body?.panelUrl || panelBaseUrl(req);
  res.json({
    ok: true,
    token,
    installCommand: nodes.installCommand({ panelUrl: base, token, name: node.name }),
    tip: '旧 Token 已失效，请在目标机重新安装/更新 agent 环境变量',
  });
});

app.get('/api/nodes/:id/install-command', (req, res) => {
  const node = nodes.findNode(state, req.params.id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  if (!node.tokenPlain) {
    return res.status(400).json({
      error: 'Token 仅在创建或轮换时可见，请点击「轮换 Token」生成新命令',
    });
  }
  const base = req.query.panelUrl || panelBaseUrl(req);
  res.json({
    installCommand: nodes.installCommand({
      panelUrl: base,
      token: node.tokenPlain,
      name: node.name,
    }),
    token: node.tokenPlain,
    panelUrl: base,
  });
});

app.post('/api/nodes/:id/clients', (req, res) => {
  const node = nodes.findNode(state, req.params.id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  const body = req.body || {};
  const name = (body.name || '').trim() || `客户端-${(node.clients || []).length + 1}`;
  let address = (body.address || '').trim();
  if (!address) {
    try {
      address = wg.nextClientAddress(node.server.address, node.clients || []);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  try {
    address = wg.normalizeClientAddress(address);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const kp = wg.generateKeyPair();
  const client = {
    id: crypto.randomUUID(),
    name,
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    presharedKey: body.usePresharedKey === false ? '' : wg.generatePresharedKey(),
    address,
    allowedIPs: (body.allowedIPs && String(body.allowedIPs).trim()) || '0.0.0.0/0, ::/0',
    persistentKeepalive:
      body.persistentKeepalive !== undefined ? Number(body.persistentKeepalive) : 25,
    enabled: true,
    note: body.note || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (!Array.isArray(node.clients)) node.clients = [];
  node.clients.push(client);
  nodes.markNodeDirty(node);
  persist();
  res.status(201).json({ client: nodes.publicNodeClient(client), node: nodes.publicNode(node) });
});

app.get('/api/nodes/:id/clients/:cid/config', async (req, res) => {
  const node = nodes.findNode(state, req.params.id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  const c = (node.clients || []).find((x) => x.id === req.params.cid);
  if (!c) return res.status(404).json({ error: '客户端不存在' });
  const fakeState = { server: node.server, clients: node.clients };
  wg.ensureServerKeys(fakeState);
  const config = wg.buildClientConfig(fakeState, c);
  const format = req.query.format || 'text';
  if (format === 'download') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${wg.sanitizeName(c.name)}.conf"`
    );
    return res.send(config);
  }
  if (format === 'qr') {
    const qr = await QRCode.toDataURL(config, { margin: 1, width: 280 });
    return res.json({ name: c.name, config, qr });
  }
  res.type('text/plain').send(config);
});

app.delete('/api/nodes/:id/clients/:cid', (req, res) => {
  const node = nodes.findNode(state, req.params.id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  const idx = (node.clients || []).findIndex((x) => x.id === req.params.cid);
  if (idx < 0) return res.status(404).json({ error: '客户端不存在' });
  const [removed] = node.clients.splice(idx, 1);
  nodes.markNodeDirty(node);
  persist();
  res.json({ ok: true, removed: nodes.publicNodeClient(removed) });
});

app.post('/api/nodes/:id/apply', (req, res) => {
  const node = nodes.findNode(state, req.params.id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  const job = nodes.enqueueJob(node, 'apply', {});
  persist();
  res.json({
    ok: true,
    job,
    message: node.lastSeenAt
      ? '已下发「应用配置」任务，等待 Agent 拉取执行'
      : '任务已创建，但节点尚未上线，请先在目标机安装 Agent',
    node: nodes.publicNode(node),
  });
});

app.post('/api/nodes/:id/exit', (req, res) => {
  const node = nodes.findNode(state, req.params.id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  // 节点侧落地：把客户端改为全局代理，NAT 由 agent 在目标机写入
  for (const c of node.clients || []) {
    c.allowedIPs = '0.0.0.0/0, ::/0';
    if (!c.persistentKeepalive) c.persistentKeepalive = 25;
    c.updatedAt = new Date().toISOString();
  }
  nodes.markNodeDirty(node);
  const job = nodes.enqueueJob(node, 'exit', {});
  persist();
  res.json({
    ok: true,
    job,
    message: '已下发「一键落地」任务到节点（转发+NAT+应用）',
    node: nodes.publicNode(node),
  });
});

// Agent endpoints
app.post('/api/agent/hello', (req, res) => {
  const node = agentAuth(req, res);
  if (!node) return;
  nodes.touchNode(node, {
    hostname: req.body?.hostname,
    agentVersion: req.body?.agentVersion,
    meta: { nameHint: req.body?.name || '' },
  });
  if (req.body?.name && !node.name) node.name = String(req.body.name);
  persist();
  res.json({ ok: true, nodeId: node.id, name: node.name });
});

app.post('/api/agent/heartbeat', (req, res) => {
  const node = agentAuth(req, res);
  if (!node) return;
  nodes.touchNode(node, {
    hostname: req.body?.hostname,
    agentVersion: req.body?.agentVersion,
    meta: req.body?.meta,
    status: req.body?.status,
  });
  // 主节点：把 live 客户端状态与 postUp 同步回统一 state
  if (state.mode === 'agent' && state.primaryNodeId === node.id) {
    nodes.syncStateFromPrimary(state, node);
  }
  const pending = nodes.getPendingJobs(node, 5);
  nodes.leaseJobs(node, pending);
  // 告诉 agent 当前期望的接口名
  const ifaceName = node.server?.interfaceName || 'wg0';
  persist();
  res.json({
    ok: true,
    nodeId: node.id,
    interfaceName: ifaceName,
    jobs: pending.map((j) => ({ id: j.id, type: j.type, payload: j.payload || {} })),
  });
});

app.get('/api/agent/bundle', (req, res) => {
  const node = agentAuth(req, res);
  if (!node) return;
  // 确保主节点用最新统一配置
  if (state.mode === 'agent' && state.primaryNodeId === node.id) {
    nodes.syncPrimaryFromState(state);
  }
  const bundle = nodes.buildAgentBundle(node, wg);
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

  // exit：回写 NAT 到 node + 统一 state，避免二次 apply 冲掉
  if (ok && job.type === 'exit' && detail) {
    const iface = node.server?.interfaceName || 'wg0';
    const egress = detail.egress || detail.egressIface || 'eth0';
    if (detail.postUp) {
      node.server.postUp = detail.postUp;
      node.server.postDown = detail.postDown || node.server.postDown;
    } else if (!node.server.postUp || !/MASQUERADE/i.test(node.server.postUp)) {
      node.server.postUp = wg.defaultPostUp(iface, egress);
      node.server.postDown = wg.defaultPostDown(iface, egress);
    }
    if (state.mode === 'agent' && state.primaryNodeId === node.id) {
      state.server.postUp = node.server.postUp;
      state.server.postDown = node.server.postDown;
    }
  }

  if (ok && (job.type === 'apply' || job.type === 'exit')) {
    const hash = detail?.configHash || nodes.configHashForNode(node, wg);
    nodes.markNodeClean(node, hash);
    if (state.mode === 'agent' && state.primaryNodeId === node.id) {
      state.lastAppliedHash = hash;
      state.lastAppliedAt = node.lastAppliedAt;
      nodes.syncStateFromPrimary(state, node);
    }
  }
  persist();
  res.json({ ok: true, job });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`\n  WireGuard 配置面板已启动`);
  console.log(`  版本: ${require(path.join(ROOT, 'package.json')).version}`);
  console.log(`  面板地址: http://${HOST === '0.0.0.0' ? '服务器IP' : HOST}:${PORT}`);
  console.log(`  数据目录: ${DATA_DIR}`);
  if (auth.needsSetup(state)) {
    console.log(`  首次访问请在网页设置登录账号（默认用户名 admin）`);
  }
  console.log('');
});
