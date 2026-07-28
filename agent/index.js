#!/usr/bin/env node
/**
 * Edge Agent v4.1.4 — mieru / mita 落地（支持多落地 + 流量/套餐）
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
const VERSION = '4.1.4';

const PANEL_URL = (process.env.WG_PANEL_URL || '').replace(/\/$/, '');
const TOKEN = process.env.WG_AGENT_TOKEN || '';
const INTERVAL = Math.max(5, Number(process.env.WG_AGENT_INTERVAL || 10));
const DATA_DIR = process.env.WG_AGENT_DATA || '/var/lib/wg-agent';
const STATE_FILE = path.join(DATA_DIR, 'agent-state.json');
const MITA_SCRIPT = process.env.MITA_INSTALL_SCRIPT || path.join(DATA_DIR, 'install-mita.sh');
const USAGE_EVERY_MS = Math.max(15, Number(process.env.WG_AGENT_USAGE_SEC || 30)) * 1000;

if (require.main === module && process.argv.includes('--self-test-usage')) {
  // self-test continues after function defs; flag only skips env check here
} else if (!PANEL_URL || !TOKEN) {
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

/** best-effort parse human sizes (mita ByteCountIEC: 938.1MiB / 4.0GiB / -) */
function parseSizeToBytes(s) {
  if (s == null) return 0;
  if (typeof s === 'number' && Number.isFinite(s)) return Math.round(s);
  const str = String(s).trim();
  if (!str || str === '-' || str === '—') return 0;
  if (/^\d+$/.test(str)) return Number(str);
  const m = str.match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB|K|M|G|T)?$/i);
  if (!m) {
    const m2 = str.match(/([\d.]+)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)/i);
    if (!m2) return 0;
    return parseSizeToBytes(m2[0]);
  }
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num)) return 0;
  let unit = (m[2] || 'B').toUpperCase();
  if (unit === 'K') unit = 'KIB';
  if (unit === 'M') unit = 'MIB';
  if (unit === 'G') unit = 'GIB';
  if (unit === 'T') unit = 'TIB';
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

function splitTableRow(line) {
  return String(line || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function findCol(headers, aliases) {
  const lower = headers.map((h) => String(h).toLowerCase());
  for (const a of aliases) {
    const i = lower.indexOf(String(a).toLowerCase());
    if (i >= 0) return i;
  }
  for (const a of aliases) {
    const key = String(a).toLowerCase();
    const i = lower.findIndex((h) => h.includes(key));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Parse `mita get users` table:
 * User LastActive 1DayDown 1DayUp 7DaysDown 7DaysUp 30DaysDown 30DaysUp
 * (older docs also use 1DayDownload / 30DaysDownload)
 */
function parseMitaUsersTable(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let headerIdx = -1;
  let headers = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^user\b/i.test(lines[i]) && /(down|download|up|upload)/i.test(lines[i])) {
      headers = splitTableRow(lines[i]);
      headerIdx = i;
      break;
    }
  }
  const users = [];
  if (headerIdx >= 0) {
    const iUser = findCol(headers, ['User', 'Name']) >= 0 ? findCol(headers, ['User', 'Name']) : 0;
    const i1dDown = findCol(headers, ['1DayDown', '1DayDownload', '1daydown']);
    const i1dUp = findCol(headers, ['1DayUp', '1DayUpload', '1dayup']);
    const i7dDown = findCol(headers, ['7DaysDown', '7DayDown', '7DaysDownload', '7DayDownload']);
    const i7dUp = findCol(headers, ['7DaysUp', '7DayUp', '7DaysUpload', '7DayUpload']);
    const i30dDown = findCol(headers, ['30DaysDown', '30DayDown', '30DaysDownload', '30DayDownload']);
    const i30dUp = findCol(headers, ['30DaysUp', '30DayUp', '30DaysUpload', '30DayUpload']);
    const iLast = findCol(headers, ['LastActive', 'LastActiveTime', 'Active']);

    for (let i = headerIdx + 1; i < lines.length; i++) {
      const parts = splitTableRow(lines[i]);
      if (parts.length < 2) continue;
      const name = parts[iUser] || parts[0];
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(name)) continue;
      if (/^(user|name|total|----|mita|days|limit|usage)$/i.test(name)) continue;
      const cell = (idx) => {
        if (idx < 0 || idx >= parts.length) return 0;
        return parseSizeToBytes(parts[idx]);
      };
      const day1DownloadBytes = cell(i1dDown);
      const day1UploadBytes = cell(i1dUp);
      const day7DownloadBytes = cell(i7dDown);
      const day7UploadBytes = cell(i7dUp);
      const day30DownloadBytes = cell(i30dDown);
      const day30UploadBytes = cell(i30dUp);
      // 展示默认用 30 天累计（刷视频会动）；没有 30 天列则回落 7/1 天
      const downloadBytes = day30DownloadBytes || day7DownloadBytes || day1DownloadBytes;
      const uploadBytes = day30UploadBytes || day7UploadBytes || day1UploadBytes;
      users.push({
        name: String(name),
        downloadBytes,
        uploadBytes,
        totalBytes: downloadBytes + uploadBytes,
        day1DownloadBytes,
        day1UploadBytes,
        day7DownloadBytes,
        day7UploadBytes,
        day30DownloadBytes,
        day30UploadBytes,
        lastActive: iLast >= 0 && parts[iLast] && parts[iLast] !== '-' ? parts[iLast] : null,
        raw: lines[i].slice(0, 240),
      });
    }
    if (users.length) return users;
  }

  // fallback: 宽松解析「名字 + 若干体积」
  for (const line of lines) {
    if (/^user\b/i.test(line) && /(down|download)/i.test(line)) continue;
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,31})\b(.*)$/);
    if (!m) continue;
    const name = m[1];
    if (/^(user|name|total|----|mita|days|limit|usage)$/i.test(name)) continue;
    const sizes = [...String(m[2]).matchAll(/([\d.]+)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB|B)\b/gi)].map((x) =>
      parseSizeToBytes(x[0])
    );
    if (!sizes.length) continue;
    // 常见列序：1dDown 1dUp 7dDown 7dUp 30dDown 30dUp
    let downloadBytes = 0;
    let uploadBytes = 0;
    if (sizes.length >= 6) {
      downloadBytes = sizes[4];
      uploadBytes = sizes[5];
    } else if (sizes.length >= 4) {
      downloadBytes = sizes[2];
      uploadBytes = sizes[3];
    } else if (sizes.length >= 2) {
      downloadBytes = sizes[0];
      uploadBytes = sizes[1];
    } else {
      downloadBytes = sizes[0];
    }
    users.push({
      name,
      downloadBytes,
      uploadBytes,
      totalBytes: downloadBytes + uploadBytes,
      day1DownloadBytes: sizes[0] || 0,
      day1UploadBytes: sizes[1] || 0,
      day30DownloadBytes: downloadBytes,
      day30UploadBytes: uploadBytes,
      raw: line.slice(0, 240),
    });
  }
  return users;
}

/** Parse `mita get quotas`: User Days Limit Usage */
function parseMitaQuotasTable(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out = [];
  let headerIdx = -1;
  let headers = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^user\b/i.test(lines[i]) && /days|limit|usage/i.test(lines[i])) {
      headers = splitTableRow(lines[i]);
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return out;
  const iUser = findCol(headers, ['User', 'Name']) >= 0 ? findCol(headers, ['User', 'Name']) : 0;
  const iDays = findCol(headers, ['Days', 'Day']);
  const iLimit = findCol(headers, ['Limit']);
  const iUsage = findCol(headers, ['Usage', 'Used']);
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const parts = splitTableRow(lines[i]);
    if (parts.length < 2) continue;
    const name = parts[iUser] || parts[0];
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(name)) continue;
    if (/^(user|name|days|limit|usage)$/i.test(name)) continue;
    const limitBytes = iLimit >= 0 ? parseSizeToBytes(parts[iLimit]) : 0;
    const usedBytes = iUsage >= 0 ? parseSizeToBytes(parts[iUsage]) : 0;
    const days = iDays >= 0 ? Number(parts[iDays]) || null : null;
    out.push({
      name: String(name),
      days,
      limitMB: limitBytes ? Math.round(limitBytes / (1024 * 1024)) : null,
      usedMB: usedBytes ? Math.round((usedBytes / (1024 * 1024)) * 10) / 10 : null,
      limitBytes,
      usedBytes,
    });
  }
  return out;
}

/**
 * Collect per-user usage via mita CLI (best-effort)
 * Official table columns: 1DayDown/1DayUp/7DaysDown/7DaysUp/30DaysDown/30DaysUp
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
    out.raw = (textU + '\n' + textQ).slice(0, 6000);
    out.usersOk = Boolean(usersR.ok);
    out.quotasOk = Boolean(quotasR.ok);

    // mita 输出是文本表，不是 JSON；先按表解析
    out.users = parseMitaUsersTable(textU);

    // 若有人强行打 JSON，再兼容
    if (!out.users.length) {
      try {
        const j = JSON.parse(usersR.stdout || '');
        const arr = Array.isArray(j) ? j : j.users || j.items || j.UserStats || [];
        if (Array.isArray(arr)) {
          for (const u of arr) {
            const name = u.name || u.Name || u.user || u.User || u?.user?.name;
            if (!name) continue;
            const downloadBytes = parseSizeToBytes(
              u.downloadBytes ??
                u.DownloadBytes ??
                u.day30DownloadBytes ??
                u['30DaysDown'] ??
                u.download ??
                u.Download ??
                0
            );
            const uploadBytes = parseSizeToBytes(
              u.uploadBytes ??
                u.UploadBytes ??
                u.day30UploadBytes ??
                u['30DaysUp'] ??
                u.upload ??
                u.Upload ??
                0
            );
            out.users.push({
              name: String(name),
              downloadBytes,
              uploadBytes,
              totalBytes: downloadBytes + uploadBytes,
            });
          }
        }
      } catch {
        /* not json */
      }
    }

    out.quotas = parseMitaQuotasTable(textQ);
    if (!out.quotas.length) {
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
        /* ignore */
      }
    }

    out.available = out.users.length > 0 || usersR.ok;
    if (usersR.ok && !out.users.length) {
      out.parseHint =
        'mita get users 有输出但未解析到用户行（请升级 Agent；落地执行 mita get users 对照）';
    }
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
  // mita 未装时 apply 必然失败，提前返回让上层走 OneClick 安装
  if (bin.includes('/') && !fs.existsSync(bin)) {
    const which = await run('sh', ['-c', 'command -v mita || true'], { timeout: 5000 });
    if (!which.ok || !which.stdout) {
      return { ok: false, message: 'mita 未安装', notInstalled: true };
    }
  }
  const tmp = path.join(DATA_DIR, `mita-apply-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(serverJson, null, 2), { mode: 0o600 });
  // 保留 stderr，便于面板展示真实失败原因
  const apply = await run(bin, ['apply', 'config', tmp], { timeout: 45000 });
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* */
  }
  if (!apply.ok) {
    const errText = (apply.stderr || apply.stdout || '').slice(0, 400);
    return {
      ok: false,
      message: `mita apply 失败: ${errText || 'unknown'}`,
      applyStderr: errText,
    };
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

  function buildCfg() {
    if (!bundle.serverConfig) return null;
    const cfg = JSON.parse(JSON.stringify(bundle.serverConfig));
    if (Array.isArray(cfg.users)) {
      cfg.users = cfg.users.filter(
        (u) => u?.name && u?.password && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(String(u.name))
      );
    }
    if (!cfg.users?.length) {
      cfg.users = users.map((u) => ({ name: u.name, password: u.password }));
    }
    return cfg;
  }

  // 1) mita 已装：优先 apply-full（多用户一次到位）
  let applyFailMsg = '';
  const cfg0 = buildCfg();
  if (cfg0 && st0.installed) {
    console.log(
      `[agent] apply mita full config users=${cfg0.users.map((u) => u.name).join(',')} port=${port}`
    );
    const ap = await applyMitaConfig(cfg0);
    if (ap.ok) {
      await openFirewall(port, protocol);
      const pkgNotes = await applyUserPackages(bundle.users, script);
      return {
        ok: true,
        message: `已同步 mita（${cfg0.users.length} 用户）· RUNNING`,
        detail: {
          action: 'apply-full',
          mita: ap.mita,
          configHash: bundle.configHash,
          users: cfg0.users.map((u) => u.name),
          packageNotes: pkgNotes,
        },
      };
    }
    applyFailMsg = ap.message || 'mita apply 失败';
    console.warn('[agent] apply-full 失败，回退 OneClick:', applyFailMsg);
  }

  // 2) OneClick 安装/重配（首装或 apply 失败兜底）
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
  const scriptTail = ((r.stdout || '') + '\n' + (r.stderr || '')).slice(-2000);

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

  // 3) 装完再尝试 apply-full，把全部用户一次写进 mita
  let secondApplyOk = false;
  let secondApplyMsg = '';
  const cfg1 = buildCfg();
  if (cfg1) {
    const stMid = await mitaStatus();
    if (stMid.installed) {
      const ap2 = await applyMitaConfig(cfg1);
      secondApplyOk = ap2.ok;
      secondApplyMsg = ap2.message || '';
      if (ap2.ok) {
        const pkgNotes = await applyUserPackages(bundle.users, script);
        const st = await mitaStatus();
        const via = applyFailMsg ? '（安装后 apply 成功）' : '';
        return {
          ok: true,
          message: `落地完成 · mita RUNNING · ${cfg1.users.length} 用户${via}`,
          detail: {
            action: applyFailMsg ? 'oneclick+apply-full' : 'apply-full',
            mita: st,
            configHash: bundle.configHash,
            users: cfg1.users.map((u) => u.name),
            packageNotes: pkgNotes,
            applyFailBefore: applyFailMsg || undefined,
            scriptOk: r.ok,
          },
        };
      }
    }
  }

  const pkgNotes = await applyUserPackages(bundle.users, script);
  const st = await mitaStatus();
  const ok = st.running || r.ok;

  // 成功：明确成功文案（不要「脚本异常…回退」类误导）
  // 失败：带上脚本尾部便于排查
  let message;
  if (ok && st.running) {
    if (applyFailMsg && r.ok) {
      message = `落地完成 · mita RUNNING · 用户 ${users.map((u) => u.name).join(',')}（OneClick 成功）`;
    } else if (r.ok) {
      message = `${action} 完成 · RUNNING · 用户 ${users.map((u) => u.name).join(',')}`;
    } else {
      // 脚本非 0 但 mita 已在跑：仍算成功
      message = `落地完成 · mita 已 RUNNING · 用户 ${users.map((u) => u.name).join(',')}`;
    }
  } else if (ok) {
    message = `${action} 完成 · 状态 ${st.status}`;
  } else {
    const tail = scriptTail.replace(/\s+/g, ' ').slice(-180);
    message = `落地失败 · ${st.status}${tail ? ' · ' + tail : ''}`;
  }

  return {
    ok,
    message,
    detail: {
      action,
      mita: st,
      configHash: bundle.configHash,
      scriptOk: r.ok,
      users: users.map((u) => u.name),
      packageNotes: pkgNotes,
      scriptTail,
      applyFailBefore: applyFailMsg || undefined,
      secondApplyOk: secondApplyOk || undefined,
      secondApplyMsg: secondApplyMsg || undefined,
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

if (require.main === module && process.argv.includes('--self-test-usage')) {
  const sample = `User  LastActive            1DayDown  1DayUp  7DaysDown  7DaysUp  30DaysDown  30DaysUp
u7af760  2026-07-29T01:02:03Z  938.1MiB  12.9MiB  2.1GiB     40.0MiB  4.0GiB      31.8MiB
123  -  10.0MiB  1.0MiB  10.0MiB  1.0MiB  10.0MiB  1.0MiB
`;
  const users = parseMitaUsersTable(sample);
  if (users.length < 2) {
    console.error('parse failed', users);
    process.exit(1);
  }
  const u = users.find((x) => x.name === 'u7af760');
  if (!u || u.downloadBytes < 4 * 1024 ** 3 * 0.9 || u.uploadBytes < 30 * 1024 ** 2) {
    console.error('expected 30d down/up', u);
    process.exit(1);
  }
  if (u.day1DownloadBytes < 900 * 1024 ** 2) {
    console.error('expected 1d down', u);
    process.exit(1);
  }
  console.log(
    'usage parse self-test ok',
    users.map((x) => ({ n: x.name, d: x.downloadBytes, u: x.uploadBytes }))
  );
  process.exit(0);
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

