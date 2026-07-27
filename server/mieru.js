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

function ensureMieruDefaults(state) {
  if (!state.server) state.server = {};
  const s = state.server;
  if (!s.listenPort) s.listenPort = 7901;
  s.protocol = normalizeProtocol(s.protocol || DEFAULT_PROTOCOL);
  if (!s.mtu) s.mtu = DEFAULT_MTU;
  if (!s.multiplexing) s.multiplexing = DEFAULT_MULTIPLEXING;
  if (!s.trafficPattern) s.trafficPattern = 'conservative';
  if (!Array.isArray(state.clients)) state.clients = [];
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
    if (!c.name) c.name = randomUsername();
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

/** mierus:// 分享链（与 OneClick 对齐） */
function buildShareLink(state, client, protocol) {
  ensureMieruDefaults(state);
  const s = state.server;
  const host = endpointHost(state);
  if (!host) {
    const err = new Error('请先填写客户端连接地址（前置入站 IP）');
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
  return `mierus://${urlencode(client.name)}:${urlencode(client.password)}@${host}:${port}?${query}`;
}

/** 官方 mieru 客户端 JSON */
function buildClientJson(state, client, protocol) {
  ensureMieruDefaults(state);
  const s = state.server;
  const host = endpointHost(state);
  if (!host) {
    const err = new Error('请先填写客户端连接地址（前置入站 IP）');
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

  push({
    id: 'protocol',
    level: 'info',
    title: '出口协议',
    detail: `mieru / mita · ${normalizeProtocol(s.protocol)}（老板前置/家宽场景请用 TCP）`,
  });

  if (mode === 'agent') {
    push({
      id: 'agent_online',
      level: agentOnline ? 'ok' : 'error',
      title: 'Agent 在线',
      detail: agentOnline
        ? `在线${opts.hostname ? ' · ' + opts.hostname : ''}${opts.agentVersion ? ' · v' + opts.agentVersion : ''}`
        : '离线：无法在落地机安装/更新 mita',
      fix: agentOnline ? '' : '在落地机执行面板生成的安装命令',
    });
  }

  if (!ep.ok) {
    push({
      id: 'endpoint',
      level: 'error',
      title: '客户端连接地址（前置入站）',
      detail: '未填写。手机无法主动连接',
      fix: '填商家外部连接 IP 或移动入口（不是出网 IP）',
    });
  } else {
    const portMismatch = ep.port != null && Number(s.listenPort) && ep.port !== Number(s.listenPort);
    push({
      id: 'endpoint',
      level: portMismatch ? 'warn' : 'ok',
      title: '客户端连接地址（前置入站）',
      detail: s.endpoint,
      fix: portMismatch ? `端口建议与监听一致：${ep.host}:${s.listenPort}` : '',
    });
  }

  push({
    id: 'listen',
    level: s.listenPort ? 'ok' : 'error',
    title: '监听端口',
    detail: s.listenPort
      ? `${normalizeProtocol(s.protocol)} ${s.listenPort}${normalizeProtocol(s.protocol) === 'BOTH' ? ` / UDP ${Number(s.listenPort) + 1}` : ''}`
      : '未设置',
    fix: s.listenPort ? '确认老板前置把该 TCP 端口转到落地机内网' : '设置端口',
  });

  push({
    id: 'users',
    level: users.length ? 'ok' : 'error',
    title: '客户端用户',
    detail: users.length ? `${users.length} 个启用` : '没有用户',
    fix: users.length ? '' : '在「客户端」添加用户',
  });

  const mita = report?.mita || {};
  const running = Boolean(mita.running) || /RUNNING/i.test(String(mita.status || ''));
  const listening = Boolean(mita.listening);
  push({
    id: 'mita',
    level: running ? 'ok' : mode === 'agent' && !agentOnline ? 'warn' : 'error',
    title: 'mita 服务',
    detail: running
      ? `RUNNING${listening ? ' · 端口在听' : ''}${mita.version ? ' · ' + mita.version : ''}`
      : report
        ? `未运行（${mita.status || 'unknown'}）`
        : '尚无落地机上报',
    fix: running ? '' : '点「一键落地」在落地机安装并启动 mita',
  });

  if (report?.exitPublicIp) {
    const same = ep.ok && ep.host && String(report.exitPublicIp).trim() === String(ep.host).trim();
    push({
      id: 'egress_ip',
      level: same ? 'warn' : 'info',
      title: '当前出网 IP（只读，勿当连接地址）',
      detail: String(report.exitPublicIp),
      fix: same
        ? '前置入口场景：连接地址应是外部/移动入口，不是家宽出网 IP'
        : '手机连上后 ifconfig.me 应接近此 IP',
    });
  }

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
      detail: 'Endpoint/端口/密码改过，手机需更新分享链',
      fix: '到「客户端」重新复制 mierus:// 或扫码导入',
    });
  }

  push({
    id: 'path',
    level: 'info',
    title: '正确路径',
    detail: '手机 mieru → 老板前置(TCP) → 家宽 mita → 出网。不是 WireGuard。',
  });

  const errors = items.filter((i) => i.level === 'error').length;
  const warns = items.filter((i) => i.level === 'warn').length;
  let summary = '配置看起来正常';
  if (errors) summary = `发现 ${errors} 个必须处理的问题`;
  else if (warns) summary = `有 ${warns} 个警告`;
  if (running && users.length && ep.ok) summary = 'mita 与配置就绪；手机请用 mierus 链接连接';

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
  buildClientJson,
  publicClient,
  diagnose,
  portForProtocol,
  protocolsForMode,
  endpointHost,
};
