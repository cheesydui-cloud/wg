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
  saveState(state);
}

function clientIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    ''
  );
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
  if (loggedIn && state.server.interfaceName) {
    iface = await wg.getInterfaceStatus(state.server.interfaceName);
  }
  res.json({
    needSetup: auth.needsSetup(state),
    loggedIn,
    wizardDone: Boolean(state.wizardDone),
    defaultUsername: auth.DEFAULT_USERNAME,
    username: loggedIn ? state.username || auth.DEFAULT_USERNAME : undefined,
    forcePasswordChange: loggedIn ? Boolean(state.forcePasswordChange) : false,
    dirty: loggedIn ? wg.isDirty(state) : false,
    lastAppliedAt: loggedIn ? state.lastAppliedAt : undefined,
    tools,
    interface: loggedIn ? iface : undefined,
    clientCount: state.clients.length,
    version: require(path.join(ROOT, 'package.json')).version,
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
  if (body.listenPort !== undefined) s.listenPort = Number(body.listenPort) || 51820;
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
  persist();
  res.json({
    server: publicServer(state.server),
    wizardDone: state.wizardDone,
    dirty: wg.isDirty(state),
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
 * 一键落地：
 * - 开启 IPv4 转发（运行时 + sysctl.d 持久化）
 * - 自动识别出口网卡并写入 NAT PostUp/PostDown
 * - 默认把客户端 AllowedIPs 设为全局代理
 * - apply=true 时立即写入系统并启动/重载接口
 */
app.post('/api/exit/setup', async (req, res) => {
  try {
    const body = req.body || {};
    // 应用前先修客户端空 IP
    for (const c of state.clients || []) {
      if (c.enabled === false) continue;
      if (wg.isValidClientAddress(c.address)) continue;
      c.address = wg.nextClientAddress(
        state.server.address,
        state.clients.filter((x) => x.id !== c.id)
      );
      c.updatedAt = new Date().toISOString();
    }

    const result = await wg.setupExit(state, {
      apply: body.apply !== false,
      fullTunnelClients: body.fullTunnelClients !== false,
      egressIface: body.egressIface || undefined,
    });
    persist();
    const iface = await wg.getInterfaceStatus(state.server.interfaceName);
    res.status(result.ok && (result.applied || body.apply === false) ? 200 : 500).json({
      ...result,
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
  const iface = await wg.getInterfaceStatus(state.server.interfaceName);
  const map = peerMapFromStatus(iface);
  res.json({
    clients: state.clients.map((c) => publicClient(c, map.get(c.publicKey))),
    dirty: wg.isDirty(state),
    interfaceUp: iface.up,
  });
});

app.get('/api/clients/export/zip-json', (req, res) => {
  wg.ensureServerKeys(state);
  const files = state.clients.map((c) => ({
    name: `${wg.sanitizeName(c.name)}.conf`,
    content: wg.buildClientConfig(state, c),
  }));
  res.json({ files, count: files.length });
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
  persist();
  res.status(201).json({ client: publicClient(client), dirty: wg.isDirty(state) });
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
  persist();
  res.json({ client: publicClient(c), dirty: wg.isDirty(state) });
});

app.delete('/api/clients/:id', (req, res) => {
  const idx = state.clients.findIndex((x) => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '客户端不存在' });
  const [removed] = state.clients.splice(idx, 1);
  persist();
  res.json({ ok: true, removed: publicClient(removed), dirty: wg.isDirty(state) });
});

app.get('/api/clients/:id/config', async (req, res) => {
  const c = state.clients.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '客户端不存在' });
  if (!state.server.publicKey) wg.ensureServerKeys(state);
  const config = wg.buildClientConfig(state, c);
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
      return res.json({ config, qr: dataUrl, name: c.name });
    } catch (err) {
      return res.status(500).json({ error: '二维码生成失败: ' + err.message, config });
    }
  }
  res.json({ config, name: c.name });
});

// ---------- System / apply ----------

app.get('/api/preflight', async (req, res) => {
  wg.ensureServerKeys(state);
  const result = await wg.preflight(state);
  res.json(result);
});

app.post('/api/apply', async (req, res) => {
  wg.ensureServerKeys(state);
  // 应用前自动修复缺少内网 IP 的客户端，避免生成 AllowedIPs= 空行
  let healed = 0;
  for (const c of state.clients || []) {
    if (c.enabled === false) continue;
    if (wg.isValidClientAddress(c.address)) continue;
    try {
      c.address = wg.nextClientAddress(
        state.server.address,
        state.clients.filter((x) => x.id !== c.id)
      );
      c.updatedAt = new Date().toISOString();
      healed += 1;
    } catch (err) {
      return res.status(400).json({
        error: `客户端「${c.name || c.id}」缺少内网 IP：${err.message}`,
        needFixClients: true,
      });
    }
  }
  if (healed) persist();

  const result = await wg.applyConfig(state);
  if (result.ok) persist();
  const iface = await wg.getInterfaceStatus(state.server.interfaceName);
  res.status(result.ok ? 200 : 500).json({
    ...result,
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
  if (!host) {
    const ip = await wg.detectPublicIp();
    if (!ip.ok) return res.status(500).json(ip);
    host = ip.ip;
  }
  state.server.endpoint = `${host}:${port}`;
  persist();
  res.json({
    ok: true,
    endpoint: state.server.endpoint,
    server: publicServer(state.server),
    dirty: wg.isDirty(state),
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
      node.server.listenPort = Number(body.server.listenPort) || 51820;
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
  const pending = nodes.getPendingJobs(node, 5);
  for (const j of pending) {
    if (!j.startedAt) {
      j.startedAt = new Date().toISOString();
      j.status = 'running';
    }
  }
  persist();
  res.json({
    ok: true,
    nodeId: node.id,
    jobs: pending.map((j) => ({ id: j.id, type: j.type, payload: j.payload || {} })),
  });
});

app.get('/api/agent/bundle', (req, res) => {
  const node = agentAuth(req, res);
  if (!node) return;
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
  if (ok && (job.type === 'apply' || job.type === 'exit')) {
    const hash = detail?.configHash || nodes.configHashForNode(node, wg);
    nodes.markNodeClean(node, hash);
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
