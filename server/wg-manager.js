const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const cryptoWg = require('./crypto-wg');
const { WG_QUICK, WG_BIN, ALLOW_APPLY, DATA_DIR, BACKUP_DIR } = require('./config');

const execFileAsync = promisify(execFile);

function parseCidr(cidr) {
  const [ip, prefixStr] = String(cidr).split('/');
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    throw new Error(`无效的 IP/CIDR: ${cidr}`);
  }
  const prefix = prefixStr === undefined ? 32 : Number(prefixStr);
  if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`无效的前缀长度: ${cidr}`);
  }
  const ipNum = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipNum & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { ip, prefix, ipNum: ipNum >>> 0, network, broadcast, mask };
}

function numToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function getNetworkBase(serverAddress) {
  const { network, prefix } = parseCidr(serverAddress);
  return { network, prefix, cidr: `${numToIp(network)}/${prefix}` };
}

function nextClientAddress(serverAddress, clients) {
  const { network, broadcast } = parseCidr(serverAddress);
  const used = new Set();

  try {
    used.add(parseCidr(serverAddress).ipNum);
  } catch {
    /* ignore */
  }

  for (const c of clients || []) {
    if (!c.address) continue;
    try {
      used.add(parseCidr(c.address).ipNum);
    } catch {
      /* ignore */
    }
  }

  const start = (network + 2) >>> 0;
  const end = (broadcast - 1) >>> 0;
  for (let n = start; n <= end; n++) {
    if (!used.has(n >>> 0)) {
      return `${numToIp(n >>> 0)}/32`;
    }
  }
  throw new Error('网段内已无可用 IP，请扩大网段或删除闲置客户端');
}

function sanitizeName(name) {
  return String(name || 'client')
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '_')
    .slice(0, 64) || 'client';
}

/** 服务端 Peer 的 AllowedIPs：必须是该客户端的 /32 地址 */
function peerAllowedIps(client) {
  const raw = String(client?.address || '').trim();
  if (!raw) return '';
  try {
    const { ip } = parseCidr(raw.includes('/') ? raw : `${raw}/32`);
    return `${ip}/32`;
  } catch {
    return '';
  }
}

function isValidClientAddress(address) {
  try {
    parseCidr(String(address || '').includes('/') ? address : `${address}/32`);
    return Boolean(String(address || '').trim());
  } catch {
    return false;
  }
}

function normalizeClientAddress(address) {
  const raw = String(address || '').trim();
  if (!raw) return '';
  const cidr = raw.includes('/') ? raw : `${raw}/32`;
  const { ip, prefix } = parseCidr(cidr);
  // 客户端地址统一写成 x.x.x.x/32
  return `${ip}/32`;
}

function listSkippedPeers(state) {
  const skipped = [];
  for (const c of state.clients || []) {
    if (c.enabled === false) continue;
    if (!c.publicKey) {
      skipped.push({ id: c.id, name: c.name, reason: '缺少公钥' });
      continue;
    }
    if (!peerAllowedIps(c)) {
      skipped.push({ id: c.id, name: c.name, reason: '缺少有效内网 IP' });
    }
  }
  return skipped;
}

function countConfigPeers(state) {
  let n = 0;
  for (const c of state.clients || []) {
    if (c.enabled === false) continue;
    if (!c.publicKey) continue;
    if (!peerAllowedIps(c)) continue;
    n += 1;
  }
  return n;
}

function parseEndpoint(endpoint) {
  const raw = String(endpoint || '').trim();
  if (!raw) return { ok: false, host: '', port: null, message: 'Endpoint 为空' };
  let host = raw;
  let port = null;
  const m6 = raw.match(/^\[([^\]]+)\]:(\d+)$/);
  if (m6) {
    host = m6[1];
    port = Number(m6[2]);
  } else {
    const idx = raw.lastIndexOf(':');
    if (idx > 0) {
      const maybePort = Number(raw.slice(idx + 1));
      if (!Number.isNaN(maybePort) && maybePort >= 1 && maybePort <= 65535) {
        host = raw.slice(0, idx);
        port = maybePort;
      }
    }
  }
  if (!host) return { ok: false, host: '', port: null, message: 'Endpoint 主机为空' };
  if (port != null && (Number.isNaN(port) || port < 1 || port > 65535)) {
    return { ok: false, host, port, message: 'Endpoint 端口无效' };
  }
  return { ok: true, host, port, message: '' };
}

function buildServerConfig(state) {
  const s = state.server;
  const lines = ['[Interface]'];
  lines.push(`# 由 wg-panel 自动生成`);
  lines.push(`Address = ${s.address}`);
  lines.push(`ListenPort = ${s.listenPort}`);
  lines.push(`PrivateKey = ${s.privateKey}`);
  if (s.mtu) lines.push(`MTU = ${s.mtu}`);
  if (s.postUp) lines.push(`PostUp = ${s.postUp}`);
  if (s.postDown) lines.push(`PostDown = ${s.postDown}`);
  lines.push('');

  for (const c of state.clients || []) {
    if (c.enabled === false) continue;
    if (!c.publicKey) continue;
    const allowed = peerAllowedIps(c);
    if (!allowed) continue; // 跳过无 IP 的 peer，避免 wg 解析失败
    lines.push('[Peer]');
    lines.push(`# ${sanitizeName(c.name)}${c.note ? ' — ' + c.note : ''}`);
    lines.push(`PublicKey = ${c.publicKey}`);
    if (c.presharedKey) lines.push(`PresharedKey = ${c.presharedKey}`);
    lines.push(`AllowedIPs = ${allowed}`);
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

function buildClientConfig(state, client, opts = {}) {
  const s = state.server;
  const requireEndpoint = opts.requireEndpoint !== false;
  if (requireEndpoint && !String(s.endpoint || '').trim()) {
    const err = new Error('请先填写客户端连接地址（Endpoint），否则手机无法连接');
    err.code = 'NO_ENDPOINT';
    throw err;
  }
  const lines = ['[Interface]'];
  lines.push(`# ${sanitizeName(client.name)} — WireGuard 客户端配置`);
  lines.push(`PrivateKey = ${client.privateKey}`);
  lines.push(`Address = ${client.address}`);
  if (s.dns) lines.push(`DNS = ${s.dns}`);
  if (s.mtu) lines.push(`MTU = ${s.mtu}`);
  lines.push('');
  lines.push('[Peer]');
  lines.push(`PublicKey = ${s.publicKey}`);
  if (client.presharedKey) lines.push(`PresharedKey = ${client.presharedKey}`);
  lines.push(`AllowedIPs = ${client.allowedIPs || '0.0.0.0/0, ::/0'}`);
  if (s.endpoint) lines.push(`Endpoint = ${s.endpoint}`);
  if (client.persistentKeepalive) {
    lines.push(`PersistentKeepalive = ${client.persistentKeepalive}`);
  }
  lines.push('');
  return lines.join('\n');
}

function configHash(state) {
  ensureServerKeys(state);
  const content = buildServerConfig(state);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function isDirty(state) {
  if (!state.lastAppliedHash) return (state.clients || []).length > 0 || Boolean(state.server?.privateKey);
  return configHash(state) !== state.lastAppliedHash;
}

async function runCmd(bin, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: opts.timeout || 15000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      },
    });
    return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
  } catch (err) {
    return {
      ok: false,
      stdout: ((err.stdout || '') + '').trim(),
      stderr: ((err.stderr || err.message || '') + '').trim(),
      code: err.code,
    };
  }
}

async function checkTools() {
  const wg = await runCmd(WG_BIN, ['version']);
  const quick = await runCmd(WG_QUICK, [], { timeout: 5000 });
  const wgOk = wg.ok || /wireguard/i.test(wg.stdout + wg.stderr);
  const quickOk = quick.ok || /wg-quick|Usage/i.test(quick.stdout + quick.stderr) || quick.code === 1;
  return {
    wg: wgOk,
    wgQuick: quickOk,
    wgVersion: wg.stdout || wg.stderr || '',
    allowApply: ALLOW_APPLY,
  };
}

function parseHandshakeToMs(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes('now')) return 0;
  let ms = 0;
  const day = t.match(/(\d+)\s*day/);
  const hour = t.match(/(\d+)\s*hour/);
  const min = t.match(/(\d+)\s*minute/);
  const sec = t.match(/(\d+)\s*second/);
  if (day) ms += Number(day[1]) * 86400000;
  if (hour) ms += Number(hour[1]) * 3600000;
  if (min) ms += Number(min[1]) * 60000;
  if (sec) ms += Number(sec[1]) * 1000;
  if (!day && !hour && !min && !sec) return null;
  return ms;
}

async function getInterfaceStatus(interfaceName) {
  const show = await runCmd(WG_BIN, ['show', interfaceName]);
  if (!show.ok) {
    return {
      up: false,
      raw: show.stderr || show.stdout || '接口未运行或不存在',
      peers: [],
    };
  }
  const peers = [];
  let current = null;
  for (const line of show.stdout.split('\n')) {
    const pub = line.match(/^peer:\s+(.+)/i);
    if (pub) {
      current = {
        publicKey: pub[1].trim(),
        transfer: '',
        transferRx: '',
        transferTx: '',
        latestHandshake: '',
        handshakeAgeMs: null,
        online: false,
        endpoint: '',
      };
      peers.push(current);
      continue;
    }
    if (!current) continue;
    const ep = line.match(/endpoint:\s+(.+)/i);
    if (ep) current.endpoint = ep[1].trim();
    const hs = line.match(/latest handshake:\s+(.+)/i);
    if (hs) {
      current.latestHandshake = hs[1].trim();
      current.handshakeAgeMs = parseHandshakeToMs(hs[1]);
      // 3 分钟内有握手视为在线
      current.online = current.handshakeAgeMs !== null && current.handshakeAgeMs <= 3 * 60 * 1000;
    }
    const tr = line.match(/transfer:\s+(.+)/i);
    if (tr) {
      current.transfer = tr[1].trim();
      const m = tr[1].match(/([\d.]+\s*\w+)\s*received,\s*([\d.]+\s*\w+)\s*sent/i);
      if (m) {
        current.transferRx = m[1].trim();
        current.transferTx = m[2].trim();
      }
    }
  }
  return { up: true, raw: show.stdout, peers };
}

function ensureServerKeys(state) {
  if (!state.server.privateKey || !cryptoWg.isValidKey(state.server.privateKey)) {
    const kp = cryptoWg.generateKeyPair();
    state.server.privateKey = kp.privateKey;
    state.server.publicKey = kp.publicKey;
    return true;
  }
  if (!state.server.publicKey) {
    state.server.publicKey = cryptoWg.derivePublicKey(state.server.privateKey);
    return true;
  }
  return false;
}

function defaultPostUp(interfaceName, egressIface = 'eth0') {
  // 接口起来时确保转发开启，并做 FORWARD + SNAT(MASQUERADE)
  return (
    `sysctl -w net.ipv4.ip_forward=1; ` +
    `iptables -A FORWARD -i ${interfaceName} -j ACCEPT; ` +
    `iptables -A FORWARD -o ${interfaceName} -j ACCEPT; ` +
    `iptables -t nat -A POSTROUTING -o ${egressIface} -j MASQUERADE`
  );
}

function defaultPostDown(interfaceName, egressIface = 'eth0') {
  return (
    `iptables -D FORWARD -i ${interfaceName} -j ACCEPT; ` +
    `iptables -D FORWARD -o ${interfaceName} -j ACCEPT; ` +
    `iptables -t nat -D POSTROUTING -o ${egressIface} -j MASQUERADE`
  );
}

function hasNatTemplate(postUp = '', egressIface = '') {
  const s = String(postUp || '');
  if (!/MASQUERADE/i.test(s) && !/SNAT/i.test(s)) return false;
  if (egressIface && !s.includes(egressIface)) return true; // 有 NAT 但网卡名可能不同，仍算配置了
  return true;
}

async function checkMasqueradeActive(egressIface) {
  const r = await runCmd('iptables', ['-t', 'nat', '-S', 'POSTROUTING']);
  if (!r.ok) {
    return {
      ok: false,
      active: false,
      detail: r.stderr || '无法读取 iptables NAT 规则（需要 root 或 iptables）',
      rules: '',
    };
  }
  const rules = r.stdout || '';
  const lines = rules.split('\n').filter((l) => /MASQUERADE|SNAT/i.test(l));
  const matched = egressIface
    ? lines.filter((l) => l.includes(`-o ${egressIface}`) || l.includes(egressIface))
    : lines;
  return {
    ok: true,
    active: matched.length > 0 || lines.length > 0,
    matchedEgress: matched.length > 0,
    detail:
      matched.length > 0
        ? `已生效（出口 ${egressIface || '任意'}）`
        : lines.length > 0
          ? '系统有 MASQUERADE，但出口网卡可能不一致'
          : '尚未生效（需应用配置并启动接口）',
    rules: lines.join('\n'),
  };
}

/**
 * syncconf 不会执行 PostUp：若配置了 NAT，主动补齐 iptables（幂等）
 */
async function ensureNatLive(interfaceName, postUp, egressIfaceHint) {
  if (!hasNatTemplate(postUp || '')) {
    return { ok: true, skipped: true, message: '配置中无 NAT，跳过' };
  }
  const iface = interfaceName || 'wg0';
  let egress = egressIfaceHint;
  if (!egress) {
    const m = String(postUp || '').match(/-o\s+(\S+)\s+-j\s+MASQUERADE/i);
    if (m) egress = m[1];
  }
  if (!egress) {
    const d = await detectDefaultInterface();
    egress = d.iface || 'eth0';
  }

  enableIpForwardPersistent();

  const ensureRule = async (args) => {
    const check = await runCmd('iptables', ['-C', ...args]);
    if (check.ok) return { added: false };
    const add = await runCmd('iptables', ['-A', ...args]);
    return { added: add.ok, ok: add.ok, detail: add.stderr || add.stdout };
  };

  const r1 = await ensureRule(['FORWARD', '-i', iface, '-j', 'ACCEPT']);
  const r2 = await ensureRule(['FORWARD', '-o', iface, '-j', 'ACCEPT']);
  const r3 = await runCmd('iptables', [
    '-t',
    'nat',
    '-C',
    'POSTROUTING',
    '-o',
    egress,
    '-j',
    'MASQUERADE',
  ]);
  let natAdded = false;
  if (!r3.ok) {
    const add = await runCmd('iptables', [
      '-t',
      'nat',
      '-A',
      'POSTROUTING',
      '-o',
      egress,
      '-j',
      'MASQUERADE',
    ]);
    natAdded = add.ok;
    if (!add.ok) {
      return {
        ok: false,
        egress,
        message: `补齐 NAT 失败: ${add.stderr || add.stdout}`,
      };
    }
  }

  return {
    ok: true,
    egress,
    message: `已确保转发/NAT（${iface} → ${egress}）`,
    added: Boolean(r1.added || r2.added || natAdded),
  };
}

function enableIpForwardPersistent() {
  const results = { runtime: false, persistent: false, messages: [] };
  try {
    if (fs.existsSync('/proc/sys/net/ipv4/ip_forward')) {
      fs.writeFileSync('/proc/sys/net/ipv4/ip_forward', '1\n');
      results.runtime = true;
      results.messages.push('已开启运行时 ip_forward');
    }
  } catch (err) {
    results.messages.push(`运行时开启失败: ${err.message}`);
  }
  try {
    const confDir = '/etc/sysctl.d';
    const confFile = path.join(confDir, '99-wireguard-forward.conf');
    if (!fs.existsSync(confDir)) fs.mkdirSync(confDir, { recursive: true });
    fs.writeFileSync(confFile, 'net.ipv4.ip_forward=1\n', 'utf8');
    results.persistent = true;
    results.messages.push(`已写入 ${confFile}`);
  } catch (err) {
    results.messages.push(`持久化失败: ${err.message}（可能无 root 权限）`);
  }
  return results;
}

async function getExitStatus(state) {
  const iface = state.server?.interfaceName || 'wg0';
  const egress = await detectDefaultInterface();
  const forward = ipForwardEnabled();
  const natConfigured = hasNatTemplate(state.server?.postUp, egress.iface);
  const natLive = await checkMasqueradeActive(egress.iface);
  const ifaceStatus = await getInterfaceStatus(iface);
  const exitIp = await detectPublicIp();
  const fullTunnelCount = (state.clients || []).filter((c) => {
    const a = String(c.allowedIPs || '');
    return a.includes('0.0.0.0/0');
  }).length;

  const ready =
    forward === true &&
    natConfigured &&
    Boolean(state.server?.endpoint) &&
    ifaceStatus.up &&
    natLive.active;

  return {
    ok: true,
    ready,
    forward,
    egressIface: egress.iface,
    egress: egress,
    natConfigured,
    natActive: natLive.active,
    natDetail: natLive.detail,
    natRules: natLive.rules,
    interfaceUp: ifaceStatus.up,
    interfaceName: iface,
    endpoint: state.server?.endpoint || '',
    postUp: state.server?.postUp || '',
    postDown: state.server?.postDown || '',
    exitPublicIp: exitIp.ok ? exitIp.ip : null,
    exitIpSource: exitIp.ok ? exitIp.source : null,
    fullTunnelClients: fullTunnelCount,
    clientCount: (state.clients || []).length,
    tips: [
      !state.server?.endpoint ? '请先填写 Endpoint（客户端连接地址）' : null,
      forward === false ? 'IPv4 转发未开启' : null,
      !natConfigured ? '尚未配置 NAT（PostUp MASQUERADE）' : null,
      !ifaceStatus.up ? 'WireGuard 接口未启动，请先应用配置' : null,
      natConfigured && ifaceStatus.up && !natLive.active
        ? 'NAT 已写入配置但未在 iptables 生效，请重新应用'
        : null,
    ].filter(Boolean),
  };
}

/**
 * 一键落地：开转发 + 写 NAT + 可选全局代理客户端 + 可选立即应用
 */
async function setupExit(state, opts = {}) {
  const iface = state.server.interfaceName || 'wg0';
  const egress = await detectDefaultInterface();
  const egressIface = opts.egressIface || egress.iface || 'eth0';
  const steps = [];

  const forwardResult = enableIpForwardPersistent();
  const forwardNow = forwardResult.runtime || ipForwardEnabled() === true;
  steps.push({
    id: 'ip_forward',
    // 即使当前无权限写 sysctl，PostUp 里也有 sysctl -w，接口启动时会再开一次
    ok: true,
    warn: !forwardNow,
    title: 'IPv4 转发',
    detail: forwardNow
      ? forwardResult.messages.join('；')
      : `${forwardResult.messages.join('；') || '当前未能立即开启'}；将在接口 PostUp 时再次尝试`,
  });

  state.server.postUp = defaultPostUp(iface, egressIface);
  state.server.postDown = defaultPostDown(iface, egressIface);
  steps.push({
    id: 'nat',
    ok: true,
    title: 'NAT 规则',
    detail: `已写入 PostUp/PostDown，出口网卡 ${egressIface}`,
  });

  let clientsUpdated = 0;
  if (opts.fullTunnelClients !== false) {
    for (const c of state.clients || []) {
      const next = '0.0.0.0/0, ::/0';
      if (c.allowedIPs !== next) {
        c.allowedIPs = next;
        c.updatedAt = new Date().toISOString();
        clientsUpdated += 1;
      }
      if (!c.persistentKeepalive) {
        c.persistentKeepalive = 25;
        c.updatedAt = new Date().toISOString();
      }
    }
    steps.push({
      id: 'clients',
      ok: true,
      title: '客户端全局代理',
      detail:
        clientsUpdated > 0
          ? `已将 ${clientsUpdated} 个客户端设为 0.0.0.0/0, ::/0`
          : '客户端已是全局代理或暂无客户端',
    });
  }

  let applyResult = null;
  if (opts.apply) {
    applyResult = await applyConfig(state);
    steps.push({
      id: 'apply',
      ok: Boolean(applyResult?.ok),
      title: '应用到服务器',
      detail: applyResult?.message || (applyResult?.ok ? '已应用' : '应用失败'),
    });
  } else {
    steps.push({
      id: 'apply',
      ok: true,
      title: '应用到服务器',
      detail: '已保存配置，尚未应用（可在面板点击应用）',
      skipped: true,
    });
  }

  const status = await getExitStatus(state);
  return {
    ok: steps.every((s) => s.ok || s.skipped),
    egressIface,
    clientsUpdated,
    applied: Boolean(opts.apply && applyResult?.ok),
    applyResult,
    steps,
    status,
    message: opts.apply
      ? applyResult?.ok
        ? `落地已配置并应用（出口 ${egressIface}）`
        : `落地规则已写入，但应用失败：${applyResult?.message || ''}`
      : `落地规则已写入（出口 ${egressIface}），请点击「应用」生效`,
  };
}

async function detectDefaultInterface() {
  // ip route show default
  const r1 = await runCmd('ip', ['route', 'show', 'default']);
  if (r1.ok) {
    const m = r1.stdout.match(/default via \S+ dev (\S+)/) || r1.stdout.match(/default dev (\S+)/);
    if (m) return { ok: true, iface: m[1], source: 'ip route' };
  }
  const r2 = await runCmd('route', ['-n']);
  if (r2.ok) {
    const line = r2.stdout.split('\n').find((l) => l.startsWith('0.0.0.0') || l.includes('UG'));
    if (line) {
      const parts = line.trim().split(/\s+/);
      const iface = parts[parts.length - 1];
      if (iface && iface !== 'Iface') return { ok: true, iface, source: 'route -n' };
    }
  }
  return { ok: false, iface: 'eth0', source: 'fallback', message: '未能自动识别，回退 eth0' };
}

function fetchText(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchText(res.headers.location, timeoutMs).then(resolve, reject);
        res.resume();
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        data += c;
        if (data.length > 2048) {
          req.destroy();
          reject(new Error('响应过长'));
        }
      });
      res.on('end', () => resolve(data.trim()));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

async function detectPublicIp() {
  const providers = [
    'https://api.ipify.org',
    'https://ifconfig.me/ip',
    'https://icanhazip.com',
  ];
  for (const url of providers) {
    try {
      const ip = await fetchText(url);
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        return { ok: true, ip, source: url };
      }
    } catch {
      /* try next */
    }
  }
  return { ok: false, message: '无法探测公网 IP，请手动填写' };
}

function canWritePath(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const testFile = path.join(dir, `.wg-panel-write-test-${process.pid}`);
    fs.writeFileSync(testFile, 'ok', { mode: 0o600 });
    fs.unlinkSync(testFile);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

function isRoot() {
  try {
    return typeof process.getuid === 'function' ? process.getuid() === 0 : false;
  } catch {
    return false;
  }
}

function ipForwardEnabled() {
  try {
    const v = fs.readFileSync('/proc/sys/net/ipv4/ip_forward', 'utf8').trim();
    return v === '1';
  } catch {
    return null;
  }
}

async function preflight(state) {
  const tools = await checkTools();
  const confPath = state.server.confPath || `/etc/wireguard/${state.server.interfaceName}.conf`;
  const write = canWritePath(confPath);
  const egress = await detectDefaultInterface();
  const ifaceStatus = await getInterfaceStatus(state.server.interfaceName);
  const forward = ipForwardEnabled();
  const checks = [];

  checks.push({
    id: 'allow_apply',
    ok: ALLOW_APPLY,
    title: '允许应用配置',
    detail: ALLOW_APPLY ? 'WG_ALLOW_APPLY 已启用' : '当前禁止写入系统（WG_ALLOW_APPLY=0）',
  });
  checks.push({
    id: 'root',
    ok: isRoot() || write.ok,
    title: '写入权限',
    detail: isRoot() ? '当前为 root' : write.ok ? `可写 ${path.dirname(confPath)}` : `无法写入 ${confPath}: ${write.message}`,
  });
  checks.push({
    id: 'wg',
    ok: tools.wg,
    title: 'wg 命令',
    detail: tools.wg ? tools.wgVersion || '已安装' : '未找到 wg，请安装 wireguard-tools',
  });
  checks.push({
    id: 'wg_quick',
    ok: tools.wgQuick,
    title: 'wg-quick 命令',
    detail: tools.wgQuick ? '已安装' : '未找到 wg-quick',
  });
  checks.push({
    id: 'keys',
    ok: Boolean(state.server.privateKey && state.server.publicKey),
    title: '服务器密钥',
    detail: state.server.privateKey ? '已生成' : '缺少密钥',
  });
  checks.push({
    id: 'endpoint',
    ok: Boolean(state.server.endpoint),
    title: 'Endpoint',
    detail: state.server.endpoint || '未设置（客户端将无法主动连接）',
    warn: !state.server.endpoint,
  });
  checks.push({
    id: 'ip_forward',
    ok: forward === true || forward === null,
    title: 'IPv4 转发',
    detail: forward === true ? '已开启' : forward === false ? '未开启（客户端可能无法访问公网）' : '无法检测（非 Linux）',
    warn: forward === false,
  });
  checks.push({
    id: 'egress',
    ok: egress.ok,
    title: '出口网卡',
    detail: `${egress.iface}${egress.ok ? '' : '（猜测）'} · ${egress.source || ''}`,
  });
  checks.push({
    id: 'interface',
    ok: true,
    title: '当前接口状态',
    detail: ifaceStatus.up ? `${state.server.interfaceName} 运行中` : `${state.server.interfaceName} 未启动`,
  });

  const badClients = (state.clients || []).filter(
    (c) => c.enabled !== false && (!c.publicKey || !peerAllowedIps(c))
  );
  checks.push({
    id: 'clients',
    ok: badClients.length === 0,
    title: '客户端配置',
    detail:
      badClients.length === 0
        ? `共 ${(state.clients || []).filter((c) => c.enabled !== false).length} 个启用客户端`
        : `以下客户端缺少有效内网 IP 或公钥：${badClients.map((c) => c.name || c.id).join('、')}`,
  });

  const blocking = checks.filter((c) => !c.ok && !c.warn);
  const warnings = checks.filter((c) => c.warn || (!c.ok && c.id === 'endpoint'));

  return {
    ok: blocking.length === 0,
    canApply: ALLOW_APPLY && tools.wg && tools.wgQuick && write.ok && Boolean(state.server.privateKey),
    checks,
    blocking: blocking.map((c) => c.title),
    warnings: warnings.map((c) => c.detail),
    egressIface: egress.iface,
    confPath,
    dirty: isDirty(state),
    tools,
    interface: ifaceStatus,
  };
}

function backupConfigFile(confPath, content) {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.basename(confPath || 'wg0.conf');
    const backupPath = path.join(BACKUP_DIR, `${base}.${ts}.bak`);
    if (fs.existsSync(confPath)) {
      fs.copyFileSync(confPath, backupPath);
    } else if (content) {
      fs.writeFileSync(backupPath, content, 'utf8');
    }
    // 只保留最近 20 个
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.bak'))
      .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(20)) {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, old.f));
      } catch {
        /* ignore */
      }
    }
    return backupPath;
  } catch (err) {
    return null;
  }
}

async function applyConfig(state) {
  if (!ALLOW_APPLY) {
    return { ok: false, message: '当前环境禁止写入系统配置（WG_ALLOW_APPLY=0）' };
  }

  ensureServerKeys(state);
  if (!state.server.privateKey) {
    return { ok: false, message: '服务器私钥为空，请先生成密钥' };
  }

  const pf = await preflight(state);
  if (!pf.canApply) {
    return {
      ok: false,
      message: `预检未通过：${pf.blocking.join('、') || '请检查权限与工具'}`,
      preflight: pf,
    };
  }

  const confPath = state.server.confPath || `/etc/wireguard/${state.server.interfaceName}.conf`;
  const content = buildServerConfig(state);

  // data 目录备份
  const dataBackup = path.join(DATA_DIR, `${state.server.interfaceName}.conf`);
  fs.writeFileSync(dataBackup, content, 'utf8');
  const backupPath = backupConfigFile(confPath, content);

  try {
    const confDir = path.dirname(confPath);
    if (!fs.existsSync(confDir)) {
      fs.mkdirSync(confDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(confPath, content, { mode: 0o600 });
  } catch (err) {
    return {
      ok: false,
      message: `无法写入 ${confPath}: ${err.message}`,
      backupPath,
      config: content,
    };
  }

  const iface = state.server.interfaceName;
  const status = await getInterfaceStatus(iface);
  let action = '';
  let message = '';

  if (status.up) {
    const strip = await runCmd(WG_QUICK, ['strip', iface]);
    if (strip.ok) {
      const strippedPath = path.join(DATA_DIR, `${iface}.stripped.conf`);
      fs.writeFileSync(strippedPath, strip.stdout + '\n', 'utf8');
      const sync = await runCmd(WG_BIN, ['syncconf', iface, strippedPath]);
      if (sync.ok) {
        action = 'syncconf';
        message = '配置已写入并热重载（syncconf）';
      } else {
        await runCmd(WG_QUICK, ['down', iface]);
        const up = await runCmd(WG_QUICK, ['up', iface]);
        if (!up.ok) {
          return {
            ok: false,
            message: `配置已写入，但重载失败: ${up.stderr || sync.stderr}`,
            confPath,
            backupPath,
          };
        }
        action = 'restart';
        message = '配置已写入并重启接口';
      }
    } else {
      await runCmd(WG_QUICK, ['down', iface]);
      const up = await runCmd(WG_QUICK, ['up', iface]);
      if (!up.ok) {
        return { ok: false, message: `配置已写入，启动失败: ${up.stderr || up.stdout}`, confPath, backupPath };
      }
      action = 'restart';
      message = '配置已写入并重启接口';
    }
  } else {
    const up = await runCmd(WG_QUICK, ['up', iface]);
    if (!up.ok) {
      return {
        ok: false,
        message: `配置已写入 ${confPath}，但启动失败: ${up.stderr || up.stdout}`,
        confPath,
        backupPath,
        config: content,
      };
    }
    action = 'up';
    message = '配置已写入并启动接口';
  }

  // syncconf 不跑 PostUp：主动补 NAT
  let natEnsure = null;
  if (action === 'syncconf' && hasNatTemplate(state.server.postUp || '')) {
    natEnsure = await ensureNatLive(iface, state.server.postUp);
    if (natEnsure.ok && natEnsure.added) {
      message += `；已补齐 NAT（${natEnsure.egress}）`;
    } else if (!natEnsure.ok) {
      message += `；警告: ${natEnsure.message}`;
    }
  }

  state.lastAppliedHash = configHash(state);
  state.lastAppliedAt = new Date().toISOString();

  const skipped = listSkippedPeers(state);
  const expectedPeers = countConfigPeers(state);
  const live = await getInterfaceStatus(iface);
  const livePeers = live.peers?.length || 0;
  const warnings = [];
  if (skipped.length) {
    warnings.push(
      `以下客户端未写入服务端 peer：${skipped.map((s) => s.name || s.id).join('、')}`
    );
  }
  if (expectedPeers === 0) {
    warnings.push('当前没有启用的客户端 peer，手机将无法握手');
  } else if (live.up && livePeers < expectedPeers) {
    warnings.push(`服务端 peer ${livePeers}/${expectedPeers}，请确认已应用最新配置`);
  }

  return {
    ok: true,
    message: warnings.length ? `${message}（注意: ${warnings[0]}）` : message,
    confPath,
    backupPath,
    action,
    preflight: pf,
    natEnsure,
    skippedPeers: skipped,
    expectedPeers,
    livePeers,
    warnings,
  };
}

async function stopInterface(interfaceName) {
  if (!ALLOW_APPLY) return { ok: false, message: '当前环境禁止操作系统接口' };
  const res = await runCmd(WG_QUICK, ['down', interfaceName]);
  if (res.ok) return { ok: true, message: `接口 ${interfaceName} 已关闭` };
  return { ok: false, message: res.stderr || res.stdout || '关闭失败' };
}

function listBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.bak'))
      .map((f) => {
        const full = path.join(BACKUP_DIR, f);
        const st = fs.statSync(full);
        return { name: f, path: full, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  } catch {
    return [];
  }
}

/**
 * 诊断：配置 + 运行状态，给出可执行建议
 * report: 可选 agent lastReport（远程模式）
 */
async function diagnose(state, opts = {}) {
  const mode = opts.mode || 'local';
  const report = opts.report || null;
  const agentOnline = Boolean(opts.agentOnline);
  const items = [];
  const s = state.server || {};
  const clients = state.clients || [];

  const push = (item) => {
    items.push({
      level: item.level || 'info', // ok | warn | error | info
      id: item.id,
      title: item.title,
      detail: item.detail || '',
      fix: item.fix || '',
    });
  };

  // mode
  push({
    id: 'mode',
    level: 'info',
    title: '出口模式',
    detail: mode === 'agent' ? '远程 Agent（配置下发到落地机）' : '本机（面板所在机器跑 WireGuard）',
  });

  if (mode === 'agent') {
    push({
      id: 'agent_online',
      level: agentOnline ? 'ok' : 'error',
      title: 'Agent 在线',
      detail: agentOnline
        ? `在线${opts.hostname ? ' · ' + opts.hostname : ''}${opts.agentVersion ? ' · v' + opts.agentVersion : ''}`
        : '离线：远程落地/应用不会执行',
      fix: agentOnline
        ? ''
        : '在落地机以 root 执行面板生成的安装命令；检查 WG_PANEL_URL 能否访问面板',
    });
  }

  // endpoint
  const ep = parseEndpoint(s.endpoint);
  const listenPort = Number(s.listenPort) || 0;
  if (!ep.ok || !s.endpoint) {
    push({
      id: 'endpoint',
      level: 'error',
      title: '客户端连接地址（Endpoint）',
      detail: '未填写。手机扫码后无法主动连接',
      fix: '在「出口服务器」填写 公网IP或入口IP:端口，例如 114.x.x.x:7901',
    });
  } else {
    const portMismatch = ep.port != null && listenPort && ep.port !== listenPort;
    push({
      id: 'endpoint',
      level: portMismatch ? 'warn' : 'ok',
      title: '客户端连接地址（Endpoint）',
      detail: portMismatch
        ? `${s.endpoint}（端口 ${ep.port} ≠ 监听 ${listenPort}）`
        : s.endpoint,
      fix: portMismatch
        ? `把 Endpoint 改成 ${ep.host}:${listenPort}，保存后重新扫码`
        : '',
    });
  }

  push({
    id: 'listen_port',
    level: listenPort ? 'ok' : 'error',
    title: '监听端口',
    detail: listenPort ? `UDP ${listenPort}` : '未设置',
    fix: listenPort ? '确认商家/防火墙放行该 UDP 端口' : '设置监听端口',
  });

  push({
    id: 'keys',
    level: s.privateKey && s.publicKey ? 'ok' : 'error',
    title: '服务器密钥',
    detail: s.publicKey ? `公钥 ${String(s.publicKey).slice(0, 16)}…` : '缺少密钥',
  });

  const skipped = listSkippedPeers(state);
  const enabled = clients.filter((c) => c.enabled !== false);
  const peerCount = countConfigPeers(state);
  push({
    id: 'clients',
    level: enabled.length === 0 ? 'warn' : skipped.length ? 'error' : 'ok',
    title: '客户端',
    detail:
      enabled.length === 0
        ? '还没有客户端'
        : skipped.length
          ? `${enabled.length} 个中有 ${skipped.length} 个无法写入 peer：${skipped.map((x) => x.name).join('、')}`
          : `${enabled.length} 个启用 · 将写入 ${peerCount} 个 peer`,
    fix:
      enabled.length === 0
        ? '在「客户端」页添加手机'
        : skipped.length
          ? '编辑客户端补全内网 IP 后重新应用'
          : '',
  });

  // runtime from local or agent report
  let ifaceStatus = { up: false, peers: [], raw: '' };
  let forward = null;
  let natActive = false;
  let egressIface = '';
  let exitPublicIp = null;

  if (mode === 'local') {
    ifaceStatus = await getInterfaceStatus(s.interfaceName || 'wg0');
    forward = ipForwardEnabled();
    const egress = await detectDefaultInterface();
    egressIface = egress.iface || '';
    const nat = await checkMasqueradeActive(egressIface);
    natActive = nat.active;
    const ip = await detectPublicIp();
    if (ip.ok) exitPublicIp = ip.ip;
  } else if (report) {
    ifaceStatus = report.interface || ifaceStatus;
    forward = report.forward;
    natActive = Boolean(report.natActive);
    egressIface = report.egressIface || '';
    exitPublicIp = report.exitPublicIp || null;
  }

  push({
    id: 'interface',
    level: ifaceStatus.up ? 'ok' : mode === 'agent' && !agentOnline ? 'warn' : 'error',
    title: 'WireGuard 接口',
    detail: ifaceStatus.up
      ? `${s.interfaceName || 'wg0'} 运行中 · live peer ${ifaceStatus.peers?.length || 0}`
      : mode === 'agent' && !report
        ? '尚无 Agent 上报（节点需在线）'
        : '接口未启动',
    fix: ifaceStatus.up ? '' : '点击「应用配置」或「一键落地」',
  });

  const natConfigured = hasNatTemplate(s.postUp || '');
  push({
    id: 'forward',
    level: forward === true ? 'ok' : forward === false ? 'error' : 'warn',
    title: 'IPv4 转发',
    detail: forward === true ? '已开启' : forward === false ? '未开启' : '未知',
    fix: forward === false ? '点击「一键落地」' : '',
  });
  push({
    id: 'nat',
    level: natActive ? 'ok' : natConfigured ? 'warn' : 'error',
    title: 'NAT（MASQUERADE）',
    detail: natActive
      ? `已生效${egressIface ? ' · 出口 ' + egressIface : ''}`
      : natConfigured
        ? '已写入配置但未生效'
        : '未配置',
    fix: natActive ? '' : '点击「一键落地」；确认出口网卡名正确',
  });

  if (exitPublicIp) {
    push({
      id: 'egress_ip',
      level: 'info',
      title: '当前出网 IP（勿当 Endpoint）',
      detail: exitPublicIp,
      fix: '这是服务器访问外网时的 IP，不是手机应连接的入站地址',
    });
  }

  // peer handshake analysis
  const peerMap = new Map();
  for (const p of ifaceStatus.peers || []) {
    if (p.publicKey) peerMap.set(p.publicKey, p);
  }
  let onlineCount = 0;
  let txOnly = 0;
  let noHs = 0;
  for (const c of enabled) {
    const live = peerMap.get(c.publicKey);
    if (live?.online) onlineCount += 1;
    else if (live?.latestHandshake) noHs += 1; // has history but not recent
    else noHs += 1;
  }
  // server-side: peers with transfer sent but no handshake often means client TX only visible if endpoint reaches
  for (const p of ifaceStatus.peers || []) {
    const rxZero =
      !p.transferRx ||
      /^0(\.0+)?\s*(B|byte)/i.test(String(p.transferRx)) ||
      p.transferRx === '0 B';
    const hasTx = p.transferTx && !/^0(\.0+)?\s*(B|byte)/i.test(String(p.transferTx));
    if (!p.online && hasTx && rxZero) txOnly += 1;
  }

  push({
    id: 'handshake',
    level: onlineCount > 0 ? 'ok' : enabled.length === 0 ? 'info' : 'warn',
    title: '握手状态',
    detail:
      enabled.length === 0
        ? '无客户端'
        : onlineCount > 0
          ? `${onlineCount}/${enabled.length} 个客户端近 3 分钟有握手`
          : `0/${enabled.length} 在线 · 手机打开隧道后若仍为 0，多半是 UDP 进不来或密钥不一致`,
    fix:
      onlineCount > 0
        ? ''
        : enabled.length
          ? '1) 确认扫的是本面板「客户端」二维码 2) Endpoint 用外部连接 IP 3) 落地机 tcpdump -n udp port 端口 看有无包 4) 商家是否映射了 UDP'
          : '先添加客户端并扫码',
  });

  if (txOnly > 0) {
    push({
      id: 'tx_only',
      level: 'error',
      title: '疑似仅发送无接收',
      detail: `${txOnly} 个 peer 有发送无握手/无接收`,
      fix: 'UDP 未到达或密钥错误：检查 Endpoint、监听端口、服务端是否包含该 peer、重新扫码',
    });
  }

  const errors = items.filter((i) => i.level === 'error').length;
  const warns = items.filter((i) => i.level === 'warn').length;
  let summary = '配置看起来正常';
  if (errors) summary = `发现 ${errors} 个必须处理的问题`;
  else if (warns) summary = `有 ${warns} 个警告，建议处理`;
  if (onlineCount > 0 && natActive && forward === true) {
    summary = '隧道与落地条件正常，手机应可上网';
  }

  return {
    ok: errors === 0,
    summary,
    mode,
    items,
    stats: {
      clientCount: enabled.length,
      peerCount,
      onlineCount,
      interfaceUp: Boolean(ifaceStatus.up),
      forward,
      natActive,
      egressIface,
      exitPublicIp,
      endpoint: s.endpoint || '',
      listenPort,
      agentOnline: mode === 'agent' ? agentOnline : null,
    },
    raw: ifaceStatus.raw || '',
  };
}

module.exports = {
  parseCidr,
  nextClientAddress,
  getNetworkBase,
  sanitizeName,
  buildServerConfig,
  buildClientConfig,
  configHash,
  isDirty,
  checkTools,
  getInterfaceStatus,
  ensureServerKeys,
  defaultPostUp,
  defaultPostDown,
  detectDefaultInterface,
  detectPublicIp,
  peerAllowedIps,
  isValidClientAddress,
  normalizeClientAddress,
  enableIpForwardPersistent,
  getExitStatus,
  setupExit,
  checkMasqueradeActive,
  ensureNatLive,
  preflight,
  applyConfig,
  stopInterface,
  listBackups,
  backupConfigFile,
  listSkippedPeers,
  countConfigPeers,
  parseEndpoint,
  diagnose,
  hasNatTemplate,
  generateKeyPair: cryptoWg.generateKeyPair,
  generatePresharedKey: cryptoWg.generatePresharedKey,
  derivePublicKey: cryptoWg.derivePublicKey,
  isValidKey: cryptoWg.isValidKey,
};
