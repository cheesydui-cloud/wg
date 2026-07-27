const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const cryptoWg = require('./crypto-wg');
const { WG_QUICK, WG_BIN, ALLOW_APPLY, DATA_DIR } = require('./config');

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
  const { network, broadcast, prefix } = parseCidr(serverAddress);
  const used = new Set();

  // 服务器自身地址占用
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

  // 从 network+2 开始（+1 通常是服务器）
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
  lines.push(`# 由 wg-panel 自动生成 — 请勿手改后忘记在面板同步`);
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

async function runCmd(bin, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: opts.timeout || 15000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
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
  // wg-quick without args exits non-zero but still indicates presence
  const wgOk = wg.ok || /wireguard/i.test(wg.stdout + wg.stderr);
  const quickOk = quick.ok || /wg-quick|Usage/i.test(quick.stdout + quick.stderr) || quick.code === 1;
  return {
    wg: wgOk,
    wgQuick: quickOk,
    wgVersion: wg.stdout || wg.stderr || '',
    allowApply: ALLOW_APPLY,
  };
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
      current = { publicKey: pub[1].trim(), transfer: '', latestHandshake: '', endpoint: '' };
      peers.push(current);
      continue;
    }
    if (!current) continue;
    const ep = line.match(/endpoint:\s+(.+)/i);
    if (ep) current.endpoint = ep[1].trim();
    const hs = line.match(/latest handshake:\s+(.+)/i);
    if (hs) current.latestHandshake = hs[1].trim();
    const tr = line.match(/transfer:\s+(.+)/i);
    if (tr) current.transfer = tr[1].trim();
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

function defaultPostUp(interfaceName) {
  // 常见 NAT 模板，网卡名用 eth0 占位，用户可改
  return (
    `iptables -A FORWARD -i ${interfaceName} -j ACCEPT; ` +
    `iptables -A FORWARD -o ${interfaceName} -j ACCEPT; ` +
    `iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE`
  );
}

function defaultPostDown(interfaceName) {
  return (
    `iptables -D FORWARD -i ${interfaceName} -j ACCEPT; ` +
    `iptables -D FORWARD -o ${interfaceName} -j ACCEPT; ` +
    `iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE`
  );
}

async function applyConfig(state) {
  if (!ALLOW_APPLY) {
    return { ok: false, message: '当前环境禁止写入系统配置（WG_ALLOW_APPLY=0）' };
  }

  ensureServerKeys(state);
  if (!state.server.privateKey) {
    return { ok: false, message: '服务器私钥为空，请先生成密钥' };
  }

  const confPath = state.server.confPath || `/etc/wireguard/${state.server.interfaceName}.conf`;
  const confDir = path.dirname(confPath);
  const content = buildServerConfig(state);

  // 先写一份备份到 data
  const backupPath = path.join(DATA_DIR, `${state.server.interfaceName}.conf`);
  fs.writeFileSync(backupPath, content, 'utf8');

  try {
    if (!fs.existsSync(confDir)) {
      fs.mkdirSync(confDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(confPath, content, { mode: 0o600 });
  } catch (err) {
    return {
      ok: false,
      message: `无法写入 ${confPath}: ${err.message}。请用 root 运行，或手动复制 data/${state.server.interfaceName}.conf`,
      backupPath,
      config: content,
    };
  }

  const iface = state.server.interfaceName;
  const status = await getInterfaceStatus(iface);

  if (status.up) {
    // 热重载：strip 掉 wg-quick 专有字段后 syncconf
    const strip = await runCmd(WG_QUICK, ['strip', iface]);
    if (strip.ok) {
      const strippedPath = path.join(DATA_DIR, `${iface}.stripped.conf`);
      fs.writeFileSync(strippedPath, strip.stdout + '\n', 'utf8');
      const sync = await runCmd(WG_BIN, ['syncconf', iface, strippedPath]);
      if (sync.ok) {
        return { ok: true, message: '配置已写入并热重载（syncconf）', confPath, action: 'syncconf' };
      }
      return {
        ok: false,
        message: `配置已写入，但热重载失败: ${sync.stderr || sync.stdout}。可尝试重启接口`,
        confPath,
      };
    }
    // 回退 restart
    const down = await runCmd(WG_QUICK, ['down', iface]);
    const up = await runCmd(WG_QUICK, ['up', iface]);
    if (up.ok) {
      return { ok: true, message: '配置已写入并重启接口', confPath, action: 'restart', down: down.stderr };
    }
    return { ok: false, message: `配置已写入，但启动失败: ${up.stderr || up.stdout}`, confPath };
  }

  const up = await runCmd(WG_QUICK, ['up', iface]);
  if (up.ok) {
    return { ok: true, message: '配置已写入并启动接口', confPath, action: 'up' };
  }
  return {
    ok: false,
    message: `配置已写入 ${confPath}，但启动失败: ${up.stderr || up.stdout}。请检查权限与内核模块`,
    confPath,
    config: content,
  };
}

async function stopInterface(interfaceName) {
  if (!ALLOW_APPLY) return { ok: false, message: '当前环境禁止操作系统接口' };
  const res = await runCmd(WG_QUICK, ['down', interfaceName]);
  if (res.ok) return { ok: true, message: `接口 ${interfaceName} 已关闭` };
  return { ok: false, message: res.stderr || res.stdout || '关闭失败' };
}

module.exports = {
  parseCidr,
  nextClientAddress,
  getNetworkBase,
  sanitizeName,
  buildServerConfig,
  buildClientConfig,
  checkTools,
  getInterfaceStatus,
  ensureServerKeys,
  defaultPostUp,
  defaultPostDown,
  applyConfig,
  stopInterface,
  generateKeyPair: cryptoWg.generateKeyPair,
  generatePresharedKey: cryptoWg.generatePresharedKey,
  derivePublicKey: cryptoWg.derivePublicKey,
  isValidKey: cryptoWg.isValidKey,
};
