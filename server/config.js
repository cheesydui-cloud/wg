const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.WG_DATA_DIR || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function defaultState() {
  return {
    version: 2,
    username: 'admin',
    passwordHash: null,
    passwordSalt: null,
    forcePasswordChange: false,
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    wizardDone: false,
    lastAppliedHash: null,
    lastAppliedAt: null,
    server: {
      interfaceName: 'wg0',
      listenPort: 51820,
      privateKey: '',
      publicKey: '',
      address: '10.8.0.1/24',
      endpoint: '',
      dns: '1.1.1.1',
      mtu: 1420,
      postUp: '',
      postDown: '',
      confPath: '/etc/wireguard/wg0.conf',
    },
    clients: [],
    nodes: [],
    settings: {
      theme: 'auto',
      language: 'zh',
    },
  };
}

function loadState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    const state = defaultState();
    saveState(state);
    return state;
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const base = defaultState();
    return {
      ...base,
      ...parsed,
      server: { ...base.server, ...(parsed.server || {}) },
      settings: { ...base.settings, ...(parsed.settings || {}) },
      clients: Array.isArray(parsed.clients) ? parsed.clients : [],
    };
  } catch (err) {
    console.error('读取状态失败，使用默认配置:', err.message);
    return defaultState();
  }
}

function saveState(state) {
  ensureDataDir();
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

const PORT = Number(process.env.WG_PORT || process.env.PORT || 51821);
const HOST = process.env.WG_HOST || '0.0.0.0';
const PASSWORD = process.env.WG_PASSWORD || '';
const USERNAME = process.env.WG_USERNAME || 'admin';
const WG_QUICK = process.env.WG_QUICK_BIN || 'wg-quick';
const WG_BIN = process.env.WG_BIN || 'wg';
const ALLOW_APPLY = process.env.WG_ALLOW_APPLY !== '0';
const FORCE_PASSWORD_CHANGE = process.env.WG_FORCE_PASSWORD_CHANGE === '1';

module.exports = {
  ROOT,
  DATA_DIR,
  STATE_FILE,
  SESSIONS_FILE,
  BACKUP_DIR,
  PORT,
  HOST,
  PASSWORD,
  USERNAME,
  WG_QUICK,
  WG_BIN,
  ALLOW_APPLY,
  FORCE_PASSWORD_CHANGE,
  loadState,
  saveState,
  defaultState,
  ensureDataDir,
};
