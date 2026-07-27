#!/usr/bin/env node
/**
 * 重置面板登录密码（不依赖浏览器）
 *
 * 用法：
 *   sudo node /opt/wg-panel/scripts/reset-password.js '你的新密码'
 *   sudo node scripts/reset-password.js --user admin '你的新密码'
 *   sudo WG_DATA_DIR=/opt/wg-panel/data node scripts/reset-password.js '你的新密码'
 *
 * 或通过 install.sh：
 *   sudo bash install.sh --reset-password '你的新密码'
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function usage(code = 0) {
  console.log(`用法:
  sudo node scripts/reset-password.js [选项] <新密码>

选项:
  --user <name>     登录用户名（默认 admin 或沿用现有）
  --data-dir <dir>  state.json 所在目录（默认 /opt/wg-panel/data 或 WG_DATA_DIR）
  --restart         重置后 systemctl restart wg-panel
  -h, --help        帮助
`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { user: null, dataDir: null, restart: false, password: null };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage(0);
    if (a === '--restart') {
      out.restart = true;
      continue;
    }
    if (a === '--user') {
      out.user = args[++i];
      continue;
    }
    if (a === '--data-dir') {
      out.dataDir = args[++i];
      continue;
    }
    if (a.startsWith('-')) {
      console.error('未知参数:', a);
      usage(1);
    }
    if (out.password == null) out.password = a;
    else {
      console.error('多余参数:', a);
      usage(1);
    }
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv);
  const pass = opts.password || process.env.WG_PASSWORD || '';
  if (!pass || String(pass).length < 6) {
    console.error('错误: 密码至少 6 位');
    usage(1);
  }

  const dataDir =
    opts.dataDir ||
    process.env.WG_DATA_DIR ||
    (fs.existsSync('/opt/wg-panel/data/state.json')
      ? '/opt/wg-panel/data'
      : path.join(__dirname, '..', 'data'));
  const stateFile = path.join(dataDir, 'state.json');

  if (!fs.existsSync(stateFile)) {
    console.error('找不到 state.json:', stateFile);
    console.error('请确认面板已安装，或指定 --data-dir');
    process.exit(1);
  }

  const raw = fs.readFileSync(stateFile, 'utf8');
  const state = JSON.parse(raw);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pass), salt, 64).toString('hex');
  const username = String(opts.user || state.username || 'admin').trim() || 'admin';

  // 备份
  const bak = `${stateFile}.bak-password-${Date.now()}`;
  fs.copyFileSync(stateFile, bak);

  state.username = username;
  state.passwordSalt = salt;
  state.passwordHash = hash;
  state.forcePasswordChange = false;

  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

  // 写一份明文凭据，方便找回（权限 600）
  const cred = path.join(dataDir, 'initial-credentials.txt');
  fs.writeFileSync(
    cred,
    [
      `username=${username}`,
      `password=${pass}`,
      `updated_at=${new Date().toISOString()}`,
      `note=由 scripts/reset-password.js 写入`,
      '',
    ].join('\n'),
    { mode: 0o600 }
  );

  console.log('========================================');
  console.log(' 面板登录密码已重置');
  console.log(` 用户名: ${username}`);
  console.log(` 密  码: ${pass}`);
  console.log(` 数据文件: ${stateFile}`);
  console.log(` 备份: ${bak}`);
  console.log(` 凭据副本: ${cred}`);
  console.log('========================================');

  if (opts.restart) {
    const { execSync } = require('child_process');
    try {
      execSync('systemctl restart wg-panel', { stdio: 'inherit' });
      console.log('已重启 wg-panel');
      // 等服务起来再自检
      try {
        execSync('sleep 1');
      } catch {
        /* ignore */
      }
    } catch (e) {
      console.error('重启失败，请手动: systemctl restart wg-panel');
      process.exit(1);
    }
  } else {
    console.log('请执行: systemctl restart wg-panel');
  }

  // 本机自检（同步）
  try {
    const bodyPath = path.join(dataDir, '.login-check-body.json');
    fs.writeFileSync(bodyPath, JSON.stringify({ username, password: pass }), { mode: 0o600 });
    const port = Number(process.env.WG_PORT || 51821);
    const result = require('child_process').execSync(
      `curl -s -o /tmp/wg-login-check.json -w "%{http_code}" -X POST http://127.0.0.1:${port}/api/login -H 'Content-Type: application/json' --data-binary @${bodyPath}`,
      { encoding: 'utf8', timeout: 8000 }
    );
    try {
      fs.unlinkSync(bodyPath);
    } catch {
      /* ignore */
    }
    const code = String(result).trim();
    let text = '';
    try {
      text = fs.readFileSync('/tmp/wg-login-check.json', 'utf8');
    } catch {
      /* ignore */
    }
    if (code === '200' && /"ok"\s*:\s*true/.test(text)) {
      console.log('自检登录: 成功');
    } else {
      console.log('自检登录: 未通过 HTTP', code, text.slice(0, 200));
      console.log('若未 --restart，请先: systemctl restart wg-panel');
    }
  } catch (e) {
    console.log('自检跳过:', e.message || e);
  }
}

main();
