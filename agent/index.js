#!/usr/bin/env node
/**
 * Edge Agent v4.0.0 — mieru / mita 落地（支持多落地 + 流量/套餐）
 * 连接中心面板，拉取任务：安装/应用 mita、上报状态与用量
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
const VERSION = '4.0.0';

const PANEL_URL = (process.env.WG_PANEL_URL || '').replace(/\/$/, '');
const TOKEN = process.env.WG_AGENT_TOKEN || '';
const INTERVAL = Math.max(5, Number(process.env.WG_AGENT_INTERVAL || 10));
const DATA_DIR = process.env.WG_AGENT_DATA || '/var/lib/wg-agent';
const STATE_FILE = path.join(DATA_DIR, 'agent-state.json');
const MITA_SCRIPT = process.env.MITA_INSTALL_SCRIPT || path.join(DATA_DIR, 'install-mita.sh');
const USAGE_EVERY_MS = Math.max(30, Number(process.env.WG_AGENT_USAGE_SEC || 60)) * 1000;

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
  const candidates = ['/usr/local/bin/mita', '/usr/bin/mita', 'mita'];
  for (const c of candidates) {
    if (c.includes('/') && fs.existsSync(c)) return c;
  }
  return 'mita';
}

async function mitaStatus() {
  const bin = findMitaBin();
  const st = await run(bin, ['status'], { timeout: 15000 });
  const text = `${st.stdout}\n${st.stderr}`;
  const running = /RUNNING/i.test(text);
  const idle = /IDLE/i.test(text);
  let listening = false;
  let listenPorts = [];
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

/** best-effort parse human sizes */
function parseSizeToBytes(s) {
  if (s == null) return 0;
  if (typeof s === 'number' && Number.isFinite(s)) return s;
  const str = String(s).trim();
  if (/^\d+$/.test(str)) return Number(str);
  const m = str.match(/([\d.]+)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)?/i);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  const unit = (m[2] || 'B').toUpperCase();
  const map = {
    B: 1,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4,
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
    TB: 1000 ** 4,
  };
  return Math.round(num * (map[unit] || 1));
}

/**
 * Collect per-user usage via mita CLI (best-effort, never throws to caller critically)
 */
async function collectUsage() {
  const bin = findMitaBin();
  const out = {
    collectedAt: new Date().toISOString(),
    users: [],
    quotas: [],
    source: 'mita-cli',
    available: false,
    raw: '',
  };
  try {
    const usersR = await run(bin, ['get', 'users'], { timeout: 20000 });
    const quotasR = await run(bin, ['get', 'quotas'], { timeout: 20000 });
    const textU = `${usersR.stdout || ''}\n${usersR.stderr || ''}`;
    const textQ = `${quotasR.stdout || ''}\n${quotasR.stderr || ''}`;
    out.raw = (textU + '\n' + textQ).slice(0, 4000);

    // try JSON
    try {
      const j = JSON.parse(usersR.stdout || '');
      const arr = Array.isArray(j) ? j : j.users || j.UserStats || [];
      if (Array.isArray(arr) && arr.length) {
        for (const u of arr) {
          const name = u.name || u.Name || u.user || u.User;
          if (!name) continue;
          const downloadBytes = parseSizeToBytes(
            u.downloadBytes ?? u.DownloadBytes ?? u.download ?? u.Download ?? 0
          );
          const uploadBytes = parseSizeToBytes(
            u.uploadBytes ?? u.UploadBytes ?? u.upload ?? u.Upload ?? 0
          );
          const totalBytes =
            parseSizeToBytes(u.totalBytes ?? u.TotalBytes ?? u.total ?? u.Total) ||
            downloadBytes + uploadBytes;
          out.users.push({ name: String(name), downloadBytes, uploadBytes, totalBytes });
        }
      }
    } catch {
      // text parse: lines with username and numbers
      for (const line of textU.split('\n')) {
        // e.g. "user xxx  download 1.2GiB upload 3.4MiB"
        const m = line.match(
          /(?:user[:\s]+)?([A-Za-z0-9._-]{1,32}).*?(?:down(?:load)?[:\s]+([\d.]+\s*\w+))?.*?(?:up(?:load)?[:\s]+([\d.]+\s*\w+))?/i
        );
        if (!m) continue;
        const name = m[1];
        if (/^(user|name|total|----|mita)/i.test(name)) continue;
        const downloadBytes = parseSizeToBytes(m[2] || 0);
        const uploadBytes = parseSizeToBytes(m[3] || 0);
        // simpler: any "name ... 123MiB"
        const sizes = [...line.matchAll(/([\d.]+)\s*(KiB|MiB|GiB|KB|MB|GB|B)/gi)].map((x) =>
          parseSizeToBytes(x[0])
        );
        let total = downloadBytes + uploadBytes;
        if (!total && sizes.length) total = sizes[sizes.length - 1];
        if (name && (total || downloadBytes || uploadBytes || /user/i.test(line))) {
          out.users.push({
            name,
            downloadBytes,
            uploadBytes,
            totalBytes: total,
            raw: line.slice(0, 200),
          });
        }
      }
    }

    try {
      const j = JSON.parse(quotasR.stdout || '');
      const arr = Array.isArray(j) ? j : j.quotas || [];
      for (const q of arr) {
        const name = q.name || q.Name || q.user;
        if (!name) continue;
        out.quotas.push({
          name: String(name),
          limitMB: q.limitMB ?? q.megabytes ?? q.limit ?? null,
          usedMB: q.usedMB ?? q.used ?? null,
          days: q.days ?? null,
          mode: q.mode || null,
        });
      }
    } catch {
      /* ignore text quotas */
    }

    out.available = out.users.length > 0 || usersR.ok;
  } catch (err) {
    out.error = err.message;
    out.available = false;
  }
  return out;
}

async function ensureInstallScript() {
  ensureDir(DATA_DIR);
  if (fs.existsSync(MITA_SCRIPT) && fs.statSync(MITA_SCRIPT).size > 1000) return MITA_SCRIPT;
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

async function applyUserPackages(users, script) {
  const notes = [];
  for (const u of users || []) {
    if (!u?.name || u.enabled === false) continue;
    const pkg = u.package || {};
    const quotaMb = Number(pkg.quotaMb) || 0;
    const quotaDays = Number(pkg.quotaDays) || 30;
    const quotaMode = pkg.quotaMode === 'calendar' ? 'calendar' : 'rolling';
    const expireAt = String(pkg.expireAt || '').trim();
    try {
      if (quotaMb > 0) {
        const r = await runShell(
          `bash ${JSON.stringify(script)} --user-set-quota -y --user ${JSON.stringify(u.name)} --quota-mb ${quotaMb} --quota-days ${quotaDays} --quota-mode ${quotaMode}`,
          { timeout: 60000 }
        );
        notes.push(`quota ${u.name}: ${r.ok ? 'ok' : 'fail'}`);
      }
      if (expireAt) {
        // accept ISO date → YYYY-MM-DD
        let exp = expireAt;
        if (/^\d{4}-\d{2}-\d{2}T/.test(expireAt)) exp = expireAt.slice(0, 10);
        const r = await runShell(
          `bash ${JSON.stringify(script)} --user-set-expire -y --user ${JSON.stringify(u.name)} --expire ${JSON.stringify(exp)}`,
          { timeout: 60000 }
        );
        notes.push(`expire ${u.name}: ${r.ok ? 'ok' : 'fail'}`);
      }
    } catch (e) {
      notes.push(`${u.name}: ${e.message}`);
    }
  }
  return notes;
}

async function installOrReconfigure(bundle) {
  const s = bundle.server || {};
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

  const st0 = await mitaStatus();
  const action = st0.installed && (st0.running || st0.idle || st0.ok) ? 'reconfigure' : 'install';

  if (bundle.serverConfig) {
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
      const pkgNotes = await applyUserPackages(bundle.users, script);
      return {
        ok: true,
        message: `已同步 mita（${cfg.users.length} 用户）· RUNNING`,
        detail: {
          action: 'apply-full',
          mita: ap.mita,
          configHash: bundle.configHash,
          users: cfg.users.map((u) => u.name),
          packageNotes: pkgNotes,
        },
      };
    }
    console.warn('[agent] apply-full 失败，回退 OneClick:', ap.message);
  }

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
  const pkgNotes = await applyUserPackages(bundle.users, script);
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
      packageNotes: pkgNotes,
      scriptTail: ((r.stdout || '') + '\n' + (r.stderr || '')).slice(-2000),
    },
  };
}

async function openFirewall(port, protocol) {
  const p = Number(port) || 7901;
  const proto = String(protocol || 'TCP').toLowerCase();
  await runShell(`ufw allow ${p}/${proto} 2>/dev/null || true`);
  await runShell(
    `firewall-cmd --permanent --add-port=${p}/${proto} 2>/dev/null && firewall-cmd --reload 2>/dev/null || true`
  );
  if (proto === 'tcp' || proto === 'both') {
    await runShell(
      `iptables -C INPUT -p tcp --dport ${p} -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport ${p} -j ACCEPT 2>/dev/null || true`
    );
  }
  if (proto === 'udp' || proto === 'both') {
    const up = proto === 'both' ? p + 1 : p;
    await runShell(
      `iptables -C INPUT -p udp --dport ${up} -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport ${up} -j ACCEPT 2>/dev/null || true`
    );
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

  const ss = await run('ss', ['-lntu']);
  if (ss.ok && local.listenPort) {
    const re = new RegExp(`:${local.listenPort}\\s`);
    mita.listening = re.test(ss.stdout);
  }

  let usage = local.lastUsage || null;
  const lastUsageAt = local.usageAt || 0;
  if (mita.installed && Date.now() - lastUsageAt > USAGE_EVERY_MS) {
    try {
      usage = await collectUsage();
      local.lastUsage = usage;
      local.usageAt = Date.now();
      saveLocalState(local);
    } catch (e) {
      usage = {
        available: false,
        error: e.message,
        collectedAt: new Date().toISOString(),
        users: [],
        quotas: [],
        source: 'mita-cli',
      };
    }
  }

  return {
    mita,
    protocol: 'mieru',
    egressIface: egress,
    exitPublicIp,
    hostname: os.hostname(),
    time: new Date().toISOString(),
    usage: usage || { available: false, users: [], quotas: [], source: 'mita-cli' },
  };
}

async function handleJob(job) {
  console.log(`[agent] 执行任务 ${job.type} (${job.id})`);
  if (
    job.type === 'apply' ||
    job.type === 'exit' ||
    job.type === 'mieru_install' ||
    job.type === 'mieru_apply'
  ) {
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
  console.log(`[agent] v${VERSION} (mieru multi-landing)`);
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
