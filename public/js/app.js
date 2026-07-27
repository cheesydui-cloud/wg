const app = document.getElementById('app');

const state = {
  status: null,
  server: null,
  clients: [],
  page: 'dashboard',
  wizardStep: 1,
  wizardDone: false,
  dirty: false,
  clientsNeedRescan: false,
  mode: 'local',
  primaryNode: null,
  installCommand: '',
  exitOverview: null,
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
  if (!ok) throw new Error('复制失败，请手动选择文本复制');
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

function val(id) {
  return document.getElementById(id)?.value?.trim() ?? '';
}

function isAgentMode() {
  return (state.mode || state.status?.mode) === 'agent';
}

function exitLabel() {
  if (isAgentMode()) {
    const n = state.primaryNode || state.status?.primaryNode;
    return `远程落地 · ${n?.name || '落地机'}${n?.online ? ' · 在线' : ' · 离线'}`;
  }
  return '本机出口';
}

function splitEndpoint(ep, fallbackPort) {
  const raw = String(ep || '').trim();
  const portDef = Number(fallbackPort) || 7901;
  if (!raw) return { host: '', port: portDef };
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
  return p ? `${h}:${p}` : h;
}

function topAlerts() {
  const parts = [];
  if (state.status?.forcePasswordChange) {
    parts.push(`<div class="alert warn">
      <div><strong>请修改初始密码</strong></div>
      <button class="btn btn-sm btn-primary" data-nav-jump="settings">去修改</button>
    </div>`);
  }
  if (state.status?.legacyWireGuard) {
    parts.push(`<div class="alert info">
      <div><strong>已从 WireGuard 迁移到 mieru</strong> · 旧 WG 配置已归档，请用客户端页的 mierus 链接</div>
    </div>`);
  }
  if (isAgentMode() && state.primaryNode && !state.primaryNode.online) {
    parts.push(`<div class="alert warn">
      <div><strong>落地 Agent 离线</strong> · 无法安装/更新 mita</div>
      <button class="btn btn-sm btn-primary" data-nav-jump="server">去安装</button>
    </div>`);
  }
  const job = state.primaryNode?.latestJob;
  if (job && (job.status === 'pending' || job.status === 'running')) {
    parts.push(`<div class="alert warn">
      <div><strong>任务执行中</strong> · ${esc(job.type)}（${esc(job.status)}）</div>
      <button class="btn btn-sm btn-ghost" id="banner-poll">刷新</button>
    </div>`);
  } else if (job && (job.status === 'error' || job.status === 'failed')) {
    parts.push(`<div class="alert danger">
      <div><strong>任务失败</strong> · ${esc(job.message || '')}</div>
      <button class="btn btn-sm btn-primary" data-nav-jump="diagnose">诊断</button>
    </div>`);
  }
  if (state.clientsNeedRescan) {
    parts.push(`<div class="alert warn">
      <div><strong>连接参数已变</strong> · 请重新复制/扫码 mierus 链接</div>
      <div class="btn-row">
        <button class="btn btn-sm btn-primary" data-nav-jump="clients">去客户端</button>
        <button class="btn btn-sm btn-ghost" id="banner-rescan-ack">我已更新</button>
      </div>
    </div>`);
  }
  if (state.dirty) {
    parts.push(`<div class="alert warn">
      <div><strong>有未应用的更改</strong> · 需下发到落地机 mita</div>
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
      toast('已确认');
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
        <div class="logo">M</div>
        <h1>mieru 出口面板</h1>
        <p class="muted">${esc(msg)}</p>
      </div>
    </div>`;
}

function renderSetup() {
  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="logo">M</div>
        <h1>初始化面板</h1>
        <p class="muted">面板单独部署；落地机跑 mita（mieru 服务端）。适合老板前置 + 家宽。</p>
        <label>用户名</label>
        <input class="field" id="su-user" value="admin" />
        <label>密码（至少 6 位）</label>
        <input class="field" id="su-pass" type="password" />
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
        <div class="logo">M</div>
        <h1>登录</h1>
        <p class="muted">mieru 出口管理 v${esc(state.status?.version || '')}</p>
        <label>用户名</label>
        <input class="field" id="li-user" value="${esc(state.status?.defaultUsername || 'admin')}" />
        <label>密码</label>
        <input class="field" id="li-pass" type="password" />
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
        <div class="brand"><div class="logo sm">M</div><div>
          <div class="brand-title">mieru 面板</div>
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
  state.server = server.server;
  state.wizardDone = server.wizardDone;
  state.dirty = Boolean(status.dirty ?? clients.dirty);
  state.clientsNeedRescan = Boolean(status.clientsNeedRescan ?? clients.clientsNeedRescan);
  state.clients = clients.clients || [];
  state.exitOverview = overview;
  state.lastAppliedAt = status.lastAppliedAt;
}

/* ========== 向导 ========== */
function renderWizard() {
  const step = state.wizardStep || 1;
  const s = state.server || {};
  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>新手引导 · mieru</h2>
        <p class="muted">老板前置 + 家宽只认 mieru。本面板管理落地机上的 <strong>mita</strong> 服务端。</p>
      </div>
      <button class="btn btn-ghost" id="wiz-skip">跳过</button>
    </div>
    <div class="wizard-steps">
      <span class="${step === 1 ? 'on' : ''}">1 出口位置</span>
      <span class="${step === 2 ? 'on' : ''}">2 连接参数</span>
      <span class="${step === 3 ? 'on' : ''}">3 客户端</span>
    </div>
    <div class="card" id="wiz-body"></div>
  `);
  bindShell();
  const body = document.getElementById('wiz-body');

  if (step === 1) {
    body.innerHTML = `
      <h3>mita 跑在哪台机器？</h3>
      <p class="muted">手机连上后，上网 IP 是<strong>出口机器（家宽）</strong>的 IP。</p>
      <div class="choice-grid">
        <button class="choice-card" id="wiz-agent">
          <strong>另一台落地机（推荐）</strong>
          <span>面板单独部署；美国家宽装 Agent + mita。适合老板移动前置。</span>
        </button>
        <button class="choice-card" id="wiz-local">
          <strong>就在面板这台</strong>
          <span>仅当面板就在出口机上。一般不推荐。</span>
        </button>
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
    const ep = splitEndpoint(s.endpoint, s.listenPort || 7901);
    body.innerHTML = `
      <h3>${agent ? '落地机参数' : '本机参数'}</h3>
      ${
        agent
          ? `<div class="alert info"><div>
          <strong>在落地机 root 执行：</strong>
          <pre class="code-block" id="wiz-cmd">${esc(state.installCommand || '加载中…')}</pre>
          <div class="btn-row" style="margin-top:8px">
            <button class="btn btn-sm btn-primary" id="wiz-copy">复制安装命令</button>
            <button class="btn btn-sm btn-ghost" id="wiz-refresh-cmd">刷新</button>
          </div>
        </div></div>`
          : ''
      }
      <div class="inline-fields">
        <div>
          <label>监听端口（TCP）${help('商家可用端口段内选择，如 7901。前置需映射 TCP 到落地机。')}</label>
          <input class="field mono" id="w-port" value="${esc(s.listenPort || 7901)}" />
        </div>
        <div>
          <label>传输协议</label>
          <select class="field" id="w-proto">
            <option value="TCP" selected>TCP（推荐·前置友好）</option>
            <option value="UDP">UDP</option>
            <option value="BOTH">BOTH</option>
          </select>
        </div>
      </div>
      <label>客户端连接地址（前置入站 IP）${help('外部连接 IP 或移动入口，不是出网 IP，不是面板 IP')}</label>
      <div class="ep-split">
        <input class="field mono" id="w-ep-host" placeholder="114.x 或 211.x" value="${esc(ep.host)}" />
        <input class="field mono" id="w-ep-port" value="${esc(ep.port)}" />
      </div>
      <div class="ep-presets">
        <button type="button" class="chip" data-ep="114.111.176.37">外部 114.111.176.37</button>
        <button type="button" class="chip" data-ep="211.136.162.184">移动 211.136.162.184</button>
      </div>
      <p class="field-hint">协议是 <strong>mieru</strong>，不是 WireGuard。前置需放行该 <strong>TCP</strong> 端口。</p>
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
    document.querySelectorAll('[data-ep]').forEach((b) => {
      b.onclick = () => {
        document.getElementById('w-ep-host').value = b.dataset.ep;
      };
    });
    document.getElementById('w-back').onclick = () => {
      state.wizardStep = 1;
      render();
    };
    document.getElementById('w-next').onclick = async () => {
      try {
        const port = Number(val('w-port')) || 7901;
        const host = val('w-ep-host');
        const epPort = Number(val('w-ep-port')) || port;
        if (!host) return toast('请填入站 IP', 'err');
        await api('/api/server', {
          method: 'PUT',
          body: {
            listenPort: port,
            protocol: val('w-proto') || 'TCP',
            endpoint: joinEndpoint(host, epPort),
            syncEndpointPort: true,
          },
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
      <h3>创建客户端用户</h3>
      <p class="muted">生成账号密码与 mierus:// 分享链，导入小火箭 / NekoBox / 官方 mieru。</p>
      <label>用户名（可空自动生成）</label>
      <input class="field mono" id="w-user" placeholder="留空自动" />
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
        const r = await api('/api/clients', {
          method: 'POST',
          body: { name: val('w-user') },
        });
        await api('/api/server', { method: 'PUT', body: { wizardDone: true } });
        state.wizardDone = true;
        toast('已创建用户');
        state.page = 'clients';
        await refreshCore();
        render();
        if (r.client?.id) showClientQr(r.client.id);
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  }
  document.getElementById('wiz-skip').onclick = async () => {
    try {
      await api('/api/server', { method: 'PUT', body: { wizardDone: true } });
      state.wizardDone = true;
      state._skipWizardOnce = true;
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
}

/* ========== 概览 ========== */
async function renderDashboard() {
  await refreshCore().catch(() => {});
  const s = state.server || {};
  const ov = state.exitOverview || {};
  const mita = ov.mita || state.primaryNode?.mita;
  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>概览</h2>
        <p class="muted">协议 <strong>mieru</strong> · ${esc(exitLabel())}</p>
      </div>
      <div class="btn-row">
        <button class="btn btn-success" id="dash-exit">一键落地</button>
        <button class="btn btn-primary" id="dash-apply">应用配置</button>
        <button class="btn btn-ghost" id="dash-diag">诊断</button>
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-label">出口模式</div>
        <div class="stat-value">${isAgentMode() ? '远程 Agent' : '本机'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">mita</div>
        <div class="stat-value">${mita?.running ? 'RUNNING' : mita?.status || '未知'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">监听</div>
        <div class="stat-value mono">${esc(s.protocol || 'TCP')} ${esc(s.listenPort || 7901)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">用户数</div>
        <div class="stat-value">${state.clients.length}</div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>连接信息</h3>
      <div class="kv"><span>入站 Endpoint</span><span class="mono">${esc(s.endpoint || '未填')}</span></div>
      <div class="kv"><span>出网 IP（只读）</span><span class="mono">${esc(ov.exitPublicIp || state.primaryNode?.exitPublicIp || '-')}</span></div>
      <div class="kv"><span>最近应用</span><span>${esc(fmtTime(state.lastAppliedAt))}</span></div>
      <p class="field-hint">路径：手机 mieru → 老板前置(TCP) → 家宽 mita → 外网。不要用 WireGuard 扫码。</p>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>客户端用户</h3>
        <button class="btn btn-sm btn-primary" id="dash-add">添加</button>
      </div>
      ${
        state.clients.length
          ? `<table><thead><tr><th>用户</th><th>状态</th><th></th></tr></thead><tbody>
          ${state.clients
            .map(
              (c) => `<tr>
            <td class="mono">${esc(c.name)}</td>
            <td>${c.enabled !== false ? '<span class="badge ok">启用</span>' : '<span class="badge">停用</span>'}</td>
            <td><button class="btn btn-sm btn-ghost" data-qr="${c.id}">链接/二维码</button></td>
          </tr>`
            )
            .join('')}
        </tbody></table>`
          : '<p class="muted">还没有用户</p>'
      }
    </div>
  `);
  bindShell();
  document.getElementById('dash-exit').onclick = () => setupExit();
  document.getElementById('dash-apply').onclick = () => applyConfig(true);
  document.getElementById('dash-diag').onclick = () => {
    state.page = 'diagnose';
    render();
  };
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
  const ep = splitEndpoint(s.endpoint, s.listenPort || 7901);
  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>出口服务器</h2>
        <p class="muted">配置落地机上的 <strong>mita</strong>（mieru 服务端）</p>
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
        <div class="kv"><span>mita</span><span class="mono">${esc(
          node?.mita?.status || node?.lastReport?.mita?.status || '-'
        )}</span></div>
        <label style="margin-top:10px">落地机安装命令（root）</label>
        <pre class="code-block" id="srv-cmd">${esc(state.installCommand || '点击加载…')}</pre>
        <div class="btn-row">
          <button class="btn btn-sm btn-primary" id="srv-copy">复制</button>
          <button class="btn btn-sm btn-ghost" id="srv-load-cmd">刷新命令</button>
          <button class="btn btn-sm btn-ghost" id="srv-rotate">轮换 Token</button>
        </div>
      </div>`
          : ''
      }
    </div>

    <div class="card endpoint-card" style="margin-top:16px">
      <div class="card-head">
        <h3>客户端连接地址（前置入站）</h3>
        <span class="badge">TCP · 可改</span>
      </div>
      <p class="field-hint">手机连接的地址 = 老板前置入口。不是出网 IP，不是面板 IP。</p>
      <div class="ep-split">
        <div class="ep-host">
          <label>入站 IP</label>
          <input class="field mono" id="s-ep-host" value="${esc(ep.host)}" placeholder="114.x / 211.x" />
        </div>
        <div class="ep-port">
          <label>端口</label>
          <input class="field mono" id="s-ep-port" value="${esc(ep.port)}" />
        </div>
      </div>
      <div class="ep-presets">
        <button type="button" class="chip" data-ep-host="114.111.176.37">外部 114.111.176.37</button>
        <button type="button" class="chip" data-ep-host="211.136.162.184">移动 211.136.162.184</button>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>mita 参数</h3>
      <div class="inline-fields">
        <div>
          <label>监听端口</label>
          <input class="field mono" id="s-port" value="${esc(s.listenPort || 7901)}" />
        </div>
        <div>
          <label>协议</label>
          <select class="field" id="s-proto">
            <option value="TCP" ${s.protocol === 'TCP' || !s.protocol ? 'selected' : ''}>TCP</option>
            <option value="UDP" ${s.protocol === 'UDP' ? 'selected' : ''}>UDP</option>
            <option value="BOTH" ${s.protocol === 'BOTH' ? 'selected' : ''}>BOTH</option>
          </select>
        </div>
        <div>
          <label>MTU</label>
          <input class="field mono" id="s-mtu" value="${esc(s.mtu ?? 1400)}" />
        </div>
      </div>
      <label class="check-row"><input type="checkbox" id="s-sync" checked /> 保存时同步 Endpoint 端口</label>
      <p class="field-hint">老板前置场景请用 <strong>TCP</strong>。一键落地会在落地机安装 mita 并放行端口。</p>
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
    if (!confirm('切换为本机出口？')) return;
    try {
      await api('/api/mode', { method: 'POST', body: { mode: 'local' } });
      toast('已切换本机');
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
    if (!confirm('轮换 Token 后需重装 Agent。继续？')) return;
    try {
      const r = await api('/api/primary/token', { method: 'POST', body: {} });
      state.installCommand = r.installCommand;
      document.getElementById('srv-cmd').textContent = r.installCommand;
      toast('已轮换');
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  if (agent) loadCmd();

  document.querySelectorAll('[data-ep-host]').forEach((b) => {
    b.onclick = () => {
      document.getElementById('s-ep-host').value = b.dataset.epHost;
      if (document.getElementById('s-sync')?.checked) {
        document.getElementById('s-ep-port').value = val('s-port') || '7901';
      }
    };
  });

  document.getElementById('srv-save').onclick = async () => {
    try {
      const port = Number(val('s-port')) || 7901;
      const host = val('s-ep-host');
      let epPort = Number(val('s-ep-port')) || port;
      if (document.getElementById('s-sync')?.checked) epPort = port;
      if (!host) return toast('请填入站 IP', 'err');
      const r = await api('/api/server', {
        method: 'PUT',
        body: {
          listenPort: port,
          protocol: val('s-proto') || 'TCP',
          endpoint: joinEndpoint(host, epPort),
          mtu: val('s-mtu') === '' ? 1400 : Number(val('s-mtu')),
          syncEndpointPort: document.getElementById('s-sync').checked,
        },
      });
      state.server = r.server;
      state.dirty = r.dirty;
      state.clientsNeedRescan = Boolean(r.clientsNeedRescan);
      toast(r.tip || '已保存');
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  document.getElementById('srv-exit').onclick = () => setupExit();
  document.getElementById('srv-apply').onclick = () => applyConfig(true);
}

/* ========== 客户端 ========== */
async function renderClients() {
  await refreshCore().catch(() => {});
  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>客户端</h2>
        <p class="muted">mieru 用户。复制 <strong>mierus://</strong> 链接或扫码导入（不是 WireGuard）</p>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="c-add">添加用户</button>
        <button class="btn btn-success" id="c-apply">应用配置</button>
      </div>
    </div>
    ${
      !state.server?.endpoint
        ? `<div class="alert warn"><div>尚未填写入站 Endpoint，无法生成可用链接。请先到「出口服务器」填写。</div></div>`
        : ''
    }
    <div class="card">
      ${
        state.clients.length
          ? `<table><thead><tr><th>用户名</th><th>密码</th><th>状态</th><th></th></tr></thead><tbody>
          ${state.clients
            .map(
              (c) => `<tr>
            <td class="mono">${esc(c.name)}</td>
            <td class="mono">${esc(c.password)}</td>
            <td>${c.enabled !== false ? '<span class="badge ok">启用</span>' : '<span class="badge">停用</span>'}</td>
            <td class="btn-row">
              <button class="btn btn-sm btn-primary" data-qr="${c.id}">链接</button>
              <button class="btn btn-sm btn-ghost" data-edit="${c.id}">编辑</button>
              <button class="btn btn-sm btn-ghost" data-del="${c.id}">删除</button>
            </td>
          </tr>`
            )
            .join('')}
        </tbody></table>`
          : '<p class="muted">还没有用户，点「添加用户」</p>'
      }
    </div>
  `);
  bindShell();
  document.getElementById('c-add').onclick = () => openClientModal();
  document.getElementById('c-apply').onclick = () => applyConfig(true);
  document.querySelectorAll('[data-qr]').forEach((b) => {
    b.onclick = () => showClientQr(b.dataset.qr);
  });
  document.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => {
      const c = state.clients.find((x) => x.id === b.dataset.edit);
      openClientModal(c);
    };
  });
  document.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除该用户？')) return;
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
    title: isEdit ? '编辑用户' : '添加用户',
    body: `
      <label>用户名</label>
      <input class="field mono" id="c-name" value="${esc(client?.name || '')}" placeholder="留空自动生成" />
      <label>密码${isEdit ? '（留空不改）' : ''}</label>
      <input class="field mono" id="c-pass" value="" placeholder="${isEdit ? '留空保持原密码' : '留空自动生成'}" />
      <label>备注</label>
      <input class="field" id="c-note" value="${esc(client?.note || '')}" />
      ${
        isEdit
          ? `<label class="check-row"><input type="checkbox" id="c-regen" /> 重新生成密码</label>`
          : ''
      }
    `,
    actions: `
      <button class="btn btn-ghost" data-close>取消</button>
      <button class="btn btn-primary" id="c-save">${isEdit ? '保存' : '创建'}</button>
    `,
  });
  document.getElementById('c-save').onclick = async () => {
    try {
      if (isEdit) {
        const body = {
          name: val('c-name') || client.name,
          note: val('c-note'),
          regeneratePassword: document.getElementById('c-regen')?.checked,
        };
        if (val('c-pass')) body.password = val('c-pass');
        await api(`/api/clients/${client.id}`, { method: 'PUT', body });
        toast('已保存');
        closeModal();
        render();
      } else {
        const r = await api('/api/clients', {
          method: 'POST',
          body: {
            name: val('c-name'),
            password: val('c-pass'),
            note: val('c-note'),
          },
        });
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
    openModal({
      title: `客户端 · ${data.name || ''}`,
      body: `
        <div class="qr-wrap"><img src="${data.qr}" alt="qr" /></div>
        <p class="muted center">扫码导入 mierus 链接（支持 mieru 的客户端）</p>
        <p class="center mono" style="font-size:12px;word-break:break-all">${esc(data.shareLink)}</p>
        <p class="field-hint center">Endpoint: <code>${esc(data.endpoint || '')}</code></p>
        <div class="btn-row center">
          <button class="btn btn-primary" id="qr-copy-link">复制链接</button>
          <button class="btn btn-ghost" id="qr-copy-json">复制 JSON</button>
          <a class="btn btn-ghost" href="/api/clients/${id}/config?format=download">下载 JSON</a>
        </div>
        <pre class="code-block" style="margin-top:12px;max-height:160px;overflow:auto">${esc(
          data.config
        )}</pre>
      `,
      actions: `<button class="btn btn-primary" data-close>关闭</button>`,
    });
    document.getElementById('qr-copy-link')?.addEventListener('click', async () => {
      try {
        await copyText(data.shareLink);
        toast('已复制链接');
      } catch (e) {
        toast(e.message, 'err');
      }
    });
    document.getElementById('qr-copy-json')?.addEventListener('click', async () => {
      try {
        await copyText(data.config);
        toast('已复制 JSON');
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
        <p class="muted">检查 mita / Agent / 入站地址 / 前置路径</p>
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
      box.innerHTML = `
        <div class="diag-summary ${d.ok ? 'ok' : 'bad'}">
          <strong>${esc(d.summary)}</strong>
          <span class="muted">协议: mieru · 模式: ${d.mode === 'agent' ? '远程' : '本机'}</span>
        </div>
        <div class="diag-list">
          ${(d.items || [])
            .map(
              (it) => `
            <div class="diag-item level-${esc(it.level)}">
              <div class="diag-title"><span class="diag-dot"></span><strong>${esc(it.title)}</strong></div>
              <div class="diag-detail">${esc(it.detail)}</div>
              ${it.fix ? `<div class="diag-fix">→ ${esc(it.fix)}</div>` : ''}
            </div>`
            )
            .join('')}
        </div>
        <div class="btn-row" style="margin-top:16px">
          <button class="btn btn-primary" id="d-exit">一键落地</button>
          <button class="btn btn-success" id="d-apply">应用配置</button>
          <button class="btn btn-ghost" data-nav-jump="clients">去客户端</button>
        </div>
      `;
      document.getElementById('d-exit').onclick = () => setupExit();
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
      <button class="btn btn-primary" id="pw-save" style="margin-top:10px">更新</button>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>关于</h3>
      <p class="muted">当前协议：<strong>mieru / mita</strong></p>
      <p class="field-hint">老板前置 + 家宽场景请用 TCP。WireGuard 在此线路不可用，已迁移到 mieru。</p>
      <a class="btn btn-sm btn-ghost" href="/api/export">导出 JSON</a>
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
      const job = state.primaryNode?.latestJob;
      const pending = job && (job.status === 'pending' || job.status === 'running');
      if (!pending || n >= 30) {
        stopJobPoll();
        if (job?.status === 'done') toast(job.message || '任务完成');
        else if (job?.status === 'error') toast(job.message || '任务失败', 'err');
        render();
      } else if (n % 2 === 0) {
        render();
      }
    } catch {
      /* */
    }
  }, 4000);
}

async function applyConfig(confirmFirst = false) {
  if (confirmFirst) {
    if (!confirm('将 mita 配置下发到落地机。继续？')) return;
  }
  try {
    toast('正在下发…', 'warn');
    const res = await api('/api/apply', { method: 'POST', body: {} });
    toast(res.message || '完成', res.ok ? 'ok' : 'err');
    if (res.pending) startJobPoll();
    await refreshCore();
    render();
  } catch (e) {
    toast(e.data?.error || e.message, 'err');
  }
}

async function setupExit() {
  if (!confirm('在落地机安装/配置 mita 并放行端口？不会改面板机网络。')) return;
  try {
    toast('正在一键落地…', 'warn');
    const res = await api('/api/exit/setup', { method: 'POST', body: {} });
    toast(res.message || '完成', res.ok ? 'ok' : 'err');
    if (res.pending) startJobPoll();
    openModal({
      title: '落地任务',
      body: `
        <p>${esc(res.message || '')}</p>
        <p class="field-hint">Agent 约 10 秒拉取。完成后到「客户端」复制 mierus 链接，用支持 mieru 的 App 连接。</p>
        <p class="field-hint">若仍不通：让老板确认 <strong>TCP 端口</strong> 已映射到落地机内网（不是 UDP/WireGuard）。</p>
        <div class="btn-row">
          <button class="btn btn-primary" id="ex-clients">去客户端</button>
          <button class="btn btn-ghost" id="ex-diag">诊断</button>
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

async function render() {
  if (!state.status?.loggedIn) return;
  if (!state.wizardDone && !state._skipWizardOnce) return renderWizard();
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
