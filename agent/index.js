#!/usr/bin/env node
/**
 * WG Panel Edge Agent
 * 连接中心面板，拉取任务：应用配置 / 一键落地 / 上报状态
 *
 * 环境变量：
 *   WG_PANEL_URL     面板地址，如 http://1.2.3.4:51821
 *   WG_AGENT_TOKEN   节点 token
 *   WG_AGENT_NAME    可选显示名
 *   WG_AGENT_INTERVAL  轮询秒数，默认 10
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const VERSION = '1.3.0';

const PANEL_URL = (process.env.WG_PANEL_URL || '').replace(/\/$/, '');
const TOKEN = process.env.WG_AGENT_TOKEN || '';
const INTERVAL = Math.max(5, Number(process.env.WG_AGENT_INTERVAL || 10));
const DATA_DIR = process.env.WG_AGENT_DATA || '/var/lib/wg-agent';
const CONF_FALLBACK = '/etc/wireguard/wg0.conf';

if (!PANEL_URL || !TOKEN) {
  console.error('[wg-agent] 需要环境变量 WG_PANEL_URL 与 WG_AGENT_TOKEN');
  process.exit(1);
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
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

function parseWgShow(raw) {
  const peers = [];
  let current = null;
  let ifaceUp = false;
  for (const line of String(raw || '').split('\n')) {
    if (line.startsWith('interface:')) {
      ifaceUp = true;
      continue;
    }
    if (line.startsWith('peer:')) {
      if (current) peers.push(current);
      current = {
        publicKey: line.replace('peer:', '').trim(),
        online: false,
        latestHandshake: '',
        transfer: '',
        endpoint: '',
      };
      continue;
    }
    if (!current) continue;
    const t = line.trim();
    if (t.startsWith('endpoint:')) current.endpoint = t.slice(9).trim();
    if (t.startsWith('latest handshake:')) {
      current.latestHandshake = t.slice(17).trim();
      // rough: if handshake text exists and not "never", treat online if seconds-like recent — panel already has logic; here mark if not empty
      current.online = !/never/i.test(current.latestHandshake);
    }
    if (t.startsWith('transfer:')) current.transfer = t.slice(9).trim();
  }
  if (current) peers.push(current);
  return { up: ifaceUp, peers };
}

async function getInterfaceStatus(name) {
  const r = await run('wg', ['show', name]);
  if (!r.ok && /Unable to access|No such device|does not exist/i.test(r.stderr + r.stdout)) {
    return { up: false, peers: [], raw: r.stderr || r.stdout };
  }
  if (!r.ok) return { up: false, peers: [], raw: r.stderr || r.stdout };
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
  // insert after PrivateKey if missing
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

async function applyConfigBundle(bundle, { forceExit = false } = {}) {
  const iface = bundle.server?.interfaceName || 'wg0';
  let confPath = bundle.server?.confPath || CONF_FALLBACK;
  let config = bundle.config;
  let egress = await detectEgress();

  if (forceExit) {
    enableForward();
    const postUp = defaultPostUp(iface, egress);
    const postDown = defaultPostDown(iface, egress);
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

  // up or sync
  const show = await run('wg', ['show', iface]);
  const isUp = show.ok && !/Unable to access|No such device|does not exist/i.test(show.stderr + show.stdout);

  if (isUp) {
    const strip = await run('wg-quick', ['strip', iface]);
    if (strip.ok) {
      const stripped = path.join(DATA_DIR, `${iface}.stripped.conf`);
      fs.writeFileSync(stripped, strip.stdout + '\n', { mode: 0o600 });
      const sync = await run('wg', ['syncconf', iface, stripped]);
      if (!sync.ok) {
        // fallback restart
        await run('wg-quick', ['down', iface]);
        const up = await run('wg-quick', ['up', iface], 30000);
        if (!up.ok) {
          return {
            ok: false,
            message: `热重载失败且重启失败: ${sync.stderr || up.stderr}`,
            egress,
          };
        }
        return { ok: true, message: `已重启 ${iface}`, egress, confPath };
      }
      // re-run PostUp is not done by syncconf — if forceExit, try ensure forward + iptables quickly
      if (forceExit) {
        enableForward();
        await run('iptables', ['-C', 'FORWARD', '-i', iface, '-j', 'ACCEPT']).then(async (c) => {
          if (!c.ok) await run('iptables', ['-A', 'FORWARD', '-i', iface, '-j', 'ACCEPT']);
        });
        await run('iptables', ['-C', 'FORWARD', '-o', iface, '-j', 'ACCEPT']).then(async (c) => {
          if (!c.ok) await run('iptables', ['-A', 'FORWARD', '-o', iface, '-j', 'ACCEPT']);
        });
        await run('iptables', [
          '-t',
          'nat',
          '-C',
          'POSTROUTING',
          '-o',
          egress,
          '-j',
          'MASQUERADE',
        ]).then(async (c) => {
          if (!c.ok) {
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
        });
      }
      return { ok: true, message: `已热重载 ${iface}`, egress, confPath };
    }
    await run('wg-quick', ['down', iface]);
  }

  const up = await run('wg-quick', ['up', iface], 30000);
  if (!up.ok) {
    return {
      ok: false,
      message: `wg-quick up 失败: ${up.stderr || up.stdout}`,
      egress,
      confPath,
      config,
    };
  }
  return { ok: true, message: `已启动 ${iface}`, egress, confPath };
}

async function collectStatus() {
  const iface = process.env.WG_IFACE || 'wg0';
  const ifaceStatus = await getInterfaceStatus(iface);
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

  return {
    interface: ifaceStatus,
    forward,
    egressIface: egress,
    natActive,
    hostname: os.hostname(),
    time: new Date().toISOString(),
  };
}

async function handleJob(job) {
  console.log(`[wg-agent] 执行任务 ${job.type} (${job.id})`);
  if (job.type === 'apply' || job.type === 'exit') {
    // fetch full bundle
    const bundle = await request('GET', '/api/agent/bundle');
    const result = await applyConfigBundle(bundle, { forceExit: job.type === 'exit' });
    return {
      ok: result.ok,
      message: result.message,
      detail: {
        egress: result.egress,
        confPath: result.confPath,
        configHash: bundle.configHash,
        exit: job.type === 'exit',
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
    },
    status,
  };
  const res = await request('POST', '/api/agent/heartbeat', body);
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
      console.log(`[wg-agent] 任务结果 ${job.id}: ${result.ok ? 'ok' : 'fail'} ${result.message}`);
    } catch (err) {
      console.error('[wg-agent] 上报任务结果失败:', err.message);
    }
  }
}

async function main() {
  ensureDir(DATA_DIR);
  console.log(`[wg-agent] v${VERSION}`);
  console.log(`[wg-agent] 面板: ${PANEL_URL}`);
  console.log(`[wg-agent] 轮询: ${INTERVAL}s`);

  // register / first hello
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
