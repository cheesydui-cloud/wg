const app = document.getElementById('app');

const state = {
  status: null,
  server: null,
  topology: null,
  clients: [],
  page: 'dashboard',
  wizardStep: 1,
  wizardDone: false,
  dirty: false,
  clientsNeedRescan: false,
  mode: 'agent',
  primaryNode: null,
  installCommand: '',
  exitOverview: null,
  forwardScript: '',
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
    return `落地家宽 · ${n?.name || '落地机'}${n?.online ? ' · 在线' : ' · 离线'}`;
  }
  return '本机出口';
}

function topo() {
  return state.topology || state.status?.topology || {};
}

function activeEp() {
  const t = topo();
  return t.activeEndpoint || state.server?.endpoint || '';
}

function pathLabel() {
  return topo().pathLabel || '电脑/客户端 → 商家IX前置 → 沪日IX → 落地家宽 mita';
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
      <div><strong>已从 WireGuard 迁移到 mieru</strong> · 请用客户端页的 mierus 链接</div>
    </div>`);
  }
  const t = topo();
  if (t.forward && !t.forward.configured) {
    parts.push(`<div class="alert danger">
      <div><strong>IX 转发未配置</strong> · 商家入口流量到不了家宽 mita</div>
      <button class="btn btn-sm btn-primary" data-nav-jump="topology">去拓扑</button>
    </div>`);
  }
  if (isAgentMode() && state.primaryNode && !state.primaryNode.online) {
    parts.push(`<div class="alert warn">
      <div><strong>落地家宽 Agent 离线</strong> · 无法安装/更新 mita</div>
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
      <div><strong>有未应用的更改</strong> · 需下发到落地家宽 mita</div>
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
        <p class="muted">面板装<strong>独立 VPS</strong>只管理。<br/>路径：电脑 → 商家IX前置 → 沪日IX → 落地家宽 mita。</p>
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
        <p class="muted">mieru 拓扑面板 v${esc(state.status?.version || '')}</p>
        <form id="li-form" autocomplete="on">
          <label for="li-user">用户名</label>
          <input class="field" id="li-user" name="username" type="text" autocomplete="username"
            autocapitalize="off" spellcheck="false"
            value="${esc(state.status?.defaultUsername || 'admin')}" />
          <label for="li-pass">密码</label>
          <div class="field-with-btn">
            <input class="field" id="li-pass" name="password" type="text" inputmode="text"
              autocomplete="current-password" autocapitalize="off" spellcheck="false"
              placeholder="点这里输入密码" />
            <button type="button" class="btn btn-ghost" id="li-toggle" title="显示/隐藏">隐藏</button>
          </div>
          <p class="field-hint">忘记密码在面板机执行：
            <code>sudo bash install.sh --reset-password '新密码'</code></p>
          <button type="submit" class="btn btn-primary btn-block" id="li-go">登录</button>
        </form>
      </div>
    </div>`;
  const passEl = document.getElementById('li-pass');
  let hidden = false;
  document.getElementById('li-toggle').onclick = () => {
    hidden = !hidden;
    passEl.type = hidden ? 'password' : 'text';
    document.getElementById('li-toggle').textContent = hidden ? '显示' : '隐藏';
  };
  const go = async (e) => {
    e?.preventDefault?.();
    const btn = document.getElementById('li-go');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '登录中…';
    }
    try {
      const user = document.getElementById('li-user').value.trim() || 'admin';
      const password = document.getElementById('li-pass').value;
      await api('/api/login', {
        method: 'POST',
        body: { username: user, password },
      });
      toast('登录成功');
      await boot();
    } catch (err) {
      toast(err.message || '登录失败', 'err');
      passEl.focus();
      passEl.select();
      if (btn) {
        btn.disabled = false;
        btn.textContent = '登录';
      }
    }
  };
  document.getElementById('li-form').onsubmit = go;
  setTimeout(() => {
    passEl.focus();
    passEl.select();
  }, 50);
}

function shell(content) {
  const nav = [
    ['dashboard', '概览', '◈'],
    ['topology', '拓扑', '⇄'],
    ['server', '落地机', '◎'],
    ['clients', '客户端', '◉'],
    ['diagnose', '诊断', '✎'],
    ['settings', '设置', '⚙'],
  ];
  return `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand"><div class="logo sm">M</div><div>
          <div class="brand-title">mieru 面板</div>
          <div class="brand-sub">v${esc(state.status?.version || '')} · 拓扑</div>
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
  const [status, server, clients, overview, topology] = await Promise.all([
    api('/api/status'),
    api('/api/server'),
    api('/api/clients'),
    api('/api/exit/overview').catch(() => null),
    api('/api/topology').catch(() => null),
  ]);
  state.status = status;
  state.mode = status.mode || 'agent';
  state.primaryNode = status.primaryNode || null;
  state.server = server.server;
  state.topology = topology?.topology || server.topology || status.topology || null;
  state.forwardScript = topology?.forwardScript || '';
  state.wizardDone = server.wizardDone;
  state.dirty = Boolean(status.dirty ?? clients.dirty);
  state.clientsNeedRescan = Boolean(status.clientsNeedRescan ?? clients.clientsNeedRescan);
  state.clients = clients.clients || [];
  state.exitOverview = overview;
  state.lastAppliedAt = status.lastAppliedAt;
}

function pathBanner() {
  const t = topo();
  const ep = activeEp();
  const fwdOk = Boolean(t.forward?.configured);
  return `
    <div class="path-banner">
      <div class="path-flow">
        <span class="path-node">电脑/客户端</span>
        <span class="path-arrow">→</span>
        <span class="path-node on">商家IX前置<br/><small class="mono">${esc(ep || '114:7901')}</small></span>
        <span class="path-arrow">→</span>
        <span class="path-node ${fwdOk ? 'on' : 'warn'}">沪日IX<br/><small>${fwdOk ? '转发已配' : '待转发'}</small></span>
        <span class="path-arrow">→</span>
        <span class="path-node ${state.primaryNode?.online ? 'on' : ''}">落地家宽<br/><small>mita</small></span>
        <span class="path-arrow">→</span>
        <span class="path-node">出网</span>
      </div>
      <p class="field-hint" style="margin:8px 0 0">面板只管理，不在业务链上。端口 ${esc(t.merchantPortRange || '7900-7999')} · TCP mieru。「移动入口」= 商家移动宽带前置，不是手机。客户端连前置，勿连家宽公网。</p>
    </div>`;
}

/* ========== 向导 ========== */
function renderWizard() {
  const step = state.wizardStep || 1;
  const t = topo();
  const ing = t.ingress || {};
  const ix = t.ix || {};
  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>新手引导 · 商家 IX 前置</h2>
        <p class="muted">${esc(pathLabel())}</p>
      </div>
      <button class="btn btn-ghost" id="wiz-skip">跳过</button>
    </div>
    <div class="wizard-steps">
      <span class="${step === 1 ? 'on' : ''}">1 路径确认</span>
      <span class="${step === 2 ? 'on' : ''}">2 家宽 Agent</span>
      <span class="${step === 3 ? 'on' : ''}">3 入口+IX</span>
      <span class="${step === 4 ? 'on' : ''}">4 客户端</span>
    </div>
    <div class="card" id="wiz-body"></div>
  `);
  bindShell();
  const body = document.getElementById('wiz-body');

  if (step === 1) {
    body.innerHTML = `
      <h3>确认真实链路</h3>
      ${pathBanner()}
      <div class="alert info" style="margin-top:12px"><div>
        <strong>路径与角色（不要搞反）</strong>
        <ul style="margin:8px 0 0;padding-left:18px;color:var(--text-2)">
          <li><strong>你的电脑</strong>：跑 mieru 客户端，连商家前置 Endpoint</li>
          <li><strong>商家 IX 前置</strong>：114/211 入口（移动宽带前置 ≠ 手机）</li>
          <li><strong>沪日 IX</strong>：前置流量先到这里，TCP 转发到家宽</li>
          <li><strong>落地家宽</strong>：装 Agent + mita，真正出网</li>
          <li><strong>面板</strong>：独立 VPS，只管理</li>
        </ul>
      </div></div>
      <p class="field-hint">不是 WireGuard。协议 <strong>mieru TCP</strong>。用你本机经商家前置测；无关 VPS <code>nc</code> 超时可忽略。</p>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-primary" id="w-next">下一步：装落地家宽 Agent</button>
      </div>`;
    document.getElementById('w-next').onclick = async () => {
      try {
        const res = await api('/api/mode', {
          method: 'POST',
          body: { mode: 'agent', template: 'cm', name: '落地家宽' },
        });
        state.mode = 'agent';
        state.primaryNode = res.primaryNode;
        state.installCommand = res.installCommand;
        if (res.server) state.server = res.server;
        state.wizardStep = 2;
        toast(res.message || '已选远程落地家宽');
        render();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  } else if (step === 2) {
    body.innerHTML = `
      <h3>在落地家宽 root 安装 Agent</h3>
      <div class="alert info"><div>
        <strong>在落地家宽执行（不是 IX，不是面板）：</strong>
        <pre class="code-block" id="wiz-cmd">${esc(state.installCommand || '加载中…')}</pre>
        <div class="btn-row" style="margin-top:8px">
          <button class="btn btn-sm btn-primary" id="wiz-copy">复制安装命令</button>
          <button class="btn btn-sm btn-ghost" id="wiz-refresh-cmd">刷新</button>
        </div>
      </div></div>
      <div class="kv"><span>Agent 状态</span><span>${
        state.primaryNode?.online
          ? '<span class="badge ok">在线</span>'
          : '<span class="badge warn">等待上线…</span>'
      }</span></div>
      <p class="field-hint">执行后约 10 秒应显示在线。可先下一步填拓扑，Agent 后上线也可。</p>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-ghost" id="w-back">上一步</button>
        <button class="btn btn-primary" id="w-next">下一步：入口与 IX</button>
      </div>`;
    if (!state.installCommand) {
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
    document.getElementById('w-back').onclick = () => {
      state.wizardStep = 1;
      render();
    };
    document.getElementById('w-next').onclick = () => {
      state.wizardStep = 3;
      render();
    };
  } else if (step === 3) {
    body.innerHTML = `
      <h3>商家 IX 前置 + 沪日转发</h3>
      <label>客户端连接的商家前置（不是手机）</label>
      <div class="choice-grid" style="margin-bottom:12px">
        <button type="button" class="choice-card ${ing.active === 'external' || !ing.active ? 'selected' : ''}" data-act="external">
          <strong>外部前置 114</strong>
          <span class="mono">${esc(ing.externalHost || '114.111.176.37')}</span>
        </button>
        <button type="button" class="choice-card ${ing.active === 'mobile' ? 'selected' : ''}" data-act="mobile">
          <strong>移动宽带前置 211</strong>
          <span class="mono">${esc(ing.mobileHost || '211.136.162.184')}</span>
        </button>
      </div>
      <div class="inline-fields">
        <div>
          <label>端口（商家段 7900–7999）</label>
          <input class="field mono" id="w-port" value="${esc(ing.port || state.server?.listenPort || 7901)}" />
        </div>
        <div>
          <label>协议</label>
          <select class="field" id="w-proto">
            <option value="TCP" selected>TCP（必须）</option>
          </select>
        </div>
      </div>
      <label>家宽对 IX 可达地址${help('IX 能访问到的家宽公网 IP 或隧道地址，用于生成 DNAT 脚本')}</label>
      <input class="field mono" id="w-home" placeholder="如家宽公网 IP" value="${esc(ix.homeReachableHost || '')}" />
      <label style="margin-top:10px">家宽 mita 端口（一般与入口相同）</label>
      <input class="field mono" id="w-home-port" value="${esc(ix.homeReachablePort || ing.port || 7901)}" />
      <p class="field-hint">保存后到「拓扑」复制 IX 转发脚本，在<strong>沪日机 root</strong>执行，再勾选已配置。</p>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-ghost" id="w-back">上一步</button>
        <button class="btn btn-primary" id="w-next">保存并下一步</button>
      </div>`;
    let active = ing.active || 'external';
    document.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => {
        active = b.dataset.act;
        document.querySelectorAll('[data-act]').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
      };
    });
    document.getElementById('w-back').onclick = () => {
      state.wizardStep = 2;
      render();
    };
    document.getElementById('w-next').onclick = async () => {
      try {
        const port = Number(val('w-port')) || 7901;
        const homePort = Number(val('w-home-port')) || port;
        const r = await api('/api/topology', {
          method: 'PUT',
          body: {
            ingress: { active, port, protocol: 'TCP' },
            ix: {
              homeReachableHost: val('w-home'),
              homeReachablePort: homePort,
            },
          },
        });
        state.topology = r.topology;
        state.server = r.server;
        state.dirty = r.dirty;
        state.clientsNeedRescan = Boolean(r.clientsNeedRescan);
        toast(r.tip || '已保存');
        state.wizardStep = 4;
        render();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  } else {
    body.innerHTML = `
      <h3>创建客户端用户</h3>
      <p class="muted">登录名须英文/数字（如 u7af760）。中文写备注。客户端「用户」栏填登录名，不要填中文备注。</p>
      <label>登录用户名（可空自动生成）</label>
      <input class="field mono" id="w-user" placeholder="留空自动" />
      <label>备注（可选）</label>
      <input class="field" id="w-note" placeholder="例如：我的电脑" />
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-ghost" id="w-back">上一步</button>
        <button class="btn btn-primary" id="w-finish">创建并完成</button>
      </div>
      <p class="field-hint" style="margin-top:12px">完成后：① 落地家宽「一键落地」② IX 跑转发脚本 ③ 本机客户端连商家前置 mierus</p>`;
    document.getElementById('w-back').onclick = () => {
      state.wizardStep = 3;
      render();
    };
    document.getElementById('w-finish').onclick = async () => {
      try {
        const r = await api('/api/clients', {
          method: 'POST',
          body: { name: val('w-user'), note: val('w-note') },
        });
        await api('/api/topology', { method: 'PUT', body: { wizardDone: true } });
        state.wizardDone = true;
        toast('已创建用户');
        state.page = 'topology';
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
  const t = topo();
  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>概览</h2>
        <p class="muted">${esc(pathLabel())}</p>
      </div>
      <div class="btn-row">
        <button class="btn btn-success" id="dash-exit">一键落地</button>
        <button class="btn btn-primary" id="dash-apply">应用配置</button>
        <button class="btn btn-ghost" id="dash-topo">拓扑</button>
      </div>
    </div>
    ${pathBanner()}
    <div class="stat-grid" style="margin-top:16px">
      <div class="stat-card">
        <div class="stat-label">入站 Endpoint</div>
        <div class="stat-value small mono">${esc(activeEp() || '未填')}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">IX 转发</div>
        <div class="stat-value">${t.forward?.configured ? '已配置' : '未配置'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">落地 mita</div>
        <div class="stat-value">${mita?.running ? 'RUNNING' : mita?.status || '未知'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">用户数</div>
        <div class="stat-value">${state.clients.length}</div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>连接信息</h3>
      <div class="kv"><span>商家前置（当前）</span><span class="mono">${esc(activeEp() || '-')}</span></div>
      <div class="kv"><span>外部 114</span><span class="mono">${esc(t.endpoints?.external || '-')}</span></div>
      <div class="kv"><span>移动宽带 211</span><span class="mono">${esc(t.endpoints?.mobile || '-')}</span></div>
      <div class="kv"><span>监听</span><span class="mono">${esc(s.protocol || 'TCP')} ${esc(s.listenPort || 7901)}</span></div>
      <div class="kv"><span>出网 IP（只读）</span><span class="mono">${esc(ov.exitPublicIp || state.primaryNode?.exitPublicIp || '-')}</span></div>
      <div class="kv"><span>最近应用</span><span>${esc(fmtTime(state.lastAppliedAt))}</span></div>
      <p class="field-hint">路径：电脑 mieru → 商家IX前置(TCP) → 沪日IX 转发 → 落地家宽 mita → 外网。</p>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>客户端用户</h3>
        <button class="btn btn-sm btn-primary" id="dash-add">添加</button>
      </div>
      ${
        state.clients.length
          ? `<table><thead><tr><th>登录名</th><th>备注</th><th>状态</th><th></th></tr></thead><tbody>
          ${state.clients
            .map(
              (c) => `<tr>
            <td class="mono">${esc(c.name)}</td>
            <td>${esc(c.note || '-')}</td>
            <td>${c.enabled !== false ? '<span class="badge ok">启用</span>' : '<span class="badge">停用</span>'}</td>
            <td><button class="btn btn-sm btn-ghost" data-qr="${c.id}">211/114 链接</button></td>
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
  document.getElementById('dash-topo').onclick = () => {
    state.page = 'topology';
    render();
  };
  document.getElementById('dash-add').onclick = () => openClientModal();
  document.querySelectorAll('[data-qr]').forEach((b) => {
    b.onclick = () => showClientQr(b.dataset.qr);
  });
}

/* ========== 拓扑 ========== */
async function renderTopology() {
  await refreshCore().catch(() => {});
  const t = topo();
  const ing = t.ingress || {};
  const ix = t.ix || {};
  const script = state.forwardScript || '';
  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>拓扑</h2>
        <p class="muted">商家 IX 前置 · 沪日 IX · 落地家宽</p>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="topo-save">保存拓扑</button>
        <button class="btn btn-ghost" id="topo-diag">诊断</button>
      </div>
    </div>
    ${pathBanner()}

    <div class="card endpoint-card" style="margin-top:16px">
      <div class="card-head">
        <h3>① 商家 IX 前置（客户端连接）</h3>
        <span class="badge ${t.portInRange ? 'ok' : 'warn'}">端口段 ${esc(t.merchantPortRange || '7900-7999')}</span>
      </div>
      <p class="field-hint">「移动入口」= 商家<strong>移动宽带前置</strong>（211），不是你的手机。电脑客户端连这里。</p>
      <div class="choice-grid" style="margin:10px 0">
        <button type="button" class="choice-card ${ing.active === 'external' || !ing.active ? 'selected' : ''}" data-act="external">
          <strong>外部前置 114</strong>
          <span class="mono">${esc(ing.externalHost || '114.111.176.37')}</span>
        </button>
        <button type="button" class="choice-card ${ing.active === 'mobile' ? 'selected' : ''}" data-act="mobile">
          <strong>移动宽带前置 211</strong>
          <span class="mono">${esc(ing.mobileHost || '211.136.162.184')}</span>
        </button>
        <button type="button" class="choice-card ${ing.active === 'custom' ? 'selected' : ''}" data-act="custom">
          <strong>自定义</strong>
          <span>填下方</span>
        </button>
      </div>
      <div class="inline-fields">
        <div>
          <label>端口</label>
          <input class="field mono" id="t-port" value="${esc(ing.port || 7901)}" />
        </div>
        <div>
          <label>自定义 Host</label>
          <input class="field mono" id="t-custom" value="${esc(ing.customHost || '')}" placeholder="可选" />
        </div>
        <div>
          <label>白名单提示</label>
          <input class="field" id="t-province" value="${esc(ing.provinceWhitelist || '商家白名单（如有）')}" />
        </div>
      </div>
      <div class="kv"><span>当前 Endpoint</span><span class="mono">${esc(activeEp())}</span></div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <h3>② 沪日 IX 转发</h3>
        <span class="badge ${ix.forwardConfigured ? 'ok' : 'warn'}">${ix.forwardConfigured ? '已标记配置' : '未配置'}</span>
      </div>
      <p class="field-hint">商家前置流量先到 IX 内网 <code class="mono">${esc(ix.lanIp || '172.16.2.79')}</code>，再 DNAT 到落地家宽 mita。客户端仍连 114/211，不连家宽公网。</p>
      <div class="inline-fields">
        <div>
          <label>IX 内网 IP</label>
          <input class="field mono" id="t-ix-lan" value="${esc(ix.lanIp || '172.16.2.79')}" />
        </div>
        <div>
          <label>IX SSH 端口</label>
          <input class="field mono" id="t-ix-ssh" value="${esc(ix.sshPort || 7900)}" />
        </div>
      </div>
      <label>家宽对 IX 可达地址（家宽公网 IP，IX 能访问到的）</label>
      <input class="field mono" id="t-home" value="${esc(ix.homeReachableHost || '')}" placeholder="例如家宽公网 82.x.x.x" />
      <label style="margin-top:8px">家宽 mita 端口</label>
      <input class="field mono" id="t-home-port" value="${esc(ix.homeReachablePort || ing.port || 7901)}" />
      <div class="alert info" style="margin-top:12px"><div>
        <strong>已验证顺序</strong>
        <ol style="margin:6px 0 0;padding-left:18px;color:var(--text-2);font-size:13px">
          <li>落地家宽 <code>mita start</code>，确认 <code>ss -lntp | grep 7901</code> 在听</li>
          <li>填家宽公网 IP → 生成脚本 → 在 IX <strong>整段</strong>执行（勿一行行贴）</li>
          <li>IX 上 <code>timeout 5 bash -c 'echo &gt;/dev/tcp/家宽IP/7901' && echo OK</code></li>
          <li>OK 后勾选下方并保存；电脑连商家前置 mierus</li>
        </ol>
      </div></div>
      <label class="check-row">
        <input type="checkbox" id="t-fwd-ok" ${ix.forwardConfigured ? 'checked' : ''} />
        我已在 IX 整段执行脚本，且 IX→家宽探测为 OK
      </label>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-sm btn-primary" id="t-load-script">生成/刷新转发脚本</button>
        <button class="btn btn-sm btn-ghost" id="t-copy-script" ${script ? '' : 'disabled'}>复制脚本</button>
        <a class="btn btn-sm btn-ghost" id="t-dl-script" href="/api/topology/forward-script?download=1">下载 .sh</a>
      </div>
      <pre class="code-block" id="t-script" style="margin-top:10px;max-height:220px;overflow:auto">${esc(
        script || '（先填家宽公网 IP 并点「生成/刷新转发脚本」）'
      )}</pre>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>③ 落地家宽</h3>
      <div class="kv"><span>Agent</span><span>${
        state.primaryNode?.online
          ? '<span class="badge ok">在线</span>'
          : '<span class="badge warn">离线</span>'
      }</span></div>
      <div class="kv"><span>主机</span><span class="mono">${esc(state.primaryNode?.hostname || '-')}</span></div>
      <div class="kv"><span>mita</span><span class="mono">${esc(
        state.primaryNode?.mita?.status || state.exitOverview?.mita?.status || '-'
      )}</span></div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn btn-sm btn-success" id="t-exit">一键落地 mita</button>
        <button class="btn btn-sm btn-ghost" data-nav-jump="server">落地机详情</button>
      </div>
    </div>
  `);
  bindShell();

  let active = ing.active || 'external';
  document.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = () => {
      active = b.dataset.act;
      document.querySelectorAll('[data-act]').forEach((x) => x.classList.remove('selected'));
      b.classList.add('selected');
    };
  });

  const saveTopo = async () => {
    const r = await api('/api/topology', {
      method: 'PUT',
      body: {
        ingress: {
          active,
          port: Number(val('t-port')) || 7901,
          customHost: val('t-custom'),
          provinceWhitelist: val('t-province'),
          protocol: 'TCP',
        },
        ix: {
          lanIp: val('t-ix-lan'),
          sshPort: Number(val('t-ix-ssh')) || 7900,
          homeReachableHost: val('t-home'),
          homeReachablePort: Number(val('t-home-port')) || Number(val('t-port')) || 7901,
          forwardConfigured: document.getElementById('t-fwd-ok')?.checked,
        },
      },
    });
    state.topology = r.topology;
    state.server = r.server;
    state.dirty = r.dirty;
    state.clientsNeedRescan = Boolean(r.clientsNeedRescan);
    return r;
  };

  document.getElementById('topo-save').onclick = async () => {
    try {
      const r = await saveTopo();
      toast(r.tip || '已保存');
      const topoRes = await api('/api/topology');
      state.forwardScript = topoRes.forwardScript || '';
      state.topology = topoRes.topology;
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  document.getElementById('t-load-script').onclick = async () => {
    try {
      await saveTopo();
      const topoRes = await api('/api/topology');
      state.forwardScript = topoRes.forwardScript || '';
      state.topology = topoRes.topology;
      if (!topoRes.forwardScript) {
        toast(topoRes.forwardError || '请先填家宽可达地址', 'err');
      } else {
        toast('脚本已生成');
      }
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  document.getElementById('t-copy-script').onclick = async () => {
    try {
      if (!state.forwardScript) {
        const topoRes = await api('/api/topology');
        state.forwardScript = topoRes.forwardScript || '';
      }
      await copyText(state.forwardScript);
      toast('已复制转发脚本');
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  document.getElementById('t-exit').onclick = () => setupExit();
  document.getElementById('topo-diag').onclick = () => {
    state.page = 'diagnose';
    render();
  };
}

/* ========== 落地机 ========== */
async function renderServer() {
  await refreshCore().catch(() => {});
  const s = state.server || {};
  const agent = isAgentMode();
  const node = state.primaryNode;
  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>落地机（落地家宽）</h2>
        <p class="muted">Agent + mita 装在这里。入站地址请到「拓扑」配置。</p>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="srv-save">保存 mita 参数</button>
        <button class="btn btn-success" id="srv-exit">一键落地</button>
        <button class="btn btn-ghost" id="srv-apply">应用配置</button>
      </div>
    </div>

    <div class="card mode-card">
      <div class="card-head">
        <h3>出口模式</h3>
        <span class="badge ${agent ? 'ok' : ''}">${agent ? '远程家宽' : '本机'}</span>
      </div>
      <div class="btn-row">
        <button class="btn btn-sm ${agent ? 'btn-primary' : 'btn-ghost'}" id="mode-agent">远程家宽 Agent</button>
        <button class="btn btn-sm ${!agent ? 'btn-primary' : 'btn-ghost'}" id="mode-local">面板本机（不推荐）</button>
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
        <div class="kv"><span>出网 IP</span><span class="mono">${esc(
          node?.exitPublicIp || state.exitOverview?.exitPublicIp || '-'
        )}</span></div>
        <label style="margin-top:10px">家宽安装命令（root）</label>
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

    <div class="card" style="margin-top:16px">
      <h3>mita 参数</h3>
      <div class="kv"><span>当前入站 Endpoint</span><span class="mono">${esc(activeEp() || '未配置')}</span></div>
      <p class="field-hint"><a href="#" id="srv-to-topo">到「拓扑」修改 211/114 与 IX 转发</a></p>
      <div class="inline-fields">
        <div>
          <label>监听端口</label>
          <input class="field mono" id="s-port" value="${esc(s.listenPort || 7901)}" />
        </div>
        <div>
          <label>协议</label>
          <select class="field" id="s-proto">
            <option value="TCP" selected>TCP</option>
            <option value="UDP" ${s.protocol === 'UDP' ? 'selected' : ''}>UDP</option>
            <option value="BOTH" ${s.protocol === 'BOTH' ? 'selected' : ''}>BOTH</option>
          </select>
        </div>
        <div>
          <label>MTU</label>
          <input class="field mono" id="s-mtu" value="${esc(s.mtu ?? 1400)}" />
        </div>
      </div>
      <p class="field-hint">商家入口场景请保持 <strong>TCP</strong>，端口 7900–7999。</p>
    </div>
  `);
  bindShell();

  document.getElementById('srv-to-topo')?.addEventListener('click', (e) => {
    e.preventDefault();
    state.page = 'topology';
    render();
  });

  document.getElementById('mode-agent').onclick = async () => {
    try {
      const res = await api('/api/mode', {
        method: 'POST',
        body: { mode: 'agent', template: 'cm', name: '落地家宽' },
      });
      state.installCommand = res.installCommand;
      toast(res.message || '已切换远程');
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  document.getElementById('mode-local').onclick = async () => {
    if (!confirm('切换为本机出口？商家入口场景不推荐。')) return;
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

  document.getElementById('srv-save').onclick = async () => {
    try {
      const port = Number(val('s-port')) || 7901;
      const r = await api('/api/server', {
        method: 'PUT',
        body: {
          listenPort: port,
          protocol: val('s-proto') || 'TCP',
          mtu: val('s-mtu') === '' ? 1400 : Number(val('s-mtu')),
          syncEndpointPort: true,
        },
      });
      state.server = r.server;
      state.topology = r.topology || state.topology;
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
        <p class="muted">复制 <strong>mierus://</strong>（211 优先 / 114 备用）。不是 WireGuard。</p>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="c-add">添加用户</button>
        <button class="btn btn-success" id="c-apply">应用配置</button>
      </div>
    </div>
    ${
      !activeEp()
        ? `<div class="alert warn"><div>尚未配置入站。请先到「拓扑」选择 211/114。</div>
          <button class="btn btn-sm btn-primary" data-nav-jump="topology">去拓扑</button></div>`
        : `<div class="alert info"><div>当前 Endpoint：<code class="mono">${esc(activeEp())}</code> · 电脑连商家 IX 前置</div></div>`
    }
    <div class="card">
      ${
        state.clients.length
          ? `<table><thead><tr><th>登录用户名</th><th>密码</th><th>备注</th><th>状态</th><th></th></tr></thead><tbody>
          ${state.clients
            .map(
              (c) => `<tr>
            <td class="mono"><strong>${esc(c.name)}</strong></td>
            <td class="mono">${esc(c.password)}</td>
            <td>${esc(c.note || '-')}</td>
            <td>${c.enabled !== false ? '<span class="badge ok">启用</span>' : '<span class="badge">停用</span>'}</td>
            <td class="btn-row">
              <button class="btn btn-sm btn-primary" data-qr="${c.id}">211/114</button>
              <button class="btn btn-sm btn-ghost" data-edit="${c.id}">编辑</button>
              <button class="btn btn-sm btn-ghost" data-del="${c.id}">删除</button>
            </td>
          </tr>`
            )
            .join('')}
        </tbody></table>
        <p class="field-hint" style="margin-top:10px">客户端「用户」必须填<strong>登录用户名</strong>（如 u7af760），不能填中文备注。</p>`
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
      <label>登录用户名（客户端「用户」栏，须英文/数字）</label>
      <input class="field mono" id="c-name" value="${esc(client?.name || '')}" placeholder="留空自动生成，如 u7af760" />
      <p class="field-hint">不要填中文当登录名。显示名请写备注。</p>
      <label>密码${isEdit ? '（留空不改）' : ''}</label>
      <input class="field mono" id="c-pass" value="" placeholder="${isEdit ? '留空保持原密码' : '留空自动生成'}" />
      <label>备注 / 显示名（仅面板展示）</label>
      <input class="field" id="c-note" value="${esc(client?.note || '')}" placeholder="例如：我的电脑" />
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
    const mobile = data.shareLinks?.mobile || data.shareLink;
    const external = data.shareLinks?.external || data.shareLink;
    openModal({
      title: `客户端 · ${data.name || ''}${data.note ? '（' + data.note + '）' : ''}`,
      body: `
        <p class="field-hint center">${esc(data.tip || '电脑连商家 IX 前置 114/211')}</p>
        <div class="dual-qr">
          <div class="dual-qr-col">
            <strong>移动宽带前置 211</strong>
            <div class="qr-wrap"><img src="${data.qrMobile || data.qr}" alt="qr-mobile" /></div>
            <p class="mono center" style="font-size:11px;word-break:break-all">${esc(data.endpoints?.mobile || '')}</p>
            <button class="btn btn-sm btn-primary btn-block" id="qr-copy-m">复制 211 链接</button>
          </div>
          <div class="dual-qr-col">
            <strong>外部前置 114</strong>
            <div class="qr-wrap"><img src="${data.qrExternal || data.qr}" alt="qr-ext" /></div>
            <p class="mono center" style="font-size:11px;word-break:break-all">${esc(data.endpoints?.external || '')}</p>
            <button class="btn btn-sm btn-ghost btn-block" id="qr-copy-e">复制 114 链接</button>
          </div>
        </div>
        <div class="btn-row center" style="margin-top:12px">
          <button class="btn btn-ghost" id="qr-copy-json">复制 JSON</button>
          <a class="btn btn-ghost" href="/api/clients/${id}/config?format=download">下载 JSON</a>
        </div>
        <pre class="code-block" style="margin-top:12px;max-height:120px;overflow:auto;font-size:11px">${esc(
          mobile
        )}</pre>
      `,
      actions: `<button class="btn btn-primary" data-close>关闭</button>`,
    });
    document.getElementById('qr-copy-m')?.addEventListener('click', async () => {
      try {
        await copyText(mobile);
        toast('已复制 211 链接');
      } catch (e) {
        toast(e.message, 'err');
      }
    });
    document.getElementById('qr-copy-e')?.addEventListener('click', async () => {
      try {
        await copyText(external);
        toast('已复制 114 链接');
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
      state.page = 'topology';
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
        <p class="muted">分层检查：入口 → IX 转发 → 家宽 Agent/mita</p>
      </div>
      <button class="btn btn-primary" id="d-refresh">重新诊断</button>
    </div>
    ${pathBanner()}
    <div class="card" id="d-box" style="margin-top:16px"><p class="muted">诊断中…</p></div>
  `);
  bindShell();
  const run = async () => {
    const box = document.getElementById('d-box');
    try {
      const d = await api('/api/diagnose');
      box.innerHTML = `
        <div class="diag-summary ${d.ok ? 'ok' : 'bad'}">
          <strong>${esc(d.summary)}</strong>
          <span class="muted">mieru · ${d.mode === 'agent' ? '远程家宽' : '本机'}</span>
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
          <button class="btn btn-ghost" data-nav-jump="topology">去拓扑</button>
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
      <p class="muted">版本 <strong>v${esc(state.status?.version || '')}</strong> · 协议 <strong>mieru / mita</strong></p>
      <p class="field-hint">拓扑：电脑 → 商家IX前置 → 沪日IX → 落地家宽。面板装独立 VPS。WireGuard 在此线路不可用。</p>
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
    if (!confirm('将 mita 配置下发到落地家宽。继续？')) return;
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
  if (!confirm('在落地家宽安装/配置 mita 并放行端口？不会改面板机/IX 网络。')) return;
  try {
    toast('正在一键落地…', 'warn');
    const res = await api('/api/exit/setup', { method: 'POST', body: {} });
    toast(res.message || '完成', res.ok ? 'ok' : 'err');
    if (res.pending) startJobPoll();
    openModal({
      title: '落地任务',
      body: `
        <p>${esc(res.message || '')}</p>
        <ol class="field-hint" style="padding-left:18px">
          <li>Agent 约 10 秒拉取任务</li>
          <li>在「拓扑」生成 IX 转发脚本并在沪日机 root 执行</li>
          <li>勾选「IX 转发已配置」</li>
          <li>本机客户端连商家前置 <strong>114/211</strong> mierus 链接</li>
        </ol>
        <div class="btn-row">
          <button class="btn btn-primary" id="ex-topo">去拓扑</button>
          <button class="btn btn-ghost" id="ex-clients">去客户端</button>
          <button class="btn btn-ghost" id="ex-diag">诊断</button>
        </div>
      `,
      actions: `<button class="btn btn-ghost" data-close>关闭</button>`,
    });
    document.getElementById('ex-topo')?.addEventListener('click', () => {
      closeModal();
      state.page = 'topology';
      render();
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
  if (state.page === 'topology') return renderTopology();
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
    state.mode = status.mode || 'agent';
    state.primaryNode = status.primaryNode;
    state.wizardDone = status.wizardDone;
    state.topology = status.topology || null;
    await refreshCore();
    await render();
  } catch (e) {
    renderBoot('加载失败: ' + e.message);
  }
}

boot();
