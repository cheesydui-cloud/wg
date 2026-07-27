#!/usr/bin/env node
/**
 * WG Panel Edge Agent v1.4.1
 * 连接中心面板，拉取任务：应用配置 / 一键落地 / 上报状态
 *
 * 环境变量：
 *   WG_PANEL_URL       面板地址，如 http://1.2.3.4:51821
 *   WG_AGENT_TOKEN     节点 token
 *   WG_AGENT_NAME      可选显示名
 *   WG_AGENT_INTERVAL  轮询秒数，默认 10
 *   WG_IFACE           可选，默认从 bundle/上次配置读取，回退 wg0
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const VERSION = '1.4.1';

const PANEL_URL = (process.env.WG_PANEL_URL || '').replace(/\/$/, '');
const TOKEN = process.env.WG_AGENT_TOKEN || '';
const INTERVAL = Math.max(5, Number(process.env.WG_AGENT_INTERVAL || 10));
const DATA_DIR = process.env.WG_AGENT_DATA || '/var/lib/wg-agent';
const CONF_FALLBACK = '/etc/wireguard/wg0.conf';
const STATE_FILE = path.join(DATA_DIR, 'agent-state.json');

if (!PANEL_URL || !TOKEN) {
  console.error('[wg-agent] 需要环境变量 WG_PANEL_URL 与 WG_AGENT_TOKEN');
  process.exit(1);
}

let cachedIface = process.env.WG_IFACE || 'wg0';

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

function loadLocalState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {
    /* ignore */
  }
  return {};
}

function saveLocalState(obj) {
  try {
    ensureDir(DATA_DIR);
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, PANEL_URL);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
          'User-Agent': `wg-agent/${VERSION}`,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
        timeout: 30000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : {};
          } catch {
            json = { raw };
          }
          if (res.statusCode >= 400) {
            const err = new Error(json.error || json.message || `HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            err.data = json;
            return reject(err);
          }
          resolve(json);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function run(bin, args, timeout = 20000) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout,
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

function parseWgShow(raw) {
  const peers = [];
  let current = null;
  let ifaceUp = false;
  let listeningPort = null;
  let publicKey = '';
  for (const line of String(raw || '').split('\n')) {
    if (line.startsWith('interface:')) {
      ifaceUp = true;
      continue;
    }
    const lp = line.match(/listening port:\s*(\d+)/i);
    if (lp) listeningPort = Number(lp[1]);
    const pk = line.match(/public key:\s*(.+)/i);
    if (pk && !current) publicKey = pk[1].trim();
    if (line.startsWith('peer:')) {
      if (current) peers.push(current);
      current = {
        publicKey: line.replace(/^peer:\s*/i, '').trim(),
        online: false,
        latestHandshake: '',
        handshakeAgeMs: null,
        transfer: '',
        transferRx: '',
        transferTx: '',
        endpoint: '',
      };
      continue;
    }
    if (!current) continue;
    const t = line.trim();
    if (t.startsWith('endpoint:')) current.endpoint = t.slice(9).trim();
    if (t.startsWith('latest handshake:')) {
      current.latestHandshake = t.slice(17).trim();
      current.handshakeAgeMs = parseHandshakeToMs(current.latestHandshake);
      current.online =
        current.handshakeAgeMs !== null && current.handshakeAgeMs <= 3 * 60 * 1000;
    }
    if (t.startsWith('transfer:')) {
      current.transfer = t.slice(9).trim();
      const m = current.transfer.match(
        /([\d.]+\s*\w+)\s*received,\s*([\d.]+\s*\w+)\s*sent/i
      );
      if (m) {
        current.transferRx = m[1].trim();
        current.transferTx = m[2].trim();
      }
    }
  }
  if (current) peers.push(current);
  return { up: ifaceUp, peers, listeningPort, publicKey };
}

async function getInterfaceStatus(name) {
  const r = await run('wg', ['show', name]);
  if (!r.ok && /Unable to access|No such device|does not exist/i.test(r.stderr + r.stdout)) {
    return { up: false, peers: [], raw: r.stderr || r.stdout, listeningPort: null };
  }
  if (!r.ok) return { up: false, peers: [], raw: r.stderr || r.stdout, listeningPort: null };
  const parsed = parseWgShow(r.stdout);
  return { ...parsed, raw: r.stdout };
}

function enableForward() {
  const messages = [];
  try {
    fs.writeFileSync('/proc/sys/net/ipv4/ip_forward', '1\n');
    messages.push('runtime ok');
  } catch (e) {
    messages.push('runtime: ' + e.message);
  }
  try {
    ensureDir('/etc/sysctl.d');
    fs.writeFileSync('/etc/sysctl.d/99-wireguard-forward.conf', 'net.ipv4.ip_forward=1\n');
    messages.push('persistent ok');
  } catch (e) {
    messages.push('persistent: ' + e.message);
  }
  return messages.join('; ');
}

async function detectEgress() {
  const r = await run('ip', ['route', 'show', 'default']);
  if (r.ok) {
    const m = r.stdout.match(/default via \S+ dev (\S+)/) || r.stdout.match(/default dev (\S+)/);
    if (m) return m[1];
  }
  return 'eth0';
}

function defaultPostUp(iface, egress) {
  return (
    `sysctl -w net.ipv4.ip_forward=1; ` +
    `iptables -A FORWARD -i ${iface} -j ACCEPT; ` +
    `iptables -A FORWARD -o ${iface} -j ACCEPT; ` +
    `iptables -t nat -A POSTROUTING -o ${egress} -j MASQUERADE`
  );
}

function defaultPostDown(iface, egress) {
  return (
    `iptables -D FORWARD -i ${iface} -j ACCEPT; ` +
    `iptables -D FORWARD -o ${iface} -j ACCEPT; ` +
    `iptables -t nat -D POSTROUTING -o ${egress} -j MASQUERADE`
  );
}

function rewriteConfigPost(config, postUp, postDown) {
  const lines = String(config).split('\n');
  const out = [];
  let sawUp = false;
  let sawDown = false;
  for (const line of lines) {
    if (/^PostUp\s*=/.test(line)) {
      out.push(`PostUp = ${postUp}`);
      sawUp = true;
      continue;
    }
    if (/^PostDown\s*=/.test(line)) {
      out.push(`PostDown = ${postDown}`);
      sawDown = true;
      continue;
    }
    out.push(line);
  }
  if (!sawUp || !sawDown) {
    const idx = out.findIndex((l) => /^PrivateKey\s*=/.test(l));
    const insertAt = idx >= 0 ? idx + 1 : 1;
    const extra = [];
    if (!sawUp) extra.push(`PostUp = ${postUp}`);
    if (!sawDown) extra.push(`PostDown = ${postDown}`);
    out.splice(insertAt, 0, ...extra);
  }
  return out.join('\n');
}

async function ensureIptables(iface, egress) {
  enableForward();
  const ensure = async (args) => {
    const c = await run('iptables', ['-C', ...args]);
    if (!c.ok) await run('iptables', ['-A', ...args]);
  };
  await ensure(['FORWARD', '-i', iface, '-j', 'ACCEPT']);
  await ensure(['FORWARD', '-o', iface, '-j', 'ACCEPT']);
  const natC = await run('iptables', [
    '-t',
    'nat',
    '-C',
    'POSTROUTING',
    '-o',
    egress,
    '-j',
    'MASQUERADE',
  ]);
  if (!natC.ok) {
    await run('iptables', [
      '-t',
      'nat',
      '-A',
      'POSTROUTING',
      '-o',
      egress,
      '-j',
      'MASQUERADE',
    ]);
  }
}

async function detectPublicIp() {
  const urls = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];
  for (const url of urls) {
    try {
      const r = await new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { timeout: 4000 }, (res) => {
          let d = '';
          res.on('data', (c) => {
            d += c;
            if (d.length > 64) req.destroy();
          });
          res.on('end', () => resolve(d.trim()));
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('timeout'));
        });
      });
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(r)) return r;
    } catch {
      /* next */
    }
  }
  return null;
}

async function applyConfigBundle(bundle, { forceExit = false } = {}) {
  const iface = bundle.server?.interfaceName || cachedIface || 'wg0';
  cachedIface = iface;
  const local = loadLocalState();
  local.interfaceName = iface;
  saveLocalState(local);

  let confPath = bundle.server?.confPath || CONF_FALLBACK;
  let config = bundle.config;
  let egress = await detectEgress();
  let postUp = bundle.server?.postUp || '';
  let postDown = bundle.server?.postDown || '';

  if (forceExit) {
    enableForward();
    postUp = defaultPostUp(iface, egress);
    postDown = defaultPostDown(iface, egress);
    config = rewriteConfigPost(config, postUp, postDown);
  }

  ensureDir(path.dirname(confPath));
  ensureDir(DATA_DIR);
  const backup = path.join(DATA_DIR, `${iface}.conf.bak`);
  try {
    if (fs.existsSync(confPath)) fs.copyFileSync(confPath, backup);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(confPath, config, { mode: 0o600 });
  fs.writeFileSync(path.join(DATA_DIR, `${iface}.conf`), config, { mode: 0o600 });

  const show = await run('wg', ['show', iface]);
  const isUp =
    show.ok && !/Unable to access|No such device|does not exist/i.test(show.stderr + show.stdout);

  let action = '';
  if (isUp) {
    const strip = await run('wg-quick', ['strip', iface]);
    if (strip.ok) {
      const stripped = path.join(DATA_DIR, `${iface}.stripped.conf`);
      fs.writeFileSync(stripped, strip.stdout + '\n', { mode: 0o600 });
      const sync = await run('wg', ['syncconf', iface, stripped]);
      if (!sync.ok) {
        await run('wg-quick', ['down', iface]);
        const up = await run('wg-quick', ['up', iface], 30000);
        if (!up.ok) {
          return {
            ok: false,
            message: `热重载失败且重启失败: ${sync.stderr || up.stderr}`,
            egress,
            postUp,
            postDown,
          };
        }
        action = 'restart';
      } else {
        action = 'syncconf';
        // syncconf 不跑 PostUp
        if (forceExit || /MASQUERADE/i.test(postUp || config)) {
          await ensureIptables(iface, egress);
        }
      }
    } else {
      await run('wg-quick', ['down', iface]);
      const up = await run('wg-quick', ['up', iface], 30000);
      if (!up.ok) {
        return {
          ok: false,
          message: `重启失败: ${up.stderr || up.stdout}`,
          egress,
          postUp,
          postDown,
        };
      }
      action = 'restart';
    }
  } else {
    const up = await run('wg-quick', ['up', iface], 30000);
    if (!up.ok) {
      return {
        ok: false,
        message: `wg-quick up 失败: ${up.stderr || up.stdout}`,
        egress,
        confPath,
        postUp,
        postDown,
      };
    }
    action = 'up';
  }

  // 校验
  const live = await getInterfaceStatus(iface);
  const expected = Number(bundle.expectedPeers || 0);
  const livePeers = live.peers?.length || 0;
  const warnings = [];
  if (!live.up) {
    return {
      ok: false,
      message: '配置已写入但接口未运行',
      egress,
      confPath,
      postUp,
      postDown,
      action,
    };
  }
  if (expected > 0 && livePeers < expected) {
    warnings.push(`peer ${livePeers}/${expected}`);
  }
  if (Array.isArray(bundle.skippedClients) && bundle.skippedClients.length) {
    warnings.push(`跳过客户端: ${bundle.skippedClients.join(',')}`);
  }

  return {
    ok: true,
    message:
      (action === 'syncconf'
        ? `已热重载 ${iface}`
        : action === 'restart'
          ? `已重启 ${iface}`
          : `已启动 ${iface}`) + (warnings.length ? `（${warnings.join('; ')}）` : ''),
    egress,
    egressIface: egress,
    confPath,
    postUp,
    postDown,
    action,
    livePeers,
    expectedPeers: expected,
    warnings,
  };
}

async function collectStatus(ifaceName) {
  const iface = ifaceName || cachedIface || process.env.WG_IFACE || 'wg0';
  const local = loadLocalState();
  if (local.interfaceName) cachedIface = local.interfaceName;
  const useIface = local.interfaceName || iface;

  const ifaceStatus = await getInterfaceStatus(useIface);
  let forward = null;
  try {
    forward = fs.readFileSync('/proc/sys/net/ipv4/ip_forward', 'utf8').trim() === '1';
  } catch {
    forward = null;
  }
  const egress = await detectEgress();
  let natActive = false;
  const nat = await run('iptables', ['-t', 'nat', '-S', 'POSTROUTING']);
  if (nat.ok) natActive = /MASQUERADE|SNAT/i.test(nat.stdout);

  // 出网 IP 探测不要太勤：约 5 分钟一次
  let exitPublicIp = local.exitPublicIp || null;
  const lastProbe = local.exitIpAt || 0;
  if (Date.now() - lastProbe > 5 * 60 * 1000) {
    const ip = await detectPublicIp();
    if (ip) {
      exitPublicIp = ip;
      local.exitPublicIp = ip;
      local.exitIpAt = Date.now();
      saveLocalState(local);
    }
  }

  return {
    interface: ifaceStatus,
    interfaceName: useIface,
    forward,
    egressIface: egress,
    natActive,
    exitPublicIp,
    hostname: os.hostname(),
    time: new Date().toISOString(),
  };
}

async function handleJob(job) {
  console.log(`[wg-agent] 执行任务 ${job.type} (${job.id})`);
  if (job.type === 'apply' || job.type === 'exit') {
    const bundle = await request('GET', '/api/agent/bundle');
    if (bundle.server?.interfaceName) {
      cachedIface = bundle.server.interfaceName;
    }
    const result = await applyConfigBundle(bundle, { forceExit: job.type === 'exit' });
    return {
      ok: result.ok,
      message: result.message,
      detail: {
        egress: result.egress,
        egressIface: result.egressIface || result.egress,
        confPath: result.confPath,
        configHash: bundle.configHash,
        exit: job.type === 'exit',
        postUp: result.postUp || '',
        postDown: result.postDown || '',
        action: result.action,
        livePeers: result.livePeers,
        expectedPeers: result.expectedPeers,
        warnings: result.warnings || [],
      },
    };
  }
  if (job.type === 'ping') {
    return { ok: true, message: 'pong' };
  }
  return { ok: false, message: `未知任务类型: ${job.type}` };
}

async function tick() {
  const status = await collectStatus();
  const body = {
    hostname: os.hostname(),
    agentVersion: VERSION,
    meta: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      uptime: os.uptime(),
      iface: status.interfaceName,
    },
    status,
  };
  const res = await request('POST', '/api/agent/heartbeat', body);
  if (res.interfaceName) {
    cachedIface = res.interfaceName;
    const local = loadLocalState();
    local.interfaceName = res.interfaceName;
    saveLocalState(local);
  }
  const jobs = res.jobs || [];
  for (const job of jobs) {
    let result;
    try {
      result = await handleJob(job);
    } catch (err) {
      result = { ok: false, message: err.message };
    }
    try {
      await request('POST', '/api/agent/job-result', {
        jobId: job.id,
        ok: result.ok,
        message: result.message,
        detail: result.detail || null,
      });
      console.log(
        `[wg-agent] 任务结果 ${job.id}: ${result.ok ? 'ok' : 'fail'} ${result.message}`
      );
    } catch (err) {
      console.error('[wg-agent] 上报任务结果失败:', err.message);
    }
  }
}

async function main() {
  ensureDir(DATA_DIR);
  const local = loadLocalState();
  if (local.interfaceName) cachedIface = local.interfaceName;

  console.log(`[wg-agent] v${VERSION}`);
  console.log(`[wg-agent] 面板: ${PANEL_URL}`);
  console.log(`[wg-agent] 轮询: ${INTERVAL}s`);

  try {
    await request('POST', '/api/agent/hello', {
      hostname: os.hostname(),
      agentVersion: VERSION,
      name: process.env.WG_AGENT_NAME || '',
    });
    console.log('[wg-agent] 已连接面板');
  } catch (err) {
    console.error('[wg-agent] 连接面板失败:', err.message);
  }

  const loop = async () => {
    try {
      await tick();
    } catch (err) {
      console.error('[wg-agent] 轮询错误:', err.message);
    }
  };
  await loop();
  setInterval(loop, INTERVAL * 1000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
