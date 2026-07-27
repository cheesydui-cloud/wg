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
  loadState,
  saveState,
  ensureDataDir,
} = require('./config');
const auth = require('./auth');
const wg = require('./wg-manager');

ensureDataDir();
let state = loadState();

// 兼容旧数据：补默认用户名
if (!state.username) {
  state.username = auth.DEFAULT_USERNAME;
  saveState(state);
}

// 环境变量密码：若未设置面板密码且提供了 WG_PASSWORD，则初始化
if (!state.passwordHash && PASSWORD) {
  auth.setPassword(state, PASSWORD, USERNAME || auth.DEFAULT_USERNAME);
  saveState(state);
  console.log(`[wg-panel] 已初始化登录账号: ${state.username}（来自环境变量）`);
}

function persist() {
  saveState(state);
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

function publicClient(c) {
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
  };
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(auth.authMiddleware(() => state));
app.use(express.static(path.join(ROOT, 'public')));

// ---------- API ----------

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
    tools,
    interface: loggedIn ? iface : undefined,
    clientCount: state.clients.length,
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
  if (!auth.verifyLogin(state, username, String(password || ''))) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = auth.createSession();
  res.cookie('wg_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true, username: state.username || auth.DEFAULT_USERNAME });
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
  const user = newUsername !== undefined
    ? String(newUsername || auth.DEFAULT_USERNAME).trim() || auth.DEFAULT_USERNAME
    : state.username || auth.DEFAULT_USERNAME;
  auth.setPassword(state, String(newPassword), user);
  persist();
  res.json({ ok: true, message: '账号已更新', username: state.username });
});

app.get('/api/server', (req, res) => {
  res.json({ server: publicServer(state.server), wizardDone: state.wizardDone });
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
  res.json({ server: publicServer(state.server), wizardDone: state.wizardDone });
});

app.post('/api/server/nat-template', (req, res) => {
  const iface = state.server.interfaceName || 'wg0';
  state.server.postUp = wg.defaultPostUp(iface);
  state.server.postDown = wg.defaultPostDown(iface);
  persist();
  res.json({
    postUp: state.server.postUp,
    postDown: state.server.postDown,
    tip: '请把 eth0 改成你服务器的出口网卡名（可用 ip route 查看）',
  });
});

app.get('/api/clients', (req, res) => {
  res.json({ clients: state.clients.map(publicClient) });
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

  const kp = wg.generateKeyPair();
  const usePsk = body.usePresharedKey !== false;
  const client = {
    id: crypto.randomUUID(),
    name,
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    presharedKey: usePsk ? wg.generatePresharedKey() : '',
    address,
    allowedIPs: body.allowedIPs || '0.0.0.0/0, ::/0',
    persistentKeepalive: body.persistentKeepalive !== undefined ? Number(body.persistentKeepalive) : 25,
    enabled: body.enabled !== false,
    note: body.note || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.clients.push(client);
  state.wizardDone = true;
  persist();
  res.status(201).json({ client: publicClient(client) });
});

app.put('/api/clients/:id', (req, res) => {
  const c = state.clients.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '客户端不存在' });
  const body = req.body || {};
  if (body.name !== undefined) c.name = String(body.name).trim() || c.name;
  if (body.address !== undefined) c.address = String(body.address).trim();
  if (body.allowedIPs !== undefined) c.allowedIPs = String(body.allowedIPs).trim();
  if (body.persistentKeepalive !== undefined) c.persistentKeepalive = Number(body.persistentKeepalive) || 0;
  if (body.enabled !== undefined) c.enabled = Boolean(body.enabled);
  if (body.note !== undefined) c.note = String(body.note);
  if (body.regenerateKeys) {
    const kp = wg.generateKeyPair();
    c.privateKey = kp.privateKey;
    c.publicKey = kp.publicKey;
  }
  if (body.regeneratePsk) {
    c.presharedKey = wg.generatePresharedKey();
  }
  if (body.removePsk) {
    c.presharedKey = '';
  }
  c.updatedAt = new Date().toISOString();
  persist();
  res.json({ client: publicClient(c) });
});

app.delete('/api/clients/:id', (req, res) => {
  const idx = state.clients.findIndex((x) => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '客户端不存在' });
  const [removed] = state.clients.splice(idx, 1);
  persist();
  res.json({ ok: true, removed: publicClient(removed) });
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
  res.json({ config, path: state.server.confPath });
});

app.post('/api/apply', async (req, res) => {
  wg.ensureServerKeys(state);
  persist();
  const result = await wg.applyConfig(state);
  const iface = await wg.getInterfaceStatus(state.server.interfaceName);
  res.status(result.ok ? 200 : 500).json({ ...result, interface: iface });
});

app.post('/api/interface/stop', async (req, res) => {
  const result = await wg.stopInterface(state.server.interfaceName);
  res.status(result.ok ? 200 : 500).json(result);
});

app.get('/api/interface/status', async (req, res) => {
  const iface = await wg.getInterfaceStatus(state.server.interfaceName);
  const tools = await wg.checkTools();
  res.json({ interface: iface, tools });
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
  state.server = { ...state.server, ...body.server };
  state.clients = body.clients;
  state.wizardDone = body.wizardDone !== false;
  state.passwordHash = passwordHash;
  state.passwordSalt = passwordSalt;
  state.sessionSecret = sessionSecret;
  state.username = username;
  persist();
  res.json({ ok: true, message: `已导入 ${state.clients.length} 个客户端` });
});

app.get('/api/next-ip', (req, res) => {
  try {
    const ip = wg.nextClientAddress(state.server.address, state.clients);
    res.json({ address: ip });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`\n  WireGuard 配置面板已启动`);
  console.log(`  面板地址: http://${HOST === '0.0.0.0' ? '服务器IP' : HOST}:${PORT}`);
  console.log(`  数据目录: ${require('./config').DATA_DIR}`);
  if (auth.needsSetup(state)) {
    console.log(`  首次访问请在网页设置登录密码`);
  }
  console.log('');
});
