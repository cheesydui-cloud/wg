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
  try {
    const topology = require('./topology');
    const { ensureClientFields } = require('./config');
    topology.ensureTopology(state);
    if (state.server.endpoint) s.endpoint = state.server.endpoint;
    for (const c of state.clients) {
      ensureClientFields(c, state.primaryNodeId);
    }
  } catch {
    /* optional at boot */
  }
  if (state.clients.length === 0) {
    const { ensureClientFields } = require('./config');
    const c = {
      id: crypto.randomUUID(),
      name: randomUsername(),
      password: randomPassword(18),
      enabled: true,
      note: '默认用户',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    ensureClientFields(c, state.primaryNodeId);
    state.clients.push(c);
  }
  for (const c of state.clients) {
    if (!c.password) c.password = randomPassword(18);
    if (!c.name || !isValidMieruUsername(c.name)) {
      const bad = c.name;
      if (bad && !c.note) c.note = String(bad);
      c.name = randomUsername();
    }
    if (c.enabled === undefined) c.enabled = true;
  }
  return state;
}

/**
 * 把各种「落地引用」规范成 nodes[].id
 * 兼容：nodeId / topology.landings[].id / 唯一名称；trim；拒绝空串
 * 注意：旧数据 landings 可能共用 id=landing-default，此时不能只按 id 取第一台
 */
function resolveLandingNodeId(state, raw, { fallbackPrimary = false } = {}) {
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return fallbackPrimary ? state?.primaryNodeId || null : null;

  const nodeList = Array.isArray(state?.nodes) ? state.nodes : [];
  if (nodeList.some((n) => n && String(n.id) === s)) return s;

  let landings = [];
  try {
    const topology = require('./topology');
    if (state) topology.ensureTopology(state);
    landings = state?.topology?.landings || [];
  } catch {
    landings = state?.topology?.landings || [];
  }

  // 已是某落地的 nodeId
  if (landings.some((L) => L && String(L.nodeId) === s)) return s;

  const byLandingId = landings.filter((L) => L && String(L.id) === s && L.nodeId);
  if (byLandingId.length === 1) return String(byLandingId[0].nodeId);
  // 重复 landing.id：无法仅凭 id 判定，留给 clientsForNode 按 nodeId 反查

  const byLName = landings.filter((L) => L && String(L.name || '') === s && L.nodeId);
  if (byLName.length === 1) return String(byLName[0].nodeId);

  const byNName = nodeList.filter((n) => n && String(n.name || '') === s);
  if (byNName.length === 1 && byNName[0].id) return byNName[0].id;

  // 不盲目返回歧义 id
  if (byLandingId.length > 1) return null;
  return s;
}

function clientLandingNodeId(client, state, opts = {}) {
  const raw = client?.route?.landingNodeId;
  const resolved = resolveLandingNodeId(state, raw, { fallbackPrimary: false });
  if (resolved) return resolved;
  if (opts.fallbackPrimary === false) return null;
  return state?.primaryNodeId || null;
}

function clientListenPort(client, state, node) {
  if (client?.route?.listenPort) return Number(client.route.listenPort);
  try {
    const topology = require('./topology');
    const landing = topology.getLandingByNodeId(state, clientLandingNodeId(client, state));
    if (landing?.listenPort) return Number(landing.listenPort);
  } catch {
    /* */
  }
  if (node?.server?.listenPort) return Number(node.server.listenPort);
  return Number(state?.server?.listenPort) || 7901;
}

/** 判断客户端是否应归属某落地 nodeId（与 UI 分组/apply 同一规则） */
function clientBelongsToNode(state, client, nodeId) {
  const want = String(
    resolveLandingNodeId(state, nodeId, { fallbackPrimary: false }) || nodeId || ''
  );
  if (!want) return false;
  const primary = state?.primaryNodeId ? String(state.primaryNodeId) : '';
  const raw = client?.route?.landingNodeId;
  const rawS = raw == null ? '' : String(raw).trim();
  if (!rawS) return Boolean(primary) && want === primary;

  if (rawS === want) return true;

  const resolved = resolveLandingNodeId(state, rawS, { fallbackPrimary: false });
  if (resolved && String(resolved) === want) return true;

  const landings = state?.topology?.landings || [];
  // 绑定的是 landing 拓扑 id/名，且该记录的 nodeId 就是目标落地
  if (
    landings.some(
      (L) =>
        L &&
        String(L.nodeId || '') === want &&
        (String(L.id) === rawS || String(L.name || '') === rawS)
    )
  ) {
    return true;
  }
  return false;
}

function clientsForNode(state, nodeId) {
  ensureMieruDefaults(state);
  return (state.clients || []).filter((c) => clientBelongsToNode(state, c, nodeId));
}

function enabledUsers(state, nodeId = null) {
  const list = nodeId ? clientsForNode(state, nodeId) : state.clients || [];
  return list.filter((c) => c.enabled !== false && c.name && c.password);
}

/** mita 服务端 apply 用 JSON；可按 nodeId 过滤用户与端口 */
function buildServerConfig(state, opts = {}) {
  ensureMieruDefaults(state);
  const nodeId = opts.nodeId || null;
  const s = { ...state.server, ...(opts.server || {}) };
  if (opts.listenPort) s.listenPort = opts.listenPort;
  const mode = normalizeProtocol(s.protocol);
  const portBindings = [];
  for (const proto of protocolsForMode(mode)) {
    portBindings.push({
      port: portForProtocol(s.listenPort, proto, mode),
      protocol: proto,
    });
  }
  const users = enabledUsers(state, nodeId).map((c) => ({
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

function configHash(state, opts = {}) {
  const content = JSON.stringify(buildServerConfig(state, opts));
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

function resolveClientIxOpts(state, client = null) {
  const opts = {};
  if (client?.route?.ixId) opts.ixId = client.route.ixId;
  if (client?.route?.landingNodeId) opts.landingNodeId = client.route.landingNodeId;
  if (client?.route?.ingressActive) opts.ingressActive = client.route.ingressActive;
  // landing.ixId fallback via topology.resolveIx
  return opts;
}

function endpointHost(state, client = null) {
  try {
    const topology = require('./topology');
    topology.ensureTopology(state);
    const opts = resolveClientIxOpts(state, client);
    const h = topology.activeIngressHost(state, opts.ingressActive, opts);
    if (h) return h;
  } catch {
    /* */
  }
  const s = state.server || {};
  const ep = parseEndpoint(s.endpoint);
  if (ep.ok && ep.host) return ep.host;
  return '';
}

function looksLikeIp(host) {
  const h = String(host || '').trim();
  if (!h) return false;
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  // IPv6 (bare or already unbracketed)
  if (h.includes(':') && /^[0-9a-fA-F:]+$/.test(h)) return true;
  return false;
}

function looksLikeDomain(host) {
  const h = String(host || '').trim();
  if (!h || looksLikeIp(h)) return false;
  // hostname / FQDN (allow subdomain, hyphen); reject spaces
  if (/\s/.test(h)) return false;
  return /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(h) || h.includes('.');
}

/**
 * 分享链 / 客户端里显示的节点名：备注优先，并带到期日
 * 小火箭等：写入 mierus 的 profile= 作为节点「备注」；#fragment 作兼容备用
 */
function shareDisplayName(client) {
  const note = String(client?.note || '').trim();
  const name = String(client?.name || '').trim();
  const expRaw = client?.package?.expireAt ? String(client.package.expireAt).trim() : '';
  const exp = expRaw ? expRaw.slice(0, 10) : '';
  const base = note || name || 'mieru';
  if (exp) return `${base} · 到期${exp}`;
  return base;
}

function shareLinkForHost(state, client, host, protocol, portOverride) {
  ensureMieruDefaults(state);
  const s = state.server;
  const h = String(host || '').trim();
  if (!h) {
    const err = new Error('请先填写客户端连接地址（商家前置 IP 或域名）');
    err.code = 'NO_ENDPOINT';
    throw err;
  }
  const mode = normalizeProtocol(s.protocol);
  const proto = String(protocol || protocolsForMode(mode)[0]).toUpperCase();
  const listenPort = portOverride || clientListenPort(client, state);
  const port = portForProtocol(listenPort, proto, mode);
  const mtu = Number(s.mtu) || DEFAULT_MTU;
  const multiplexing = s.multiplexing || DEFAULT_MULTIPLEXING;
  // 小火箭「备注」读的是 query 的 profile=（不是 #fragment）。
  // 写入「面板备注 · 到期日期」，扫码后编辑节点里的备注即为此文案。
  const remark = shareDisplayName(client);
  const query = [
    'handshake-mode=HANDSHAKE_STANDARD',
    `mtu=${mtu}`,
    `multiplexing=${multiplexing}`,
    `port=${port}`,
    `profile=${urlencode(remark)}`,
    `protocol=${proto}`,
  ].join('&');
  // #fragment 作兼容备用（部分客户端用 hash 当节点名）
  return `mierus://${urlencode(client.name)}:${urlencode(client.password)}@${h}:${port}?${query}#${urlencode(remark)}`;
}

function buildShareLink(state, client, protocol) {
  return shareLinkForHost(state, client, endpointHost(state, client), protocol);
}

function buildDualShareLinks(state, client, protocol) {
  ensureMieruDefaults(state);
  const s = state.server;
  let mobileHost = '211.136.162.184';
  let externalHost = '114.111.176.37';
  let customHost = '';
  let active = client?.route?.ingressActive || 'external';
  let ixId = client?.route?.ixId || null;
  try {
    const topology = require('./topology');
    topology.ensureTopology(state);
    const opts = resolveClientIxOpts(state, client);
    const ing = topology.resolveIngress(state, opts);
    const ix = topology.resolveIx(state, opts);
    mobileHost = ing.mobileHost || mobileHost;
    externalHost = ing.externalHost || externalHost;
    customHost = ing.customHost || '';
    if (!client?.route?.ingressActive) active = ing.active || 'external';
    ixId = ix?.id || ixId;
  } catch {
    const ep = endpointHost(state, client);
    if (ep === externalHost) active = 'external';
    else if (ep && ep !== mobileHost) active = 'custom';
  }
  const mode = normalizeProtocol(s.protocol);
  const proto = String(protocol || protocolsForMode(mode)[0]).toUpperCase();
  const listenPort = clientListenPort(client, state);
  const port = portForProtocol(listenPort, proto, mode);
  const mobile = shareLinkForHost(state, client, mobileHost, proto, listenPort);
  const external = shareLinkForHost(state, client, externalHost, proto, listenPort);
  let preferredHost = mobileHost;
  if (active === 'external') preferredHost = externalHost;
  else if (active === 'custom') preferredHost = customHost || mobileHost;
  const preferred = shareLinkForHost(state, client, preferredHost, proto, listenPort);
  return {
    mobile,
    external,
    preferred,
    active,
    listenPort: port,
    landingNodeId: clientLandingNodeId(client, state),
    ixId,
    endpoints: {
      mobile: `${mobileHost}:${port}`,
      external: `${externalHost}:${port}`,
      active: `${preferredHost}:${port}`,
    },
    tip: '电脑/客户端连该线路所属 IX 的商家前置（外部/移动宽带），不是手机、不是家宽公网。',
  };
}

function buildClientJson(state, client, protocol, hostOverride) {
  ensureMieruDefaults(state);
  const s = state.server;
  const host = String(hostOverride || endpointHost(state, client) || '').trim();
  if (!host) {
    const err = new Error('请先填写客户端连接地址（商家前置 IP 或域名）');
    err.code = 'NO_ENDPOINT';
    throw err;
  }
  const mode = normalizeProtocol(s.protocol);
  const proto = String(protocol || protocolsForMode(mode)[0]).toUpperCase();
  const listenPort = clientListenPort(client, state);
  const port = portForProtocol(listenPort, proto, mode);
  // mieru client: IP → ipAddress; 域名 → domainName（支持自定义域名前置）
  const useDomain = looksLikeDomain(host) && !looksLikeIp(host);
  return {
    profiles: [
      {
        profileName: shareDisplayName(client),
        user: {
          name: client.name,
          password: client.password,
        },
        servers: [
          {
            ipAddress: useDomain ? '' : host,
            domainName: useDomain ? host : '',
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

function formatRate(bytesPerSec) {
  const n = Number(bytesPerSec) || 0;
  if (n <= 0) return '—';
  // 展示为 bit/s 更符合「网速」习惯；小流量用 KB/s 亦可，这里统一 Mbps/Kbps
  const bits = n * 8;
  if (bits >= 1e6) return (bits / 1e6).toFixed(bits >= 1e7 ? 1 : 2) + ' Mbps';
  if (bits >= 1e3) return (bits / 1e3).toFixed(0) + ' Kbps';
  return bits.toFixed(0) + ' bps';
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function publicClient(c, state = null) {
  const pkg = c.package || {};
  const usage = c.usage || {};
  const route = c.route || {};
  const expired = Boolean(pkg.expireAt && new Date(pkg.expireAt).getTime() < Date.now());
  const quotaMb = Number(pkg.quotaMb) || 0;
  const totalBytes = Number(usage.totalBytes) || 0;
  const overQuota = quotaMb > 0 && totalBytes >= quotaMb * 1024 * 1024;
  return {
    id: c.id,
    name: c.name,
    password: c.password,
    enabled: c.enabled !== false,
    note: c.note || '',
    label: c.note || c.name,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    route: {
      // 与 apply/clientsForNode 同一套解析，避免「列表在 pro3 下、应用却说没用户」
      landingNodeId: clientLandingNodeId(c, state),
      landingNodeIdRaw: route.landingNodeId || null,
      ixId: route.ixId || null,
      listenPort: route.listenPort || null,
      ingressActive: route.ingressActive || null,
    },
    package: {
      quotaMb: quotaMb,
      quotaDays: Number(pkg.quotaDays) || 30,
      quotaMode: pkg.quotaMode || 'rolling',
      expireAt: pkg.expireAt || '',
      bandwidthMbps: Number(pkg.bandwidthMbps) || 0,
    },
    usage: {
      downloadBytes: Number(usage.downloadBytes) || 0,
      uploadBytes: Number(usage.uploadBytes) || 0,
      totalBytes,
      totalHuman: formatBytes(totalBytes),
      downloadHuman: formatBytes(Number(usage.downloadBytes) || 0),
      uploadHuman: formatBytes(Number(usage.uploadBytes) || 0),
      day1DownloadBytes: Number(usage.day1DownloadBytes) || 0,
      day1UploadBytes: Number(usage.day1UploadBytes) || 0,
      day30DownloadBytes: Number(usage.day30DownloadBytes) || 0,
      day30UploadBytes: Number(usage.day30UploadBytes) || 0,
      lastActive: usage.lastActive || null,
      quotaUsedMb: usage.quotaUsedMb,
      quotaLimitMb: usage.quotaLimitMb,
      collectedAt: usage.collectedAt || null,
      source: usage.source || null,
      downBps: Number(usage.downBps) || 0,
      upBps: Number(usage.upBps) || 0,
      downRateHuman: formatRate(Number(usage.downBps) || 0),
      upRateHuman: formatRate(Number(usage.upBps) || 0),
      rateAt: usage.rateAt || usage.collectedAt || null,
    },
    statusFlags: {
      expired,
      overQuota,
      blocked: c.enabled === false || expired || overQuota,
    },
  };
}

/**
 * 检查到期/超额，返回变更的 client ids 与受影响 nodeIds
 */
function enforcePackages(state) {
  ensureMieruDefaults(state);
  const now = Date.now();
  const changed = [];
  const nodeIds = new Set();
  for (const c of state.clients || []) {
    const pkg = c.package || {};
    let disable = false;
    let reason = '';
    if (pkg.expireAt) {
      const t = new Date(pkg.expireAt).getTime();
      if (!Number.isNaN(t) && t < now) {
        disable = true;
        reason = 'expired';
      }
    }
    const quotaMb = Number(pkg.quotaMb) || 0;
    if (quotaMb > 0) {
      const total = Number(c.usage?.totalBytes) || 0;
      if (total >= quotaMb * 1024 * 1024) {
        disable = true;
        reason = reason || 'quota';
      }
    }
    if (disable && c.enabled !== false) {
      c.enabled = false;
      c.updatedAt = new Date().toISOString();
      c._enforceReason = reason;
      changed.push(c.id);
      const nid = clientLandingNodeId(c, state);
      if (nid) nodeIds.add(nid);
    }
  }
  return { changed, nodeIds: [...nodeIds] };
}

/**
 * 从 agent status.usage 合并到 clients
 */
function mergeUsageFromReport(state, nodeId, usage) {
  if (!usage || !Array.isArray(usage.users)) return 0;
  const byName = new Map();
  for (const u of usage.users) {
    if (u?.name) byName.set(String(u.name), u);
  }
  const quotaByName = new Map();
  if (Array.isArray(usage.quotas)) {
    for (const q of usage.quotas) {
      if (q?.name) quotaByName.set(String(q.name), q);
    }
  }
  let n = 0;
  const bound = clientsForNode(state, nodeId);
  for (const c of bound) {
    const u = byName.get(c.name);
    if (!u) continue;
    const download = Number(u.downloadBytes) || Number(u.download) || 0;
    const upload = Number(u.uploadBytes) || Number(u.upload) || 0;
    let total = Number(u.totalBytes) || Number(u.total) || download + upload;
    // human strings like "1.2 GB" / "938.1MiB"
    if ((!total || (!download && !upload)) && u.raw) {
      const sizes = [...String(u.raw).matchAll(/([\d.]+)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB|B)/gi)].map((m) => {
        const num = parseFloat(m[1]);
        const unit = m[2].toUpperCase();
        const mul =
          unit === 'GIB' || unit === 'GB' ? 1024 ** 3 :
          unit === 'MIB' || unit === 'MB' ? 1024 ** 2 :
          unit === 'KIB' || unit === 'KB' ? 1024 :
          unit === 'TIB' || unit === 'TB' ? 1024 ** 4 : 1;
        return Math.round(num * mul);
      });
      if (sizes.length >= 2 && !download && !upload) {
        // 优先末两列（常为 30DaysDown/Up）
        const d = sizes[sizes.length - 2];
        const up = sizes[sizes.length - 1];
        if (!total) total = d + up;
      } else if (sizes.length && !total) {
        total = sizes[sizes.length - 1];
      }
    }
    const prev = c.usage || {};
    const collectedAt = usage.collectedAt || new Date().toISOString();
    const prevAt = prev.collectedAt ? new Date(prev.collectedAt).getTime() : 0;
    const nowAt = new Date(collectedAt).getTime();
    const dtSec = prevAt && nowAt > prevAt ? (nowAt - prevAt) / 1000 : 0;
    // 相邻两次用量差估算瞬时速率（mita 无实时速率接口；间隔过短/回绕则清零）
    let downBps = 0;
    let upBps = 0;
    if (dtSec >= 5 && dtSec <= 3600) {
      const dDown = download - (Number(prev.downloadBytes) || 0);
      const dUp = upload - (Number(prev.uploadBytes) || 0);
      if (dDown >= 0) downBps = dDown / dtSec;
      if (dUp >= 0) upBps = dUp / dtSec;
      // 异常跳变（计数器重置/换月）忽略
      if (downBps > 200 * 1024 * 1024) downBps = 0;
      if (upBps > 200 * 1024 * 1024) upBps = 0;
    } else if (prev.downBps != null || prev.upBps != null) {
      // 本轮无法估算时保留上一档显示一小会儿
      downBps = Number(prev.downBps) || 0;
      upBps = Number(prev.upBps) || 0;
      if (dtSec > 3600) {
        downBps = 0;
        upBps = 0;
      }
    }
    c.usage = {
      ...prev,
      downloadBytes: download,
      uploadBytes: upload,
      totalBytes: total || download + upload,
      day1DownloadBytes: Number(u.day1DownloadBytes) || 0,
      day1UploadBytes: Number(u.day1UploadBytes) || 0,
      day7DownloadBytes: Number(u.day7DownloadBytes) || 0,
      day7UploadBytes: Number(u.day7UploadBytes) || 0,
      day30DownloadBytes: Number(u.day30DownloadBytes) || download,
      day30UploadBytes: Number(u.day30UploadBytes) || upload,
      lastActive: u.lastActive || null,
      collectedAt,
      source: usage.source || 'mita-cli',
      downBps,
      upBps,
      rateAt: collectedAt,
    };
    const q = quotaByName.get(c.name);
    if (q) {
      c.usage.quotaUsedMb = q.usedMB != null ? Number(q.usedMB) : c.usage.quotaUsedMb;
      c.usage.quotaLimitMb = q.limitMB != null ? Number(q.limitMB) : c.usage.quotaLimitMb;
    }
    n += 1;
  }
  return n;
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
      ? `${users.length} 个启用（登录名须英文/数字）`
      : '没有用户',
    fix: users.length ? '' : '在「客户端」添加用户',
  });

  // package / route issues
  for (const c of state.clients || []) {
    if (!clientLandingNodeId(c, state) && mode === 'agent') {
      push({
        id: `route_${c.id}`,
        level: 'warn',
        title: `用户未绑落地 · ${c.name}`,
        detail: '将默认使用主落地',
        fix: '在客户端编辑里选择落地',
      });
    }
    const pkg = c.package || {};
    if (pkg.expireAt && new Date(pkg.expireAt).getTime() < Date.now()) {
      push({
        id: `expire_${c.id}`,
        level: c.enabled === false ? 'info' : 'warn',
        title: `用户已到期 · ${c.name}`,
        detail: pkg.expireAt,
        fix: c.enabled === false ? '' : '将自动停用并下发',
      });
    }
    const quotaMb = Number(pkg.quotaMb) || 0;
    const total = Number(c.usage?.totalBytes) || 0;
    if (quotaMb > 0 && total >= quotaMb * 1024 * 1024) {
      push({
        id: `quota_${c.id}`,
        level: c.enabled === false ? 'info' : 'warn',
        title: `用户超额 · ${c.name}`,
        detail: `${formatBytes(total)} / ${quotaMb} MB`,
        fix: c.enabled === false ? '' : '将自动停用并下发',
      });
    }
  }

  const mita = report?.mita || {};
  const running = Boolean(mita.running) || /RUNNING/i.test(String(mita.status || ''));

  if (opts.dirty) {
    const which =
      Array.isArray(opts.dirtyLandings) && opts.dirtyLandings.length
        ? opts.dirtyLandings.join('、')
        : '';
    push({
      id: 'dirty',
      level: 'warn',
      title: '有未应用的更改',
      detail: which
        ? `以下落地配置未写入 mita：${which}`
        : '面板已保存，尚未下发到落地机 mita',
      fix: which
        ? '到「落地」展开对应机器点「应用配置」；或顶栏「应用全部」。空用户落地不会下发也无需下发'
        : '点「应用配置」或「一键落地」',
    });
  }

  if (opts.clientsNeedRescan) {
    push({
      id: 'need_rescan',
      level: 'info',
      title: '连接参数已变（提醒）',
      detail: '入站/端口/密码改过。这不是故障：客户端要用新 mierus 链接；更新后点「我已更新」即可消除本条',
      fix: '到「客户端」重新复制 mierus://（host=商家前置 114/211）→ 顶栏点「我已更新」',
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

/** 构建下发给 agent 的用户包（含 package 供设配额） */
function usersForBundle(state, nodeId) {
  return clientsForNode(state, nodeId).map((c) => ({
    id: c.id,
    name: c.name,
    password: c.password,
    enabled: c.enabled !== false,
    package: {
      quotaMb: Number(c.package?.quotaMb) || 0,
      quotaDays: Number(c.package?.quotaDays) || 30,
      quotaMode: c.package?.quotaMode || 'rolling',
      expireAt: c.package?.expireAt || '',
      bandwidthMbps: Number(c.package?.bandwidthMbps) || 0,
    },
  }));
}

module.exports = {
  DEFAULT_MTU,
  DEFAULT_PROTOCOL,
  randomPassword,
  randomUsername,
  isValidMieruUsername,
  looksLikeIp,
  looksLikeDomain,
  normalizeProtocol,
  parseEndpoint,
  joinEndpoint,
  ensureMieruDefaults,
  enabledUsers,
  clientsForNode,
  clientBelongsToNode,
  clientLandingNodeId,
  resolveLandingNodeId,
  clientListenPort,
  buildServerConfig,
  configHash,
  isDirty,
  markClean,
  shareDisplayName,
  buildShareLink,
  buildDualShareLinks,
  shareLinkForHost,
  buildClientJson,
  publicClient,
  diagnose,
  portForProtocol,
  protocolsForMode,
  endpointHost,
  enforcePackages,
  mergeUsageFromReport,
  usersForBundle,
  formatBytes,
  formatRate,
};
