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
    lines.push('[Peer]');
    lines.push(`# ${sanitizeName(c.name)}${c.note ? ' — ' + c.note : ''}`);
    lines.push(`PublicKey = ${c.publicKey}`);
    if (c.presharedKey) lines.push(`PresharedKey = ${c.presharedKey}`);
    lines.push(`AllowedIPs = ${c.address.replace(/\/\d+$/, '/32')}`);
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

function buildClientConfig(state, client) {
  const s = state.server;
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
  return (
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

  state.lastAppliedHash = configHash(state);
  state.lastAppliedAt = new Date().toISOString();

  return {
    ok: true,
    message,
    confPath,
    backupPath,
    action,
    preflight: pf,
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
  preflight,
  applyConfig,
  stopInterface,
  listBackups,
  backupConfigFile,
  generateKeyPair: cryptoWg.generateKeyPair,
  generatePresharedKey: cryptoWg.generatePresharedKey,
  derivePublicKey: cryptoWg.derivePublicKey,
  isValidKey: cryptoWg.isValidKey,
};
