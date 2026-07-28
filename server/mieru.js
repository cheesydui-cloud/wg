const crypto = require('crypto');

const DEFAULT_MTU = 1400;
const DEFAULT_MULTIPLEXING = 'MULTIPLEXING_LOW';
const DEFAULT_PROTOCOL = 'TCP';

function randomPassword(len = 16) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

function randomUsername() {
  return `u${crypto.randomBytes(3).toString('hex')}`;
}

function normalizeProtocol(p) {
  const v = String(p || DEFAULT_PROTOCOL).toUpperCase();
  if (v === 'UDP' || v === 'BOTH' || v === 'TCP') return v;
  return DEFAULT_PROTOCOL;
}

function protocolsForMode(mode) {
  const m = normalizeProtocol(mode);
  if (m === 'BOTH') return ['TCP', 'UDP'];
  return [m];
}

function portForProtocol(listenPort, protocol, mode) {
  const base = Number(listenPort) || 7901;
  const m = normalizeProtocol(mode);
  if (m === 'BOTH' && String(protocol).toUpperCase() === 'UDP') return base + 1;
  return base;
}

function parseEndpoint(endpoint) {
  const raw = String(endpoint || '').trim();
  if (!raw) return { ok: false, host: '', port: null };
  let host = raw;
  let port = null;
  const m6 = raw.match(/^\[([^\]]+)\]:(\d+)$/);
  if (m6) {
    host = m6[1];
    port = Number(m6[2]);
  } else {
    const idx = raw.lastIndexOf(':');
    if (idx > 0) {
      const maybe = Number(raw.slice(idx + 1));
      if (!Number.isNaN(maybe) && maybe >= 1 && maybe <= 65535) {
        host = raw.slice(0, idx);
        port = maybe;
      }
    }
  }
  return { ok: Boolean(host), host, port };
}

function joinEndpoint(host, port) {
  const h = String(host || '').trim();
  if (!h) return '';
  const p = Number(port) || 0;
  if (!p) return h;
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]:${p}`;
  return `${h}:${p}`;
}

function isValidMieruUsername(name) {
  // mita/mieru 用户名：字母数字下划线短横线，避免中文显示名误当登录名
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(String(name || ''));
}

function ensureMieruDefaults(state) {
  if (!state.server) state.server = {};
  const s = state.server;
  if (!s.listenPort) s.listenPort = 7901;
  s.protocol = normalizeProtocol(s.protocol || DEFAULT_PROTOCOL);
  if (!s.mtu) s.mtu = DEFAULT_MTU;
  if (!s.multiplexing) s.multiplexing = DEFAULT_MULTIPLEXING;
  if (!s.trafficPattern) s.trafficPattern = 'conservative';
  if (!Array.isArray(state.clients)) state.clients = [];
  // 拓扑同步 endpoint（商家入口）
  try {
    const topology = require('./topology');
    topology.ensureTopology(state);
    if (state.server.endpoint) s.endpoint = state.server.endpoint;
  } catch {
    /* topology optional at boot */
  }
  // 至少一个用户
  if (state.clients.length === 0) {
    state.clients.push({
      id: crypto.randomUUID(),
      name: randomUsername(),
      password: randomPassword(18),
      enabled: true,
      note: '默认用户',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  for (const c of state.clients) {
    if (!c.password) c.password = randomPassword(18);
    // 中文/空格等不能当 mita 登录名：挪到 note，换合法 name
    if (!c.name || !isValidMieruUsername(c.name)) {
      const bad = c.name;
      if (bad && !c.note) c.note = String(bad);
      c.name = randomUsername();
    }
    if (c.enabled === undefined) c.enabled = true;
  }
  return state;
}

function enabledUsers(state) {
  return (state.clients || []).filter((c) => c.enabled !== false && c.name && c.password);
}

/** mita 服务端 apply 用 JSON */
function buildServerConfig(state) {
  ensureMieruDefaults(state);
  const s = state.server;
  const mode = normalizeProtocol(s.protocol);
  const portBindings = [];
  for (const proto of protocolsForMode(mode)) {
    portBindings.push({
      port: portForProtocol(s.listenPort, proto, mode),
      protocol: proto,
    });
  }
  const users = enabledUsers(state).map((c) => ({
    name: c.name,
    password: c.password,
  }));
  if (!users.length) {
    const err = new Error('至少需要一个启用的客户端用户');
    err.code = 'NO_USERS';
    throw err;
  }
  return {
    portBindings,
    users,
    loggingLevel: 'INFO',
    mtu: Number(s.mtu) || DEFAULT_MTU,
  };
}

function configHash(state) {
  const content = JSON.stringify(buildServerConfig(state));
  return crypto.createHash('sha256').update(content).digest('hex');
}

function isDirty(state) {
  if (!state.lastAppliedHash) {
    return enabledUsers(state).length > 0;
  }
  try {
    return configHash(state) !== state.lastAppliedHash;
  } catch {
    return true;
  }
}

function markClean(state) {
  state.lastAppliedHash = configHash(state);
  state.lastAppliedAt = new Date().toISOString();
}

function urlencode(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function endpointHost(state) {
  const s = state.server || {};
  const ep = parseEndpoint(s.endpoint);
  if (ep.ok && ep.host) return ep.host;
  return '';
}

function shareLinkForHost(state, client, host, protocol) {
  ensureMieruDefaults(state);
  const s = state.server;
  const h = String(host || '').trim();
  if (!h) {
    const err = new Error('请先填写客户端连接地址（商家入站 IP）');
    err.code = 'NO_ENDPOINT';
    throw err;
  }
  const mode = normalizeProtocol(s.protocol);
  const proto = String(protocol || protocolsForMode(mode)[0]).toUpperCase();
  const port = portForProtocol(s.listenPort, proto, mode);
  const mtu = Number(s.mtu) || DEFAULT_MTU;
  const multiplexing = s.multiplexing || DEFAULT_MULTIPLEXING;
  const query = [
    'handshake-mode=HANDSHAKE_STANDARD',
    `mtu=${mtu}`,
    `multiplexing=${multiplexing}`,
    `port=${port}`,
    'profile=default',
    `protocol=${proto}`,
  ].join('&');
  return `mierus://${urlencode(client.name)}:${urlencode(client.password)}@${h}:${port}?${query}`;
}

/** mierus:// 分享链（默认用当前 active 入站） */
function buildShareLink(state, client, protocol) {
  return shareLinkForHost(state, client, endpointHost(state), protocol);
}

/** 双入口链接：移动 211 / 外部 114 */
function buildDualShareLinks(state, client, protocol) {
  ensureMieruDefaults(state);
  const s = state.server;
  let mobileHost = '211.136.162.184';
  let externalHost = '114.111.176.37';
  let active = 'mobile';
  try {
    const topology = require('./topology');
    topology.ensureTopology(state);
    const t = state.topology;
    mobileHost = t.ingress.mobileHost || mobileHost;
    externalHost = t.ingress.externalHost || externalHost;
    active = t.ingress.active || 'mobile';
  } catch {
    const ep = endpointHost(state);
    if (ep === externalHost) active = 'external';
    else if (ep && ep !== mobileHost) active = 'custom';
  }
  const mode = normalizeProtocol(s.protocol);
  const proto = String(protocol || protocolsForMode(mode)[0]).toUpperCase();
  const port = portForProtocol(s.listenPort, proto, mode);
  const mobile = shareLinkForHost(state, client, mobileHost, proto);
  const external = shareLinkForHost(state, client, externalHost, proto);
  let preferredHost = mobileHost;
  if (active === 'external') preferredHost = externalHost;
  else if (active === 'custom') {
    try {
      const topology = require('./topology');
      preferredHost = topology.activeIngressHost(state) || mobileHost;
    } catch {
      preferredHost = mobileHost;
    }
  }
  const preferred = shareLinkForHost(state, client, preferredHost, proto);
  return {
    mobile,
    external,
    preferred,
    active,
    endpoints: {
      mobile: `${mobileHost}:${port}`,
      external: `${externalHost}:${port}`,
      active: `${preferredHost}:${port}`,
    },
    tip: '电脑/客户端连商家 IX 前置：外部 114 或移动宽带前置 211（不是手机）。',
  };
}

/** 官方 mieru 客户端 JSON */
function buildClientJson(state, client, protocol, hostOverride) {
  ensureMieruDefaults(state);
  const s = state.server;
  const host = String(hostOverride || endpointHost(state) || '').trim();
  if (!host) {
    const err = new Error('请先填写客户端连接地址（商家入站 IP）');
    err.code = 'NO_ENDPOINT';
    throw err;
  }
  const mode = normalizeProtocol(s.protocol);
  const proto = String(protocol || protocolsForMode(mode)[0]).toUpperCase();
  const port = portForProtocol(s.listenPort, proto, mode);
  return {
    profiles: [
      {
        profileName: client.name || 'default',
        user: {
          name: client.name,
          password: client.password,
        },
        servers: [
          {
            ipAddress: host,
            domainName: '',
            portBindings: [{ port, protocol: proto }],
          },
        ],
        mtu: Number(s.mtu) || DEFAULT_MTU,
        multiplexing: { level: s.multiplexing || DEFAULT_MULTIPLEXING },
        handshakeMode: 'HANDSHAKE_STANDARD',
      },
    ],
    activeProfile: client.name || 'default',
    rpcPort: 8964,
    socks5Port: 1080,
    loggingLevel: 'INFO',
    socks5ListenLAN: false,
    httpProxyPort: 8080,
    httpProxyListenLAN: false,
  };
}

function publicClient(c) {
  return {
    id: c.id,
    name: c.name,
    password: c.password,
    enabled: c.enabled !== false,
    note: c.note || '',
    label: c.note || c.name,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function diagnose(state, opts = {}) {
  const items = [];
  const push = (item) => items.push(item);
  const s = state.server || {};
  const mode = opts.mode || state.mode || 'local';
  const agentOnline = Boolean(opts.agentOnline);
  const report = opts.report || null;
  const ep = parseEndpoint(s.endpoint);
  const users = enabledUsers(state);

  // 分层拓扑诊断（商家入口 → IX → 家宽）
  try {
    const topology = require('./topology');
    const topo = topology.diagnoseTopology(state, opts);
    for (const it of topo.items || []) push(it);
  } catch {
    push({
      id: 'protocol',
      level: 'info',
      title: '出口协议',
      detail: `mieru / mita · ${normalizeProtocol(s.protocol)}`,
    });
  }

  push({
    id: 'users',
    level: users.length ? 'ok' : 'error',
    title: '客户端用户',
    detail: users.length
      ? `${users.length} 个启用（登录名须英文/数字，勿用「我的手机」）`
      : '没有用户',
    fix: users.length ? '' : '在「客户端」添加用户',
  });

  const mita = report?.mita || {};
  const running = Boolean(mita.running) || /RUNNING/i.test(String(mita.status || ''));

  if (opts.dirty) {
    push({
      id: 'dirty',
      level: 'warn',
      title: '有未应用的更改',
      detail: '面板已保存，尚未下发到落地机 mita',
      fix: '点「应用配置」或「一键落地」',
    });
  }

  if (opts.clientsNeedRescan) {
    push({
      id: 'need_rescan',
      level: 'warn',
      title: '连接参数已变',
      detail: '入站/端口/密码改过，客户端需更新分享链',
      fix: '到「客户端」重新复制 mierus://（host 应为商家前置 114 或 211）',
    });
  }

  const errors = items.filter((i) => i.level === 'error').length;
  const warns = items.filter((i) => i.level === 'warn').length;
  let summary = '配置看起来正常';
  if (errors) summary = `发现 ${errors} 个必须处理的问题（优先看 IX 转发 + 落地 mita）`;
  else if (warns) summary = `有 ${warns} 个警告`;
  if (running && users.length && ep.ok) {
    summary = '配置就绪；用本机客户端连商家 IX 前置的 mierus 链接';
  }

  return {
    ok: errors === 0,
    summary,
    mode,
    protocol: 'mieru',
    items,
    stats: {
      userCount: users.length,
      listenPort: s.listenPort,
      transport: normalizeProtocol(s.protocol),
      endpoint: s.endpoint || '',
      mitaRunning: running,
      exitPublicIp: report?.exitPublicIp || null,
      agentOnline: mode === 'agent' ? agentOnline : null,
    },
  };
}

module.exports = {
  DEFAULT_MTU,
  DEFAULT_PROTOCOL,
  randomPassword,
  randomUsername,
  isValidMieruUsername,
  normalizeProtocol,
  parseEndpoint,
  joinEndpoint,
  ensureMieruDefaults,
  enabledUsers,
  buildServerConfig,
  configHash,
  isDirty,
  markClean,
  buildShareLink,
  buildDualShareLinks,
  shareLinkForHost,
  buildClientJson,
  publicClient,
  diagnose,
  portForProtocol,
  protocolsForMode,
  endpointHost,
};
