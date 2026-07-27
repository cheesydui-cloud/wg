const app = document.getElementById('app');

const state = {
  status: null,
  server: null,
  clients: [],
  page: 'dashboard',
  wizardStep: 1,
  wizardDone: false,
  modal: null,
  _skipWizardOnce: false,
  dirty: false,
  lastAppliedAt: null,
  preflight: null,
  mode: 'local',
  primaryNode: null,
  primaryNodeId: null,
  diagnose: null,
  exitOverview: null,
  installCommand: null,
};

async function api(path, options = {}) {
  const opts = {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  };
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  const ct = res.headers.get('content-type') || '';
  let data = null;
  if (ct.includes('application/json')) data = await res.json();
  else data = await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || res.statusText || '请求失败');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(msg, type = 'ok') {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = el('<div class="toast-wrap"></div>');
    document.body.appendChild(wrap);
  }
  const t = el(`<div class="toast ${type}">${esc(msg)}</div>`);
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 3600);
}

async function copyText(text) {
  const value = String(text ?? '');
  if (!value) throw new Error('没有可复制的内容');
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      /* fallback */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  if (!ok) throw new Error('复制失败，请手动选中文本复制');
  return true;
}

function help(tip) {
  return `<span class="help" tabindex="0" data-tip="${esc(tip)}">?</span>`;
}

function fmtTime(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('zh-CN');
  } catch {
    return iso;
  }
}

function networkFromAddress(addr) {
  if (!addr || !addr.includes('/')) return '10.8.0.0/24';
  const [ip, prefix] = addr.split('/');
  const parts = ip.split('.').map(Number);
  const p = Number(prefix);
  if (p >= 24) return `${parts[0]}.${parts[1]}.${parts[2]}.0/${p}`;
  return addr;
}

function val(id) {
  return document.getElementById(id)?.value?.trim() ?? '';
}

function isAgentMode() {
  return (state.mode || state.status?.mode) === 'agent';
}

function exitLabel() {
  if (isAgentMode()) {
    const n = state.primaryNode || state.status?.primaryNode;
    const online = n?.online;
    const name = n?.name || '落地机';
    return `远程落地 · ${name}${online ? ' · 在线' : ' · 离线'}`;
  }
  return '本机出口（面板这台机器）';
}

function splitEndpoint(ep, fallbackPort) {
  const raw = String(ep || '').trim();
  const portDef = Number(fallbackPort) || 7901;
  if (!raw) return { host: '', port: portDef };
  const m6 = raw.match(/^\[([^\]]+)\]:(\d+)$/);
  if (m6) return { host: m6[1], port: Number(m6[2]) || portDef };
  const idx = raw.lastIndexOf(':');
  if (idx > 0) {
    const maybe = Number(raw.slice(idx + 1));
    if (!Number.isNaN(maybe) && maybe >= 1 && maybe <= 65535) {
      return { host: raw.slice(0, idx), port: maybe };
    }
  }
  return { host: raw, port: portDef };
}

function joinEndpoint(host, port) {
  const h = String(host || '').trim();
  if (!h) return '';
  const p = Number(port) || 0;
  if (!p) return h;
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]:${p}`;
  return `${h}:${p}`;
}

function topAlerts() {
  const parts = [];
  if (state.status?.forcePasswordChange) {
    parts.push(`<div class="alert warn">
      <div><strong>请修改初始密码</strong> · 当前仍在使用安装时的随机密码</div>
      <button class="btn btn-sm btn-primary" data-nav-jump="settings">去修改</button>
    </div>`);
  }
  if (isAgentMode() && state.primaryNode && !state.primaryNode.online) {
    parts.push(`<div class="alert warn">
      <div><strong>落地 Agent 离线</strong> · 应用/落地不会执行，手机也无法真正连上出口</div>
      <button class="btn btn-sm btn-primary" data-nav-jump="server">去安装/检查</button>
    </div>`);
  }
  const job = state.primaryNode?.latestJob || state.latestJob;
  if (job && (job.status === 'pending' || job.status === 'running')) {
    parts.push(`<div class="alert warn">
      <div><strong>任务执行中</strong> · ${esc(job.type === 'exit' ? '一键落地' : '应用配置')}（${esc(
      job.status
    )}）· Agent 约每 10 秒拉取</div>
      <button class="btn btn-sm btn-ghost" id="banner-poll">刷新状态</button>
    </div>`);
  } else if (job && (job.status === 'error' || job.status === 'failed')) {
    parts.push(`<div class="alert danger">
      <div><strong>最近任务失败</strong> · ${esc(job.message || job.type || '')}</div>
      <button class="btn btn-sm btn-primary" data-nav-jump="diagnose">看诊断</button>
    </div>`);
  }
  if (state.clientsNeedRescan) {
    parts.push(`<div class="alert warn">
      <div><strong>Endpoint 已变更 · 必须重扫</strong> · 手机旧隧道不会自动更新地址</div>
      <div class="btn-row">
        <button class="btn btn-sm btn-primary" data-nav-jump="clients">去扫码</button>
        <button class="btn btn-sm btn-ghost" id="banner-rescan-ack">我已全部重扫</button>
      </div>
    </div>`);
  }
  if (state.dirty) {
    parts.push(`<div class="alert warn">
      <div><strong>有未应用的更改</strong> · ${
        isAgentMode()
          ? '服务端配置已改，需下发到落地机（只改 Endpoint 不会出现此项）'
          : '服务端配置已改，需写入本机 WireGuard'
      }</div>
      <div class="btn-row">
        <button class="btn btn-sm btn-ghost" id="banner-diagnose">诊断</button>
        <button class="btn btn-sm btn-success" id="banner-apply">应用配置</button>
      </div>
    </div>`);
  }
  return parts.join('');
}

function bindTopAlerts() {
  document.getElementById('banner-apply')?.addEventListener('click', () => applyConfig(true));
  document.getElementById('banner-diagnose')?.addEventListener('click', () => {
    state.page = 'diagnose';
    render();
  });
  document.getElementById('banner-poll')?.addEventListener('click', async () => {
    await refreshCore().catch(() => {});
    render();
  });
  document.getElementById('banner-rescan-ack')?.addEventListener('click', async () => {
    try {
      await api('/api/clients/rescan-ack', { method: 'POST', body: {} });
      state.clientsNeedRescan = false;
      toast('已确认重扫');
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  document.querySelectorAll('[data-nav-jump]').forEach((b) => {
    b.onclick = () => {
      state.page = b.dataset.navJump;
      render();
    };
  });
}

function renderBoot(msg = '正在加载…') {
  app.innerHTML = `
    <div class="boot-screen">
      <div class="boot-card">
        <div class="logo">WG</div>
        <h1>WireGuard 面板</h1>
        <p class="muted">${esc(msg)}</p>
      </div>
    </div>`;
}

function renderSetup() {
  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="logo">WG</div>
        <h1>初始化面板</h1>
        <p class="muted">设置管理员账号。面板可单独部署，真正出口在落地机上。</p>
        <label>用户名</label>
        <input class="field" id="su-user" value="admin" />
        <label>密码（至少 6 位）</label>
        <input class="field" id="su-pass" type="password" placeholder="设置密码" />
        <button class="btn btn-primary btn-block" id="su-go">完成初始化</button>
      </div>
    </div>`;
  document.getElementById('su-go').onclick = async () => {
    try {
      await api('/api/setup', {
        method: 'POST',
        body: { username: val('su-user'), password: val('su-pass') },
      });
      toast('初始化成功');
      await boot();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
}

function renderLogin() {
  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="logo">WG</div>
        <h1>登录</h1>
        <p class="muted">WireGuard 出口管理面板 v${esc(state.status?.version || '')}</p>
        <label>用户名</label>
        <input class="field" id="li-user" value="${esc(state.status?.defaultUsername || 'admin')}" />
        <label>密码</label>
        <input class="field" id="li-pass" type="password" placeholder="密码" />
        <button class="btn btn-primary btn-block" id="li-go">登录</button>
      </div>
    </div>`;
  const go = async () => {
    try {
      await api('/api/login', {
        method: 'POST',
        body: { username: val('li-user'), password: val('li-pass') },
      });
      await boot();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  document.getElementById('li-go').onclick = go;
  document.getElementById('li-pass').onkeydown = (e) => e.key === 'Enter' && go();
}

function shell(content) {
  const nav = [
    ['dashboard', '概览', '◈'],
    ['server', '出口服务器', '◎'],
    ['clients', '客户端', '◉'],
    ['diagnose', '诊断', '✎'],
    ['settings', '设置', '⚙'],
  ];
  return `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand"><div class="logo sm">WG</div><div>
          <div class="brand-title">WG 面板</div>
          <div class="brand-sub">v${esc(state.status?.version || '')}</div>
        </div></div>
        <nav class="nav">
          ${nav
            .map(
              ([id, label, ico]) => `
            <button class="nav-btn ${state.page === id ? 'active' : ''}" data-nav="${id}">
              <span class="nav-ico">${ico}</span>
              <span class="nav-label">${label}</span>
            </button>`
            )
            .join('')}
        </nav>
        <div class="sidebar-footer">
          <div class="mode-pill ${isAgentMode() ? 'agent' : 'local'}">${esc(exitLabel())}</div>
          <button class="btn btn-sm btn-ghost btn-block" id="btn-logout">退出登录</button>
        </div>
      </aside>
      <main class="main">
        ${topAlerts()}
        ${content}
      </main>
    </div>
    <div id="modal-root"></div>`;
}

function bindShell() {
  bindTopAlerts();
  document.querySelectorAll('[data-nav]').forEach((b) => {
    b.onclick = () => {
      state.page = b.dataset.nav;
      render();
    };
  });
  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    await boot();
  });
}

async function refreshCore() {
  const [status, server, clients, overview] = await Promise.all([
    api('/api/status'),
    api('/api/server'),
    api('/api/clients'),
    api('/api/exit/overview').catch(() => null),
  ]);
  state.status = status;
  state.mode = status.mode || 'local';
  state.primaryNode = status.primaryNode || null;
  state.primaryNodeId = status.primaryNodeId || null;
  state.server = server.server;
  state.wizardDone = server.wizardDone;
  state.dirty = Boolean(status.dirty ?? clients.dirty ?? server.dirty);
  state.clientsNeedRescan = Boolean(
    status.clientsNeedRescan ?? server.clientsNeedRescan ?? clients.clientsNeedRescan
  );
  state.latestJob = status.primaryNode?.latestJob || null;
  state.lastAppliedAt = status.lastAppliedAt;
  state.clients = clients.clients || [];
  state.exitOverview = overview;
}

/* ========== 向导：强制选出口位置 ========== */
function renderWizard() {
  const step = state.wizardStep || 1;
  const s = state.server || {};
  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>新手引导</h2>
        <p class="muted">先选对「出口在哪」，再填连接地址。面板可以和落地机分开。</p>
      </div>
      <button class="btn btn-ghost" id="wiz-skip">跳过</button>
    </div>
    <div class="wizard-steps">
      <span class="${step === 1 ? 'on' : ''}">1 出口位置</span>
      <span class="${step === 2 ? 'on' : ''}">2 连接地址</span>
      <span class="${step === 3 ? 'on' : ''}">3 客户端</span>
    </div>
    <div class="card" id="wiz-body"></div>
  `);
  bindShell();

  const body = document.getElementById('wiz-body');
  if (step === 1) {
    body.innerHTML = `
      <h3>你的 WireGuard 出口在哪台机器上？</h3>
      <p class="muted">手机连上后，上网 IP 就是<strong>出口机器</strong>的 IP。面板只负责管理。</p>
      <div class="choice-grid">
        <button class="choice-card" id="wiz-agent">
          <strong>另一台落地机（推荐）</strong>
          <span>面板单独部署；美国家宽 / CM / VPS 上装 Agent。适合 TK 直播、商家前置入口。</span>
        </button>
        <button class="choice-card" id="wiz-local">
          <strong>就在面板这台机器</strong>
          <span>面板和 WireGuard 同一台 VPS。简单场景用。</span>
        </button>
      </div>
      <div class="field-hint" style="margin-top:12px">
        你的场景（面板单独装、落地家宽只允许 WG）：请选 <strong>另一台落地机</strong>。
      </div>`;
    document.getElementById('wiz-agent').onclick = async () => {
      try {
        const res = await api('/api/mode', {
          method: 'POST',
          body: { mode: 'agent', template: 'cm', name: '落地出口' },
        });
        state.mode = 'agent';
        state.primaryNode = res.primaryNode;
        state.installCommand = res.installCommand;
        if (res.server) state.server = res.server;
        state.wizardStep = 2;
        toast(res.message || '已选远程落地');
        render();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
    document.getElementById('wiz-local').onclick = async () => {
      try {
        await api('/api/mode', { method: 'POST', body: { mode: 'local' } });
        state.mode = 'local';
        state.wizardStep = 2;
        render();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  } else if (step === 2) {
    const agent = isAgentMode();
    body.innerHTML = `
      <h3>${agent ? '落地机连接参数' : '本机连接参数'}</h3>
      ${
        agent
          ? `<div class="alert info">
        <div>
          <strong>在落地机（美国家宽/CM）上以 root 执行：</strong>
          <pre class="code-block" id="wiz-cmd">${esc(
            state.installCommand || '加载中…'
          )}</pre>
          <div class="btn-row" style="margin-top:8px">
            <button class="btn btn-sm btn-primary" id="wiz-copy">复制安装命令</button>
            <button class="btn btn-sm btn-ghost" id="wiz-refresh-cmd">刷新命令</button>
          </div>
          <p class="field-hint">Agent 上线后，左侧会显示「远程落地 · 在线」。</p>
        </div>
      </div>`
          : ''
      }
      <div class="inline-fields">
        <div>
          <label>监听端口（UDP）${help(
            agent
              ? '商家可用端口例如 7900-7999，勿占 SSH。默认 7901'
              : 'VPS 常用 51820'
          )}</label>
          <input class="field mono" id="w-port" value="${esc(s.listenPort || (agent ? 7901 : 51820))}" />
        </div>
        <div>
          <label>客户端连接地址 Endpoint${help(
            '手机要连的「入站」地址:端口。不是服务器出网 IP。商家前置入口请填外部连接 IP 或移动入口。'
          )}</label>
          <input class="field mono" id="w-ep" placeholder="${
            agent ? '114.x.x.x:7901 或 211.x.x.x:7901' : '你的公网IP:51820'
          }" value="${esc(s.endpoint || '')}" />
        </div>
      </div>
      <p class="field-hint">
        ${
          agent
            ? 'CM/前置入口：优先填「外部连接 IP:端口」，移动网不行再换「移动入口」。永远不要填探测出来的 107.x 之类出网 IP。'
            : '普通 VPS 可点探测；有前置入口时请手填入站地址。'
        }
      </p>
      ${
        !agent
          ? `<button class="btn btn-sm btn-ghost" id="w-detect">探测本机出网 IP（慎用）</button>`
          : ''
      }
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-ghost" id="w-back">上一步</button>
        <button class="btn btn-primary" id="w-next">下一步</button>
      </div>`;
    if (agent && !state.installCommand) {
      api('/api/primary/install-command')
        .then((r) => {
          state.installCommand = r.installCommand;
          const pre = document.getElementById('wiz-cmd');
          if (pre) pre.textContent = r.installCommand;
        })
        .catch(() => {});
    }
    document.getElementById('wiz-copy')?.addEventListener('click', async () => {
      try {
        await copyText(state.installCommand || document.getElementById('wiz-cmd')?.textContent);
        toast('已复制');
      } catch (e) {
        toast(e.message, 'err');
      }
    });
    document.getElementById('wiz-refresh-cmd')?.addEventListener('click', async () => {
      try {
        const r = await api('/api/primary/install-command');
        state.installCommand = r.installCommand;
        document.getElementById('wiz-cmd').textContent = r.installCommand;
        toast('已刷新');
      } catch (e) {
        toast(e.message, 'err');
      }
    });
    document.getElementById('w-detect')?.addEventListener('click', async () => {
      try {
        const r = await api('/api/system/fill-endpoint', { method: 'POST', body: {} });
        document.getElementById('w-ep').value = r.endpoint;
        if (r.warning) toast(r.warning, 'warn');
        else toast('已填入（请确认是入站地址）');
      } catch (e) {
        toast(e.message, 'err');
      }
    });
    document.getElementById('w-back').onclick = () => {
      state.wizardStep = 1;
      render();
    };
    document.getElementById('w-next').onclick = async () => {
      const port = Number(val('w-port')) || (agent ? 7901 : 51820);
      let ep = val('w-ep');
      if (!ep) {
        toast('请填写 Endpoint（客户端连接地址）', 'err');
        return;
      }
      if (!ep.includes(':')) ep = `${ep}:${port}`;
      try {
        await api('/api/server', {
          method: 'PUT',
          body: { listenPort: port, endpoint: ep, syncEndpointPort: true },
        });
        state.wizardStep = 3;
        await refreshCore();
        render();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  } else {
    body.innerHTML = `
      <h3>添加第一个客户端</h3>
      <p class="muted">添加后只在「客户端」页扫码。不要用别处的码。</p>
      <label>名称</label>
      <input class="field" id="w-name" value="手机" />
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-ghost" id="w-back">上一步</button>
        <button class="btn btn-primary" id="w-finish">创建并完成</button>
      </div>`;
    document.getElementById('w-back').onclick = () => {
      state.wizardStep = 2;
      render();
    };
    document.getElementById('w-finish').onclick = async () => {
      try {
        const c = await api('/api/clients', {
          method: 'POST',
          body: {
            name: val('w-name') || '手机',
            allowedIPs: '0.0.0.0/0, ::/0',
            usePresharedKey: true,
          },
        });
        await api('/api/server', { method: 'PUT', body: { wizardDone: true } });
        state.wizardDone = true;
        toast('已创建客户端，请一键落地后扫码');
        state.page = 'clients';
        await refreshCore();
        render();
        if (c.client?.id) showClientQr(c.client.id);
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  }

  document.getElementById('wiz-skip').onclick = async () => {
    await api('/api/server', { method: 'PUT', body: { wizardDone: true } });
    state.wizardDone = true;
    state.page = 'dashboard';
    render();
  };
}

/* ========== 概览 ========== */
async function renderDashboard() {
  await refreshCore().catch(() => {});
  const s = state.server || {};
  const online = state.clients.filter((c) => c.online).length;
  const agent = isAgentMode();
  const node = state.primaryNode;
  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>概览</h2>
        <p class="muted">当前出口：<strong>${esc(exitLabel())}</strong></p>
      </div>
      <div class="btn-row">
        <button class="btn btn-ghost" id="dash-diag">诊断</button>
        <button class="btn btn-primary" id="dash-exit">一键落地</button>
        <button class="btn btn-success" id="dash-apply">应用配置</button>
      </div>
    </div>
    <div class="grid-4">
      <div class="stat card"><div class="stat-label">模式</div><div class="stat-value">${
        agent ? '远程落地' : '本机'
      }</div></div>
      <div class="stat card"><div class="stat-label">Endpoint</div><div class="stat-value mono small">${esc(
        s.endpoint || '未填'
      )}</div></div>
      <div class="stat card"><div class="stat-label">客户端</div><div class="stat-value">${
        state.clients.length
      } <span class="muted small">在线 ${online}</span></div></div>
      <div class="stat card"><div class="stat-label">${
        agent ? 'Agent' : '接口'
      }</div><div class="stat-value">${
        agent ? (node?.online ? '在线' : '离线') : state.status?.interface?.up ? '运行中' : '未启动'
      }</div></div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>推荐流程（面板与落地分离）</h3>
      <ol class="steps-ol">
        <li>出口服务器：确认 Agent 在线、Endpoint 为<strong>落地机入站地址</strong></li>
        <li>点 <strong>一键落地</strong>（只作用在当前出口，不会落到面板机）</li>
        <li>客户端页添加设备 → <strong>只在这里扫码</strong></li>
        <li>手机打开隧道 → 诊断页看握手 → 浏览器看 ifconfig.me 是否为美国家宽 IP</li>
      </ol>
      <p class="field-hint">面板机的出网 IP 与落地无关。一键落地/应用/二维码全部绑定「当前出口」。</p>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>客户端</h3>
        <button class="btn btn-sm btn-primary" id="dash-add">添加</button></div>
      ${
        state.clients.length
          ? `<table><thead><tr><th>名称</th><th>IP</th><th>状态</th><th></th></tr></thead><tbody>
        ${state.clients
          .map(
            (c) => `<tr>
          <td>${esc(c.name)}</td>
          <td class="mono">${esc(c.address)}</td>
          <td>${c.online ? '<span class="badge ok">在线</span>' : '<span class="badge">离线</span>'}</td>
          <td><button class="btn btn-sm btn-ghost" data-qr="${c.id}">二维码</button></td>
        </tr>`
          )
          .join('')}
      </tbody></table>`
          : '<p class="muted">还没有客户端</p>'
      }
    </div>
  `);
  bindShell();
  document.getElementById('dash-diag').onclick = () => {
    state.page = 'diagnose';
    render();
  };
  document.getElementById('dash-exit').onclick = () => setupExit(true);
  document.getElementById('dash-apply').onclick = () => applyConfig(true);
  document.getElementById('dash-add').onclick = () => openClientModal();
  document.querySelectorAll('[data-qr]').forEach((b) => {
    b.onclick = () => showClientQr(b.dataset.qr);
  });
}

/* ========== 出口服务器 ========== */
async function renderServer() {
  await refreshCore().catch(() => {});
  const s = state.server || {};
  const agent = isAgentMode();
  const node = state.primaryNode;
  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>出口服务器</h2>
        <p class="muted">这里配置的是<strong>真正跑 WireGuard 的那一台</strong>（${
          agent ? '远程落地机' : '面板本机'
        }）</p>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="srv-save">保存</button>
        <button class="btn btn-success" id="srv-exit">一键落地</button>
        <button class="btn btn-ghost" id="srv-apply">应用配置</button>
      </div>
    </div>

    <div class="card mode-card">
      <div class="card-head">
        <h3>出口模式</h3>
        <span class="badge ${agent ? 'ok' : ''}">${agent ? '远程 Agent' : '本机'}</span>
      </div>
      <p class="muted small">面板单独部署、美国家宽落地、商家只允许 WG：请用远程模式。</p>
      <div class="btn-row">
        <button class="btn btn-sm ${agent ? 'btn-primary' : 'btn-ghost'}" id="mode-agent">远程落地机</button>
        <button class="btn btn-sm ${!agent ? 'btn-primary' : 'btn-ghost'}" id="mode-local">面板本机</button>
      </div>
      ${
        agent
          ? `<div class="agent-box">
        <div class="kv"><span>状态</span><span>${
          node?.online ? '<span class="badge ok">在线</span>' : '<span class="badge warn">离线</span>'
        }</span></div>
        <div class="kv"><span>主机</span><span class="mono">${esc(node?.hostname || '-')}</span></div>
        <div class="kv"><span>Agent</span><span class="mono">${esc(node?.agentVersion || '-')}</span></div>
        <div class="kv"><span>最近心跳</span><span>${esc(fmtTime(node?.lastSeenAt))}</span></div>
        <label style="margin-top:10px">在落地机执行安装命令（root）</label>
        <pre class="code-block" id="srv-cmd">${esc(state.installCommand || '点击下方加载…')}</pre>
        <div class="btn-row">
          <button class="btn btn-sm btn-primary" id="srv-copy">复制</button>
          <button class="btn btn-sm btn-ghost" id="srv-load-cmd">加载/刷新命令</button>
          <button class="btn btn-sm btn-ghost" id="srv-rotate">轮换 Token</button>
        </div>
      </div>`
          : ''
      }
    </div>

    <div class="card endpoint-card" style="margin-top:16px">
      <div class="card-head">
        <h3>客户端连接地址（Endpoint）</h3>
        <span class="badge">可改 · 入站</span>
      </div>
      <p class="field-hint">
        手机真正去连的地址。<strong>不是</strong>诊断页的「出网 IP」，也<strong>不是</strong>面板 IP。
        改完后手机必须<strong>删除旧隧道并重新扫码</strong>。
      </p>
      <div class="ep-split">
        <div class="ep-host">
          <label>入站 IP / 域名</label>
          <input class="field mono" id="s-ep-host" placeholder="114.111.176.37" value="${esc(
            splitEndpoint(s.endpoint, s.listenPort || 7901).host
          )}" />
        </div>
        <div class="ep-port">
          <label>端口</label>
          <input class="field mono" id="s-ep-port" value="${esc(
            splitEndpoint(s.endpoint, s.listenPort || 7901).port
          )}" />
        </div>
      </div>
      <input type="hidden" id="s-ep" value="${esc(s.endpoint || '')}" />
      <div class="ep-presets">
        <span class="muted small">快捷填入主机（端口沿用右侧）：</span>
        <button type="button" class="chip" data-ep-host="114.111.176.37">外部连接 114.111.176.37</button>
        <button type="button" class="chip" data-ep-host="211.136.162.184">移动入口 211.136.162.184</button>
      </div>
      <p class="field-hint">
        当前合成：<code id="s-ep-preview">${esc(s.endpoint || '（未填）')}</code>
        · 监听端口下方可改；勾选同步后保存会把 Endpoint 端口改成监听端口。
      </p>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>连接参数</h3>
      <div class="inline-fields">
        <div>
          <label>接口名</label>
          <input class="field mono" id="s-iface" value="${esc(s.interfaceName || 'wg0')}" />
        </div>
        <div>
          <label>监听端口 UDP</label>
          <input class="field mono" id="s-port" value="${esc(s.listenPort || 7901)}" />
        </div>
        <div>
          <label>隧道网段</label>
          <input class="field mono" id="s-addr" value="${esc(s.address || '10.8.0.1/24')}" />
        </div>
        <div>
          <label>MTU</label>
          <input class="field mono" id="s-mtu" value="${esc(s.mtu ?? 1420)}" />
        </div>
      </div>
      <label>DNS（客户端）</label>
      <input class="field mono" id="s-dns" value="${esc(s.dns || '1.1.1.1')}" />
      <label class="check-row"><input type="checkbox" id="s-sync" checked /> 保存时把 Endpoint 端口同步为监听端口</label>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>NAT / 落地规则</h3>
      <p class="field-hint">一键落地会自动写转发 + MASQUERADE。一般无需手改。</p>
      <label>PostUp</label>
      <textarea class="field mono" id="s-up" rows="2">${esc(s.postUp || '')}</textarea>
      <label>PostDown</label>
      <textarea class="field mono" id="s-down" rows="2">${esc(s.postDown || '')}</textarea>
    </div>
  `);
  bindShell();

  document.getElementById('mode-agent').onclick = async () => {
    try {
      const res = await api('/api/mode', {
        method: 'POST',
        body: { mode: 'agent', template: 'cm', name: '落地出口' },
      });
      state.installCommand = res.installCommand;
      toast(res.message || '已切换远程');
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  document.getElementById('mode-local').onclick = async () => {
    if (!confirm('切换为本机出口？WireGuard 将跑在面板这台机器上。')) return;
    try {
      await api('/api/mode', { method: 'POST', body: { mode: 'local' } });
      toast('已切换本机出口');
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  const loadCmd = async () => {
    try {
      const r = await api('/api/primary/install-command');
      state.installCommand = r.installCommand;
      const pre = document.getElementById('srv-cmd');
      if (pre) pre.textContent = r.installCommand;
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  document.getElementById('srv-load-cmd')?.addEventListener('click', loadCmd);
  document.getElementById('srv-copy')?.addEventListener('click', async () => {
    try {
      if (!state.installCommand) await loadCmd();
      await copyText(state.installCommand);
      toast('已复制');
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  document.getElementById('srv-rotate')?.addEventListener('click', async () => {
    if (!confirm('轮换 Token 后旧 Agent 会失效，需在落地机重装。继续？')) return;
    try {
      const r = await api('/api/primary/token', { method: 'POST', body: {} });
      state.installCommand = r.installCommand;
      document.getElementById('srv-cmd').textContent = r.installCommand;
      toast('已轮换，请重新安装 Agent');
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  if (agent) loadCmd();

  const syncEpPreview = () => {
    const host = val('s-ep-host');
    const epPort = Number(val('s-ep-port')) || Number(val('s-port')) || 7901;
    const joined = joinEndpoint(host, epPort);
    const hid = document.getElementById('s-ep');
    const prev = document.getElementById('s-ep-preview');
    if (hid) hid.value = joined;
    if (prev) prev.textContent = joined || '（未填）';
  };
  ['s-ep-host', 's-ep-port', 's-port'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', syncEpPreview);
  });
  document.querySelectorAll('[data-ep-host]').forEach((b) => {
    b.onclick = () => {
      const hostEl = document.getElementById('s-ep-host');
      if (hostEl) hostEl.value = b.dataset.epHost || '';
      const portEl = document.getElementById('s-ep-port');
      const listen = Number(val('s-port')) || 7901;
      if (portEl && !val('s-ep-port')) portEl.value = String(listen);
      if (portEl && document.getElementById('s-sync')?.checked) {
        portEl.value = String(listen);
      }
      syncEpPreview();
    };
  });
  syncEpPreview();

  document.getElementById('srv-save').onclick = async () => {
    try {
      const port = Number(val('s-port')) || 7901;
      const epHost = val('s-ep-host');
      let epPort = Number(val('s-ep-port')) || port;
      if (document.getElementById('s-sync')?.checked) epPort = port;
      const ep = joinEndpoint(epHost, epPort);
      if (!epHost) {
        toast('请填写入站 IP（Endpoint 主机）', 'err');
        return;
      }
      const body = {
        interfaceName: val('s-iface') || 'wg0',
        listenPort: port,
        address: val('s-addr') || '10.8.0.1/24',
        endpoint: ep,
        dns: val('s-dns'),
        mtu: val('s-mtu') === '' ? null : Number(val('s-mtu')),
        postUp: document.getElementById('s-up').value,
        postDown: document.getElementById('s-down').value,
        syncEndpointPort: document.getElementById('s-sync').checked,
      };
      const r = await api('/api/server', { method: 'PUT', body });
      state.server = r.server;
      state.dirty = r.dirty;
      state.clientsNeedRescan = Boolean(r.clientsNeedRescan);
      toast(r.tip || '已保存');
      if (r.endpointChanged) {
        openModal({
          title: 'Endpoint 已更新',
          body: `<p>新的连接地址：<code>${esc(r.server?.endpoint || ep)}</code></p>
            <p class="field-hint">手机里的旧隧道<strong>不会自动变</strong>。请删除旧配置后到「客户端」重新扫码。</p>
            <p class="field-hint">只改 Endpoint 时一般<strong>不必</strong>再点「应用配置」；改了监听端口/网段/NAT 才需要应用或一键落地。</p>`,
          actions: `
            <button class="btn btn-ghost" data-close>稍后</button>
            <button class="btn btn-primary" id="ep-go-clients">去重新扫码</button>
          `,
        });
        document.getElementById('ep-go-clients')?.addEventListener('click', () => {
          closeModal();
          state.page = 'clients';
          render();
        });
      } else {
        render();
      }
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  document.getElementById('srv-exit').onclick = () => setupExit(true);
  document.getElementById('srv-apply').onclick = () => applyConfig(true);
}

/* ========== 客户端 ========== */
async function renderClients() {
  await refreshCore().catch(() => {});
  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>客户端</h2>
        <p class="muted">全局面板<strong>只有这一处</strong>二维码。扫这里 = 连当前出口（${esc(
          exitLabel()
        )}）</p>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="c-add">添加客户端</button>
        <button class="btn btn-success" id="c-apply">应用配置</button>
      </div>
    </div>
    <div class="card">
      ${
        !state.server?.endpoint
          ? `<div class="alert warn"><div>尚未填写 Endpoint，无法生成可用二维码。请先到「出口服务器」填写。</div>
             <button class="btn btn-sm btn-primary" data-nav-jump="server">去填写</button></div>`
          : ''
      }
      ${
        state.clients.length
          ? `<table>
        <thead><tr><th>名称</th><th>地址</th><th>握手</th><th>传输</th><th></th></tr></thead>
        <tbody>
        ${state.clients
          .map(
            (c) => `<tr>
          <td><strong>${esc(c.name)}</strong>${c.enabled === false ? ' <span class="badge">禁用</span>' : ''}</td>
          <td class="mono">${esc(c.address)}</td>
          <td>${
            c.online
              ? '<span class="badge ok">在线</span>'
              : esc(c.latestHandshake || '无')
          }</td>
          <td class="mono small">${esc(c.transfer || '-')}</td>
          <td class="btn-row">
            <button class="btn btn-sm btn-primary" data-qr="${c.id}">二维码</button>
            <button class="btn btn-sm btn-ghost" data-dl="${c.id}">下载</button>
            <button class="btn btn-sm btn-ghost" data-edit="${c.id}">编辑</button>
            <button class="btn btn-sm btn-danger" data-del="${c.id}">删除</button>
          </td>
        </tr>`
          )
          .join('')}
        </tbody></table>`
          : `<div class="empty">还没有客户端。<button class="btn btn-primary" id="c-add-2">添加第一个</button></div>`
      }
    </div>
  `);
  bindShell();
  document.getElementById('c-add')?.addEventListener('click', () => openClientModal());
  document.getElementById('c-add-2')?.addEventListener('click', () => openClientModal());
  document.getElementById('c-apply')?.addEventListener('click', () => applyConfig(true));
  document.querySelectorAll('[data-qr]').forEach((b) => {
    b.onclick = () => showClientQr(b.dataset.qr);
  });
  document.querySelectorAll('[data-dl]').forEach((b) => {
    b.onclick = () => {
      window.location.href = `/api/clients/${b.dataset.dl}/config?format=download`;
    };
  });
  document.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => {
      const c = state.clients.find((x) => x.id === b.dataset.edit);
      openClientModal(c);
    };
  });
  document.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除该客户端？')) return;
      try {
        await api(`/api/clients/${b.dataset.del}`, { method: 'DELETE' });
        toast('已删除');
        render();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  });
}

function openClientModal(client) {
  const isEdit = Boolean(client);
  openModal({
    title: isEdit ? '编辑客户端' : '添加客户端',
    body: `
      <label>名称</label>
      <input class="field" id="c-name" value="${esc(client?.name || '')}" placeholder="手机" />
      <label>内网 IP（可留空自动分配）</label>
      <input class="field mono" id="c-addr" value="${esc(client?.address || '')}" />
      <label>AllowedIPs</label>
      <select class="field" id="c-preset">
        <option value="0.0.0.0/0, ::/0">全局代理（上网走落地 IP）</option>
        <option value="custom">自定义</option>
      </select>
      <input class="field mono" id="c-allowed" value="${esc(
        client?.allowedIPs || '0.0.0.0/0, ::/0'
      )}" style="margin-top:8px" />
      <label>备注</label>
      <input class="field" id="c-note" value="${esc(client?.note || '')}" />
    `,
    actions: `
      <button class="btn btn-ghost" data-close>取消</button>
      <button class="btn btn-primary" id="c-save">${isEdit ? '保存' : '创建'}</button>
    `,
  });
  document.getElementById('c-save').onclick = async () => {
    const body = {
      name: val('c-name') || '客户端',
      address: val('c-addr'),
      allowedIPs: val('c-allowed') || '0.0.0.0/0, ::/0',
      note: val('c-note'),
      usePresharedKey: true,
    };
    try {
      if (isEdit) {
        await api(`/api/clients/${client.id}`, { method: 'PUT', body });
        toast('已保存');
        closeModal();
        render();
      } else {
        const r = await api('/api/clients', { method: 'POST', body });
        toast('已创建');
        closeModal();
        await refreshCore();
        state.page = 'clients';
        render();
        if (r.client?.id) showClientQr(r.client.id);
      }
    } catch (e) {
      toast(e.message, 'err');
    }
  };
}

async function showClientQr(id) {
  try {
    const data = await api(`/api/clients/${id}/config?format=qr`);
    const ep = data.endpoint || state.server?.endpoint || '';
    const rescan = state.clientsNeedRescan
      ? `<div class="alert warn" style="margin-bottom:12px"><div><strong>请确认这是最新码</strong> · Endpoint 改过后必须删掉手机旧隧道再扫</div></div>`
      : '';
    openModal({
      title: `客户端 · ${data.name || ''}`,
      body: `
        ${rescan}
        <div class="qr-wrap"><img src="${data.qr}" alt="qr" /></div>
        <p class="muted center">WireGuard 官方 App 扫码</p>
        <p class="center mono" style="font-size:13px">Endpoint: <strong>${esc(ep)}</strong></p>
        <p class="field-hint center">
          打开隧道 →「诊断」看握手。有握手后 ifconfig.me 应是<strong>落地机出网 IP</strong>（美国家宽），不是面板 IP，也不是 Endpoint 上的入站 IP。
        </p>
        <div class="btn-row center">
          <button class="btn btn-ghost" id="qr-copy">复制配置</button>
          <a class="btn btn-primary" href="/api/clients/${id}/config?format=download">下载</a>
        </div>
        <pre class="code-block" style="margin-top:12px;max-height:200px;overflow:auto">${esc(
          data.config
        )}</pre>
      `,
      actions: `<button class="btn btn-primary" data-close id="qr-close">关闭</button>`,
    });
    document.getElementById('qr-copy')?.addEventListener('click', async () => {
      try {
        await copyText(data.config);
        toast('已复制');
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  } catch (e) {
    toast(e.data?.error || e.message, 'err');
    if (e.data?.code === 'NO_ENDPOINT') {
      state.page = 'server';
      render();
    }
  }
}

/* ========== 诊断 ========== */
async function renderDiagnose() {
  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>诊断</h2>
        <p class="muted">检查为何连不上 / 只有发送没有接收 / 握手了上不了网</p>
      </div>
      <button class="btn btn-primary" id="d-refresh">重新诊断</button>
    </div>
    <div class="card" id="d-box"><p class="muted">诊断中…</p></div>
  `);
  bindShell();
  const run = async () => {
    const box = document.getElementById('d-box');
    try {
      const d = await api('/api/diagnose');
      state.diagnose = d;
      box.innerHTML = `
        <div class="diag-summary ${d.ok ? 'ok' : 'bad'}">
          <strong>${esc(d.summary)}</strong>
          <span class="muted">模式: ${d.mode === 'agent' ? '远程落地' : '本机'}</span>
        </div>
        <div class="diag-list">
          ${(d.items || [])
            .map(
              (it) => `
            <div class="diag-item level-${esc(it.level)}">
              <div class="diag-title">
                <span class="diag-dot"></span>
                <strong>${esc(it.title)}</strong>
              </div>
              <div class="diag-detail">${esc(it.detail)}</div>
              ${it.fix ? `<div class="diag-fix">→ ${esc(it.fix)}</div>` : ''}
            </div>`
            )
            .join('')}
        </div>
        ${
          d.raw
            ? `<details style="margin-top:16px"><summary class="muted">原始 wg show</summary>
               <pre class="code-block">${esc(d.raw)}</pre></details>`
            : ''
        }
        <div class="btn-row" style="margin-top:16px">
          <button class="btn btn-primary" id="d-exit">一键落地</button>
          <button class="btn btn-success" id="d-apply">应用配置</button>
          <button class="btn btn-ghost" data-nav-jump="clients">去扫码</button>
        </div>
      `;
      document.getElementById('d-exit').onclick = () => setupExit(true);
      document.getElementById('d-apply').onclick = () => applyConfig(true);
      bindTopAlerts();
    } catch (e) {
      box.innerHTML = `<p class="danger">${esc(e.message)}</p>`;
    }
  };
  document.getElementById('d-refresh').onclick = run;
  await run();
}

/* ========== 设置 ========== */
async function renderSettings() {
  app.innerHTML = shell(`
    <div class="page-header"><div><h2>设置</h2></div></div>
    <div class="card">
      <h3>修改密码</h3>
      <label>当前密码</label><input class="field" type="password" id="pw-old" />
      <label>新密码</label><input class="field" type="password" id="pw-new" />
      <button class="btn btn-primary" id="pw-save" style="margin-top:10px">更新密码</button>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>出口模式说明</h3>
      <p class="muted">当前：<strong>${esc(exitLabel())}</strong></p>
      <p class="field-hint">
        美国家宽 / 商家前置入口 / 面板单独部署 → 使用「远程落地机」。
        所有一键落地、应用、二维码都只针对当前出口，不会再误操作到面板机。
      </p>
      <button class="btn btn-sm btn-ghost" data-nav-jump="server">管理出口服务器</button>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>备份</h3>
      <div class="btn-row">
        <a class="btn btn-ghost" href="/api/export">导出 JSON</a>
      </div>
    </div>
  `);
  bindShell();
  document.getElementById('pw-save').onclick = async () => {
    try {
      await api('/api/password', {
        method: 'POST',
        body: { currentPassword: val('pw-old'), newPassword: val('pw-new') },
      });
      toast('密码已更新');
    } catch (e) {
      toast(e.message, 'err');
    }
  };
}

/* ========== 动作 ========== */
let _jobPollTimer = null;
function stopJobPoll() {
  if (_jobPollTimer) {
    clearInterval(_jobPollTimer);
    _jobPollTimer = null;
  }
}
function startJobPoll() {
  stopJobPoll();
  let n = 0;
  _jobPollTimer = setInterval(async () => {
    n += 1;
    try {
      await refreshCore();
      const job = state.primaryNode?.latestJob || state.latestJob;
      const pending = job && (job.status === 'pending' || job.status === 'running');
      if (!pending || n >= 18) {
        stopJobPoll();
        if (job?.status === 'done') {
          toast(job.message || '任务已完成');
        } else if (job?.status === 'error' || job?.status === 'failed') {
          toast(job.message || '任务失败', 'err');
        }
        render();
        return;
      }
      // 轻量更新横幅：不整页重绘输入框
      const main = document.querySelector('.main');
      if (main) {
        const alerts = topAlerts();
        const first = main.firstElementChild;
        // 粗略：重新 render 更稳
        if (n % 2 === 0) render();
      }
    } catch {
      /* ignore */
    }
  }, 4000);
}

async function applyConfig(confirmFirst = false) {
  if (confirmFirst) {
    const msg = isAgentMode()
      ? '将配置下发到【落地机】（不是面板机）。继续？'
      : '将配置应用到【面板本机】WireGuard。继续？';
    if (!confirm(msg)) return;
  }
  try {
    toast(isAgentMode() ? '正在下发到落地机…' : '正在应用…', 'warn');
    const res = await api('/api/apply', { method: 'POST', body: {} });
    toast(res.message || (res.ok ? '完成' : '失败'), res.ok ? 'ok' : 'err');
    if (res.pending) {
      openModal({
        title: '已下发任务',
        body: `<p>${esc(res.message)}</p>
          <p class="field-hint">Agent 约 10 秒内拉取执行。顶部会显示任务状态；完成后「未应用」横幅应消失。</p>`,
        actions: `<button class="btn btn-primary" data-close>好的</button>
          <button class="btn btn-ghost" id="go-diag">打开诊断</button>`,
      });
      document.getElementById('go-diag')?.addEventListener('click', () => {
        closeModal();
        state.page = 'diagnose';
        render();
      });
      startJobPoll();
    }
    await refreshCore();
    render();
  } catch (e) {
    toast(e.data?.error || e.message, 'err');
  }
}

async function setupExit(apply = true) {
  const msg = isAgentMode()
    ? '在【落地机】开启转发 + NAT + 全局代理并应用。不会改面板机网络。继续？'
    : '在【面板本机】开启转发 + NAT 并应用。继续？';
  if (!confirm(msg)) return;
  try {
    toast('正在配置落地…', 'warn');
    const res = await api('/api/exit/setup', {
      method: 'POST',
      body: { apply, fullTunnelClients: true },
    });
    toast(res.message || '完成', res.ok ? 'ok' : 'err');
    if (res.pending) startJobPoll();
    openModal({
      title: res.ok ? '落地任务已处理' : '落地结果',
      body: `
        <p>${esc(res.message || '')}</p>
        ${
          res.pending
            ? '<p class="field-hint">远程任务排队中。顶部会显示执行状态，完成后请打开「诊断」。</p>'
            : ''
        }
        <p class="field-hint">然后：客户端扫码 → 打开隧道 → 诊断看握手 → ifconfig.me 应是<strong>落地机</strong>出口 IP（美国家宽），不是面板 IP。</p>
        <div class="btn-row">
          <button class="btn btn-primary" id="ex-clients">去客户端扫码</button>
          <button class="btn btn-ghost" id="ex-diag">打开诊断</button>
        </div>
      `,
      actions: `<button class="btn btn-ghost" data-close>关闭</button>`,
    });
    document.getElementById('ex-clients')?.addEventListener('click', () => {
      closeModal();
      state.page = 'clients';
      render();
    });
    document.getElementById('ex-diag')?.addEventListener('click', () => {
      closeModal();
      state.page = 'diagnose';
      render();
    });
    await refreshCore();
  } catch (e) {
    toast(e.data?.error || e.message, 'err');
  }
}

/* ========== Modal ========== */
function openModal({ title, body, actions }) {
  const root = document.getElementById('modal-root') || document.body;
  const wrap = el(`
    <div class="modal-backdrop">
      <div class="modal">
        <div class="modal-head"><h3>${esc(title || '')}</h3>
          <button class="btn btn-sm btn-ghost" data-close>✕</button></div>
        <div class="modal-body">${body || ''}</div>
        <div class="modal-foot">${actions || '<button class="btn btn-primary" data-close>关闭</button>'}</div>
      </div>
    </div>`);
  root.innerHTML = '';
  root.appendChild(wrap);
  wrap.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = closeModal;
  });
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) closeModal();
  });
}

function closeModal() {
  const root = document.getElementById('modal-root');
  if (root) root.innerHTML = '';
}

/* ========== Router ========== */
async function render() {
  if (!state.status?.loggedIn) return;
  if (!state.wizardDone && !state._skipWizardOnce) {
    return renderWizard();
  }
  if (state.page === 'dashboard') return renderDashboard();
  if (state.page === 'server') return renderServer();
  if (state.page === 'clients') return renderClients();
  if (state.page === 'diagnose') return renderDiagnose();
  if (state.page === 'settings') return renderSettings();
  return renderDashboard();
}

async function boot() {
  renderBoot();
  try {
    const status = await api('/api/status');
    state.status = status;
    if (status.needSetup) return renderSetup();
    if (!status.loggedIn) return renderLogin();
    state.mode = status.mode || 'local';
    state.primaryNode = status.primaryNode;
    state.wizardDone = status.wizardDone;
    await refreshCore();
    await render();
  } catch (e) {
    renderBoot('加载失败: ' + e.message);
  }
}

boot();
