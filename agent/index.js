#!/usr/bin/env node
/**
 * Edge Agent v3.0.0 — mieru / mita 落地（美国家宽）
 * 连接中心面板，拉取任务：安装/应用 mita、上报状态
 *
 * 环境变量：
 *   WG_PANEL_URL       面板地址
 *   WG_AGENT_TOKEN     节点 token
 *   WG_AGENT_NAME      可选显示名
 *   WG_AGENT_INTERVAL  轮询秒数，默认 10
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { execFile, exec } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const VERSION = '3.0.0';

const PANEL_URL = (process.env.WG_PANEL_URL || '').replace(/\/$/, '');
const TOKEN = process.env.WG_AGENT_TOKEN || '';
const INTERVAL = Math.max(5, Number(process.env.WG_AGENT_INTERVAL || 10));
const DATA_DIR = process.env.WG_AGENT_DATA || '/var/lib/wg-agent';
const STATE_FILE = path.join(DATA_DIR, 'agent-state.json');
const MITA_SCRIPT = process.env.MITA_INSTALL_SCRIPT || path.join(DATA_DIR, 'install-mita.sh');

if (!PANEL_URL || !TOKEN) {
  console.error('[agent] 需要环境变量 WG_PANEL_URL 与 WG_AGENT_TOKEN');
  process.exit(1);
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

function loadLocalState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
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
          'User-Agent': `edge-agent/${VERSION}`,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
        timeout: 120000,
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

async function run(bin, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: opts.timeout || 60000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    });
    return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
  } catch (err) {
    return {
      ok: false,
      stdout: ((err.stdout || '') + '').trim(),
      stderr: ((err.stderr || '') + '').trim() || err.message,
    };
  }
}

async function runShell(cmd, opts = {}) {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: opts.timeout || 300000,
      maxBuffer: 12 * 1024 * 1024,
      shell: '/bin/bash',
      env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
    });
    return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
  } catch (err) {
    return {
      ok: false,
      stdout: ((err.stdout || '') + '').trim(),
      stderr: ((err.stderr || '') + '').trim() || err.message,
    };
  }
}

async function detectPublicIp() {
  const urls = ['https://ifconfig.me', 'https://api.ipify.org', 'https://icanhazip.com'];
  for (const url of urls) {
    try {
      const r = await run('curl', ['-fsS', '--max-time', '5', url], { timeout: 8000 });
      if (r.ok && r.stdout && /^[\d.a-fA-F:]+$/.test(r.stdout.trim())) return r.stdout.trim();
    } catch {
      /* next */
    }
  }
  return null;
}

async function detectEgress() {
  const r = await run('ip', ['route', 'show', 'default']);
  if (!r.ok) return '';
  const m = r.stdout.match(/dev\s+(\S+)/);
  return m ? m[1] : '';
}

function findMitaBin() {
  const candidates = ['mita', '/usr/bin/mita', '/usr/local/bin/mita'];
  for (const c of candidates) {
    try {
      if (c === 'mita') {
        // which
      }
      const p = c.includes('/') ? c : null;
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* */
    }
  }
  return 'mita';
}

async function mitaStatus() {
  const bin = findMitaBin();
  const st = await run(bin, ['status'], { timeout: 15000 });
  const text = `${st.stdout}\n${st.stderr}`;
  const running = /RUNNING/i.test(text);
  const idle = /IDLE/i.test(text);
  // 监听端口
  let listening = false;
  let listenPorts = [];
  const ss = await run('ss', ['-lntu']);
  if (ss.ok) {
    for (const line of ss.stdout.split('\n')) {
      const m = line.match(/:(\d+)\s/);
      if (m && /LISTEN|UNCONN/i.test(line)) {
        // 粗略：后面用配置端口比对
      }
    }
  }
  let version = '';
  const ver = await run(bin, ['version'], { timeout: 8000 });
  if (ver.ok) version = ver.stdout.split('\n')[0] || '';

  return {
    ok: st.ok || running || idle,
    status: running ? 'RUNNING' : idle ? 'IDLE' : st.ok ? text.slice(0, 80) : 'NOT_INSTALLED',
    running,
    idle,
    listening,
    listenPorts,
    version,
    raw: text.slice(0, 2000),
    installed: st.ok || running || idle || !/not found|No such file/i.test(text),
  };
}

async function ensureInstallScript() {
  ensureDir(DATA_DIR);
  if (fs.existsSync(MITA_SCRIPT) && fs.statSync(MITA_SCRIPT).size > 1000) return MITA_SCRIPT;
  // 从面板拉取
  try {
    const u = new URL('/install-mita.sh', PANEL_URL);
    const lib = u.protocol === 'https:' ? https : http;
    await new Promise((resolve, reject) => {
      const req = lib.get(u, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`下载 install-mita.sh HTTP ${res.statusCode}`));
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          fs.writeFileSync(MITA_SCRIPT, Buffer.concat(chunks), { mode: 0o755 });
          resolve();
        });
      });
      req.on('error', reject);
    });
    return MITA_SCRIPT;
  } catch (err) {
    throw new Error(`无法获取 install-mita.sh: ${err.message}`);
  }
}

async function applyMitaConfig(serverJson) {
  const bin = findMitaBin();
  const tmp = path.join(DATA_DIR, `mita-apply-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(serverJson, null, 2), { mode: 0o600 });
  const apply = await run(bin, ['apply', 'config', tmp], { timeout: 30000 });
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* */
  }
  if (!apply.ok) {
    return { ok: false, message: `mita apply 失败: ${apply.stderr || apply.stdout}` };
  }
  // reload 或 start
  let start = await run(bin, ['reload'], { timeout: 20000 });
  if (!start.ok) {
    await run(bin, ['stop'], { timeout: 15000 });
    start = await run(bin, ['start'], { timeout: 30000 });
  }
  const st = await mitaStatus();
  return {
    ok: st.running || start.ok,
    message: st.running ? 'mita 配置已应用并 RUNNING' : `apply 完成但状态: ${st.status}`,
    mita: st,
  };
}

async function installOrReconfigure(bundle) {
  const s = bundle.server || {};
  // 只同步合法 ASCII 用户名（中文备注不能进 mita）
  const users = (bundle.users || []).filter(
    (u) =>
      u.enabled !== false &&
      u.name &&
      u.password &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(String(u.name))
  );
  if (!users.length) {
    return {
      ok: false,
      message: '没有合法 mita 用户（用户名须英文/数字，不能用「我的手机」）',
    };
  }

  const primary = users[0];
  const port = Number(s.listenPort) || 7901;
  const protocol = String(s.protocol || 'TCP').toUpperCase();
  const script = await ensureInstallScript();

  // 是否已安装 mita
  const st0 = await mitaStatus();
  const action = st0.installed && (st0.running || st0.idle || st0.ok) ? 'reconfigure' : 'install';

  // 1) 优先：官方 mita apply 全量配置（所有用户一次写对）
  if (bundle.serverConfig) {
    // 过滤 serverConfig 里的非法用户
    const cfg = JSON.parse(JSON.stringify(bundle.serverConfig));
    if (Array.isArray(cfg.users)) {
      cfg.users = cfg.users.filter(
        (u) => u?.name && u?.password && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(String(u.name))
      );
    }
    if (!cfg.users?.length) {
      cfg.users = users.map((u) => ({ name: u.name, password: u.password }));
    }
    console.log(
      `[agent] apply mita full config users=${cfg.users.map((u) => u.name).join(',')} port=${port}`
    );
    const ap = await applyMitaConfig(cfg);
    if (ap.ok) {
      await openFirewall(port, protocol);
      return {
        ok: true,
        message: `已同步 mita（${cfg.users.length} 用户）· RUNNING`,
        detail: {
          action: 'apply-full',
          mita: ap.mita,
          configHash: bundle.configHash,
          users: cfg.users.map((u) => u.name),
        },
      };
    }
    console.warn('[agent] apply-full 失败，回退 OneClick:', ap.message);
  }

  // 2) 回退：OneClick 装/重配主用户
  const args = [
    script,
    action === 'install' ? '--install' : '--reconfigure',
    '-y',
    '--port',
    String(port),
    '--protocol',
    protocol === 'UDP' || protocol === 'BOTH' ? protocol : 'TCP',
    '--user',
    primary.name,
    '--password',
    primary.password,
  ];

  console.log(`[agent] ${action} mita port=${port} proto=${protocol} user=${primary.name}`);
  const r = await runShell(`bash ${args.map((a) => JSON.stringify(a)).join(' ')}`, {
    timeout: 600000,
  });

  if (users.length > 1 && (r.ok || (await mitaStatus()).installed)) {
    for (let i = 1; i < users.length; i++) {
      const u = users[i];
      await runShell(
        `bash ${JSON.stringify(script)} --user-add -y --user ${JSON.stringify(u.name)} --password ${JSON.stringify(u.password)}`,
        { timeout: 120000 }
      );
    }
  }

  await openFirewall(port, protocol);
  const st = await mitaStatus();
  return {
    ok: st.running || r.ok,
    message: st.running
      ? `${action} 完成 · RUNNING · 用户 ${users.map((u) => u.name).join(',')}`
      : `${action} · ${st.status}`,
    detail: {
      action,
      mita: st,
      configHash: bundle.configHash,
      scriptOk: r.ok,
      users: users.map((u) => u.name),
      scriptTail: ((r.stdout || '') + '\n' + (r.stderr || '')).slice(-2000),
    },
  };
}

async function openFirewall(port, protocol) {
  const p = Number(port) || 7901;
  const proto = String(protocol || 'TCP').toLowerCase();
  // 尽力放行，失败不致命
  await runShell(`ufw allow ${p}/${proto} 2>/dev/null || true`);
  await runShell(
    `firewall-cmd --permanent --add-port=${p}/${proto} 2>/dev/null && firewall-cmd --reload 2>/dev/null || true`
  );
  if (proto === 'tcp' || proto === 'both') {
    await runShell(`iptables -C INPUT -p tcp --dport ${p} -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport ${p} -j ACCEPT 2>/dev/null || true`);
  }
  if (proto === 'udp' || proto === 'both') {
    const up = proto === 'both' ? p + 1 : p;
    await runShell(`iptables -C INPUT -p udp --dport ${up} -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport ${up} -j ACCEPT 2>/dev/null || true`);
  }
}

async function collectStatus() {
  const local = loadLocalState();
  const mita = await mitaStatus();
  const egress = await detectEgress();

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

  // 端口是否在听
  const ss = await run('ss', ['-lntu']);
  if (ss.ok && local.listenPort) {
    const re = new RegExp(`:${local.listenPort}\\s`);
    mita.listening = re.test(ss.stdout);
  }

  return {
    mita,
    protocol: 'mieru',
    egressIface: egress,
    exitPublicIp,
    hostname: os.hostname(),
    time: new Date().toISOString(),
  };
}

async function handleJob(job) {
  console.log(`[agent] 执行任务 ${job.type} (${job.id})`);
  if (job.type === 'apply' || job.type === 'exit' || job.type === 'mieru_install' || job.type === 'mieru_apply') {
    const bundle = await request('GET', '/api/agent/bundle');
    const local = loadLocalState();
    if (bundle.server?.listenPort) {
      local.listenPort = bundle.server.listenPort;
      saveLocalState(local);
    }
    if (job.type === 'exit' || job.type === 'mieru_install') {
      await openFirewall(bundle.server?.listenPort, bundle.server?.protocol);
    }
    const result = await installOrReconfigure(bundle);
    return {
      ok: result.ok,
      message: result.message,
      detail: {
        ...(result.detail || {}),
        configHash: bundle.configHash,
        exit: job.type === 'exit' || job.type === 'mieru_install',
      },
    };
  }
  if (job.type === 'ping') return { ok: true, message: 'pong' };
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
      protocol: 'mieru',
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
      console.log(`[agent] 任务结果 ${job.id}: ${result.ok ? 'ok' : 'fail'} ${result.message}`);
    } catch (err) {
      console.error('[agent] 上报失败:', err.message);
    }
  }
}

async function main() {
  ensureDir(DATA_DIR);
  console.log(`[agent] v${VERSION} (mieru)`);
  console.log(`[agent] 面板: ${PANEL_URL}`);
  console.log(`[agent] 轮询: ${INTERVAL}s`);

  try {
    await request('POST', '/api/agent/hello', {
      hostname: os.hostname(),
      agentVersion: VERSION,
      name: process.env.WG_AGENT_NAME || '',
    });
    console.log('[agent] 已连接面板');
  } catch (err) {
    console.error('[agent] 连接面板失败:', err.message);
  }

  // 预拉 install 脚本
  try {
    await ensureInstallScript();
    console.log('[agent] install-mita.sh 就绪');
  } catch (err) {
    console.warn('[agent] 预拉脚本失败（首次落地时再试）:', err.message);
  }

  const loop = async () => {
    try {
      await tick();
    } catch (err) {
      console.error('[agent] 轮询错误:', err.message);
    }
  };
  await loop();
  setInterval(loop, INTERVAL * 1000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
