const app = document.getElementById('app');

const state = {
  status: null,
  server: null,
  topology: null,
  clients: [],
  nodes: [],
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
  selectedIxId: null,
  selectedLandingId: null,
  expandedLandingId: null,
  todoAlertsOpen: false,
  epBannerOpen: false,
  globalMitaOpen: false,
  // 客户端工作台
  clientsTabId: null,
  clientsFilter: 'all', // all | on | off | warn
  clientsQuery: '',
  clientsExpandedId: null,
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

function activeEp(ixId) {
  const t = topo();
  if (ixId) {
    const ix = (t.ixes || []).find((x) => x.id === ixId);
    if (ix?.endpoints?.active) return ix.endpoints.active;
  }
  const cur = currentIx();
  if (cur?.endpoints?.active) return cur.endpoints.active;
  return t.activeEndpoint || state.server?.endpoint || '';
}

function pathLabel() {
  return topo().pathLabel || '电脑/客户端 → 商家IX前置 → IX → 落地家宽 mita';
}

function currentIx() {
  const ixes = ixesList();
  if (!ixes.length) return null;
  const id = state.selectedIxId || ixes[0].id;
  return ixes.find((x) => x.id === id) || ixes[0];
}

function ixIngress(ix) {
  if (!ix) return {};
  return ix.ingress && typeof ix.ingress === 'object' ? ix.ingress : {};
}

function landingsForIx(ixId) {
  const all = landingsList();
  if (!ixId) return all;
  const bound = all.filter((L) => L.ixId === ixId);
  // 未绑 ix 的老数据在第一台 IX 工作台里可见
  if (bound.length) return bound;
  const ixes = ixesList();
  if (ixes[0]?.id === ixId) return all.filter((L) => !L.ixId || L.ixId === ixId);
  return bound;
}

function landingByNodeId(nodeId) {
  if (!nodeId) return null;
  return landingsList().find((L) => L.nodeId === nodeId) || null;
}

function ixName(id) {
  if (!id) return '—';
  const x = ixesList().find((i) => i.id === id);
  return x?.name || id.slice(0, 8);
}

/** 用户实际连接端口：个人 route → 所属落地 listenPort → 全局默认 */
function effectiveClientPort(c) {
  if (c?.route?.listenPort) return Number(c.route.listenPort);
  const nid = c?.route?.landingNodeId;
  if (nid) {
    const L = landingByNodeId(nid);
    if (L?.listenPort) return Number(L.listenPort);
    const n = (state.nodes || []).find((x) => x.id === nid);
    if (n?.listenPort) return Number(n.listenPort);
  }
  return Number(state.server?.listenPort) || 7901;
}

/** 商家前置 host（不含端口） */
function endpointHostOnly(ep) {
  const s = String(ep || '');
  if (!s) return '';
  // [ipv6]:port or host:port
  if (s.startsWith('[')) {
    const m = s.match(/^\[([^\]]+)\]/);
    return m ? m[1] : s;
  }
  const idx = s.lastIndexOf(':');
  if (idx > 0 && s.indexOf(':') === idx) return s.slice(0, idx);
  // bare host or multi-colon ipv6 without brackets
  return s.replace(/:\d+$/, '');
}

/** 多落地入口：默认折叠，避免顶栏挤满 */
function multiLandingEndpointBanner() {
  const host = endpointHostOnly(activeEp()) || '（先到拓扑填前置）';
  const nodes = state.nodes || [];
  const landings = landingsList();
  if (!nodes.length) {
    return `<div class="alert info compact"><div>默认 Endpoint：<code class="mono">${esc(
      activeEp() || '未配置'
    )}</code> · <span class="muted">只连前置，勿连 IX / 家宽</span></div></div>`;
  }
  if (nodes.length === 1) {
    const n = nodes[0];
    const L = landings.find((x) => x.nodeId === n.id) || {};
    const port = Number(L.listenPort || n.listenPort || 7901);
    return `<div class="alert info compact"><div>
      客户端连 <code class="mono">${esc(host)}:${port}</code>
      <span class="muted">· 只连前置，勿连 IX / 家宽公网</span>
    </div></div>`;
  }
  const rows = nodes
    .map((n) => {
      const L = landings.find((x) => x.nodeId === n.id) || {};
      const port = Number(L.listenPort || n.listenPort || 7901);
      const users = (state.clients || []).filter((c) => c.route?.landingNodeId === n.id).length;
      const tag = n.isPrimary ? ' · 默认' : '';
      return `<div class="ep-row"><strong>${esc(n.name)}</strong>${tag}
        → <code class="mono">${esc(host)}:${port}</code>
        <span class="muted">· :${port} · ${users} 用户 · IX ${esc(ixName(L.ixId))}</span></div>`;
    })
    .join('');
  const open = state.epBannerOpen ? 'open' : '';
  return `<div class="alert info ep-banner ${open}">
    <div class="ep-banner-head">
      <div>
        <strong>多落地入口</strong>
        <span class="muted"> · 每落地端口不同 · 只连前置，勿连 IX / 家宽</span>
      </div>
      <button type="button" class="btn btn-sm btn-ghost" id="ep-banner-toggle">${
        state.epBannerOpen ? '收起' : '展开'
      }</button>
    </div>
    <div class="ep-banner-body">${rows}
      <p class="field-hint" style="margin:6px 0 0">请点对应用户「链接」复制；不要混用其它落地端口的链接。</p>
    </div>
  </div>`;
}

/** 收集顶栏事项：只展示一条主告警 + 可选待办折叠 */
function collectAlertItems() {
  const items = [];
  if (state.status?.forcePasswordChange) {
    items.push({
      pri: 0,
      level: 'warn',
      title: '请修改初始密码',
      detail: '',
      actions: `<button class="btn btn-sm btn-primary" data-nav-jump="settings">去修改</button>`,
    });
  }
  const job = typeof pickJob === 'function' ? pickJob() : state.primaryNode?.latestJob;
  if (job && (job.status === 'error' || job.status === 'failed')) {
    items.push({
      pri: 1,
      level: 'danger',
      title: '任务失败',
      detail: job.message || '',
      actions: `<button class="btn btn-sm btn-primary" data-nav-jump="diagnose">诊断</button>`,
    });
  } else if (job && (job.status === 'pending' || job.status === 'running')) {
    items.push({
      pri: 2,
      level: 'warn',
      title: '任务执行中',
      detail: `${job.type || ''}（${job.status}）${job.message ? ' · ' + job.message : ''}`,
      actions: `<button class="btn btn-sm btn-ghost" id="banner-poll">刷新</button>`,
    });
  }
  const t = topo();
  if (t.forward && !t.forward.configured) {
    items.push({
      pri: 3,
      level: 'danger',
      title: 'IX 转发未配置',
      detail: '商家入口流量到不了家宽 mita',
      actions: `<button class="btn btn-sm btn-primary" data-nav-jump="topology">去拓扑</button>`,
    });
  }
  if (state.dirty) {
    items.push({
      pri: 4,
      level: 'warn',
      title: '有未应用的更改',
      detail: '需下发到落地 mita',
      actions: `<div class="btn-row">
        <button class="btn btn-sm btn-ghost" id="banner-diagnose">诊断</button>
        <button class="btn btn-sm btn-success" id="banner-apply">应用配置</button>
      </div>`,
    });
  }
  if (state.clientsNeedRescan) {
    items.push({
      pri: 5,
      level: 'warn',
      title: '连接参数已变',
      detail: '请重新复制/扫码 mierus 链接',
      actions: `<div class="btn-row">
        <button class="btn btn-sm btn-primary" data-nav-jump="clients">去客户端</button>
        <button class="btn btn-sm btn-ghost" id="banner-rescan-ack">我已更新</button>
      </div>`,
    });
  }
  const outdated = (state.nodes || []).filter(
    (n) => n.online && (n.agentOutdated || (state.status?.outdatedAgents || []).some((x) => x.id === n.id))
  );
  const outdatedFromStatus = (state.status?.outdatedAgents || []).filter((x) =>
    (state.nodes || []).some((n) => n.id === x.id && n.online)
  );
  if (isAgentMode() && (outdated.length || outdatedFromStatus.length)) {
    const names = outdated.length
      ? outdated.map((n) => `${n.name}(v${n.agentVersion || '?'})`).join('、')
      : outdatedFromStatus.map((n) => `${n.name}(v${n.agentVersion || '?'})`).join('、');
    items.push({
      pri: 6,
      level: 'warn',
      title: '落地 Agent 版本过旧',
      detail: `${names} · 面板 v${state.status?.version || ''} · 落地页「更新 Agent」`,
      actions: `<button class="btn btn-sm btn-primary" data-nav-jump="server">去落地</button>`,
    });
  }
  const offlineNodes = (state.nodes || []).filter((n) => !n.online);
  if (isAgentMode() && offlineNodes.length) {
    items.push({
      pri: 7,
      level: 'warn',
      title: `${offlineNodes.length} 台落地 Agent 离线`,
      detail: offlineNodes.map((n) => n.name).join('、'),
      actions: `<button class="btn btn-sm btn-primary" data-nav-jump="server">去落地</button>`,
    });
  } else if (isAgentMode() && state.primaryNode && !state.primaryNode.online) {
    items.push({
      pri: 7,
      level: 'warn',
      title: '落地家宽 Agent 离线',
      detail: '无法安装/更新 mita',
      actions: `<button class="btn btn-sm btn-primary" data-nav-jump="server">去安装</button>`,
    });
  }
  const blocked = (state.clients || []).filter((c) => c.statusFlags?.expired || c.statusFlags?.overQuota);
  if (blocked.length) {
    items.push({
      pri: 8,
      level: 'warn',
      title: `${blocked.length} 个用户到期/超额`,
      detail: '',
      actions: `<button class="btn btn-sm btn-primary" data-nav-jump="clients">去客户端</button>`,
    });
  }
  if (state.status?.legacyWireGuard) {
    items.push({
      pri: 9,
      level: 'info',
      title: '历史：曾从 WireGuard 迁到 mieru',
      detail: '请用客户端页的 mierus 链接',
      actions: `<button class="btn btn-sm btn-ghost" id="banner-legacy-dismiss" title="关闭此提示">知道了</button>`,
    });
  }
  items.sort((a, b) => a.pri - b.pri);
  return items;
}

function renderAlertHtml(it) {
  const detail = it.detail ? ` · ${esc(it.detail)}` : '';
  return `<div class="alert ${esc(it.level)}">
    <div><strong>${esc(it.title)}</strong>${detail}</div>
    ${it.actions || ''}
  </div>`;
}

function topAlerts() {
  const items = collectAlertItems();
  if (!items.length) return '';
  const primary = items[0];
  const rest = items.slice(1);
  let html = renderAlertHtml(primary);
  if (rest.length) {
    const open = state.todoAlertsOpen ? 'open' : '';
    html += `<div class="alert-todo ${open}">
      <button type="button" class="alert-todo-toggle" id="todo-alerts-toggle">
        另有 ${rest.length} 项待办 ${state.todoAlertsOpen ? '▴' : '▾'}
      </button>
      <div class="alert-todo-list">${rest.map(renderAlertHtml).join('')}</div>
    </div>`;
  }
  return html;
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
  document.getElementById('banner-legacy-dismiss')?.addEventListener('click', async () => {
    try {
      await api('/api/legacy-wg/dismiss', { method: 'POST', body: {} });
      if (state.status) state.status.legacyWireGuard = false;
      toast('已关闭迁移提示');
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  document.getElementById('todo-alerts-toggle')?.addEventListener('click', () => {
    state.todoAlertsOpen = !state.todoAlertsOpen;
    render();
  });
  document.getElementById('ep-banner-toggle')?.addEventListener('click', () => {
    state.epBannerOpen = !state.epBannerOpen;
    render();
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
        <h1>mieru 控制台</h1>
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
        <p class="sub">创建管理员账号。面板装<strong>独立 VPS</strong>只管理，不在业务链上。<br/>路径：电脑 → 商家IX前置 → IX → 落地家宽 mita。</p>
        <label for="su-user">管理员用户名</label>
        <input class="field" id="su-user" value="admin" autocomplete="username" />
        <p class="field-hint">建议保留 admin，或改为你自己的短英文名。</p>
        <label for="su-pass">登录密码（至少 6 位）</label>
        <div class="field-with-btn">
          <input class="field" id="su-pass" type="password" autocomplete="new-password" placeholder="设置强密码" />
          <button type="button" class="btn btn-secondary" id="su-toggle" title="显示或隐藏密码">显示</button>
        </div>
        <label for="su-pass2">确认密码</label>
        <input class="field" id="su-pass2" type="password" autocomplete="new-password" placeholder="再输入一次" />
        <div class="section-actions" style="border:0;padding-top:8px;margin-top:8px">
          <button class="btn btn-primary btn-block" id="su-go" title="创建账号并进入面板">完成初始化</button>
        </div>
      </div>
    </div>`;
  const passEl = document.getElementById('su-pass');
  let show = false;
  document.getElementById('su-toggle').onclick = () => {
    show = !show;
    passEl.type = show ? 'text' : 'password';
    document.getElementById('su-pass2').type = show ? 'text' : 'password';
    document.getElementById('su-toggle').textContent = show ? '隐藏' : '显示';
  };
  document.getElementById('su-go').onclick = async () => {
    const p1 = document.getElementById('su-pass').value;
    const p2 = document.getElementById('su-pass2').value;
    if (p1.length < 6) return toast('密码至少 6 位', 'err');
    if (p1 !== p2) return toast('两次密码不一致', 'err');
    try {
      await api('/api/setup', {
        method: 'POST',
        body: { username: val('su-user'), password: p1 },
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
        <p class="sub">Premium Ops · v${esc(state.status?.version || '')} · 多 IX / 多落地</p>
        <form id="li-form" autocomplete="on">
          <label for="li-user">用户名</label>
          <input class="field" id="li-user" name="username" type="text" autocomplete="username"
            autocapitalize="off" spellcheck="false"
            value="${esc(state.status?.defaultUsername || state.status?.username || 'admin')}" />
          <label for="li-pass">密码</label>
          <div class="field-with-btn">
            <input class="field" id="li-pass" name="password" type="password" inputmode="text"
              autocomplete="current-password" autocapitalize="off" spellcheck="false"
              placeholder="输入登录密码" />
            <button type="button" class="btn btn-secondary" id="li-toggle" title="显示或隐藏密码">显示</button>
          </div>
          <p class="field-hint">忘记密码：在<strong>面板机</strong>执行
            <code>sudo bash install.sh --reset-password '新密码'</code></p>
          <button type="submit" class="btn btn-primary btn-block" id="li-go" title="登录面板">登录</button>
        </form>
      </div>
    </div>`;
  const passEl = document.getElementById('li-pass');
  let hidden = true;
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
  }, 50);
}

function shell(content) {
  const nav = [
    ['dashboard', '概览', '◈'],
    ['topology', '拓扑', '⇄'],
    ['server', '落地', '◎'],
    ['clients', '客户端', '◉'],
    ['diagnose', '诊断', '✎'],
    ['settings', '设置', '⚙'],
  ];
  const onlineN = (state.nodes || []).filter((n) => n.online).length;
  const totalN = (state.nodes || []).length || (state.primaryNode ? 1 : 0);
  return `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand"><div class="logo sm">M</div><div>
          <div class="brand-title">mieru Console</div>
          <div class="brand-sub">v${esc(state.status?.version || '')} · Ops</div>
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
          <div class="mode-pill ${isAgentMode() ? 'agent' : 'local'}">${esc(exitLabel())}${totalN ? ` · ${onlineN}/${totalN}` : ''}</div>
          <button class="btn btn-sm btn-secondary btn-block" id="btn-logout" title="退出当前会话">退出登录</button>
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
  const [status, server, clients, overview, topology, nodesRes] = await Promise.all([
    api('/api/status'),
    api('/api/server'),
    api('/api/clients'),
    api('/api/exit/overview').catch(() => null),
    api('/api/topology').catch(() => null),
    api('/api/nodes').catch(() => null),
  ]);
  state.status = status;
  state.mode = status.mode || 'agent';
  state.primaryNode = status.primaryNode || null;
  state.nodes = status.nodes || nodesRes?.nodes || overview?.nodes || [];
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

function nodeName(id) {
  if (!id) return '默认落地';
  const n = (state.nodes || []).find((x) => x.id === id);
  return n?.name || id.slice(0, 8);
}

function ixesList() {
  const t = topo();
  return Array.isArray(t.ixes) && t.ixes.length ? t.ixes : t.ix ? [t.ix] : [];
}

function landingsList() {
  const t = topo();
  return Array.isArray(t.landings) && t.landings.length ? t.landings : [];
}

function pathBanner(ixOverride, opts = {}) {
  const compact = Boolean(opts.compact);
  const ix = ixOverride || currentIx() || {};
  const ep = ix.endpoints?.active || activeEp(ix.id);
  const range = ix.merchantPortRange || `${ix.portMin || 7900}-${ix.portMax || 7999}`;
  const fwdOk = Boolean(ix.forwardConfigured);
  const sideLandings = landingsForIx(ix.id);
  const onlineN = (state.nodes || []).filter((n) =>
    sideLandings.some((L) => L.nodeId === n.id && n.online)
  ).length;
  const tip = compact
    ? `端口段 ${esc(range)} · 只连前置，勿连 IX / 家宽`
    : `端口段 <strong>${esc(range)}</strong> · TCP · 只连前置，勿连 IX / 家宽`;
  return `
    <div class="path-banner ${compact ? 'compact' : ''}">
      <div class="path-flow">
        <span class="path-node">客户端</span>
        <span class="path-arrow">→</span>
        <span class="path-node on" title="商家前置">前置<br/><small class="mono">${esc(ep || '未配置')}</small></span>
        <span class="path-arrow">→</span>
        <span class="path-node ${fwdOk ? 'on' : 'warn'}" title="IX 转发">${esc(ix.name || 'IX')}<br/><small>${fwdOk ? '转发OK' : '待转发'}</small></span>
        <span class="path-arrow">→</span>
        <span class="path-node ${onlineN ? 'on' : ''}" title="落地 mita">落地×${sideLandings.length || 0}<br/><small>${onlineN} 在线</small></span>
        <span class="path-arrow">→</span>
        <span class="path-node">出网</span>
      </div>
      <p class="field-hint path-tip">${tip}</p>
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
      ${pathBanner(null, { compact: true })}
      <div class="alert info compact" style="margin-top:12px"><div>
        <strong>角色一览</strong>
        <span class="muted"> · 客户端连前置 · IX 只做转发 · 落地出网 · 面板只管理</span>
      </div></div>
      <p class="field-hint">协议 mieru TCP。只连前置，勿连 IX / 家宽公网。</p>
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
  const nodes = state.nodes || [];
  const onlineN = nodes.filter((n) => n.online).length;
  const ixN = ixesList().length;
  const blocked = state.clients.filter((c) => c.statusFlags?.expired || c.statusFlags?.overQuota).length;
  const dirtyN = nodes.filter((n) => n.dirty).length + (state.dirty ? 1 : 0);
  const recentClients = state.clients.slice(0, 8);
  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>概览</h2>
        <p class="muted">客户端 → 前置 → IX → 落地 · 只连前置</p>
      </div>
      <div class="btn-row dash-actions">
        <button class="btn btn-success" id="dash-apply" title="下发配置到全部落地">应用全部</button>
        <button class="btn btn-secondary" id="dash-topo" title="配置前置与转发">拓扑</button>
        <button class="btn btn-secondary" id="dash-clients" title="管理用户">客户端</button>
        <button class="btn btn-ghost" id="dash-exit" title="在默认落地安装/启动 mita">一键落地</button>
      </div>
    </div>
    ${pathBanner(null, { compact: true })}
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-label">前置 Endpoint</div>
        <div class="stat-value small mono">${esc(activeEp() || '未填')}</div>
        <div class="stat-foot">客户端只连这里</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">IX · 落地在线</div>
        <div class="stat-value">${ixN}<span class="sub"> IX</span> · ${onlineN}<span class="sub">/${nodes.length || 1}</span></div>
        <div class="stat-foot">Agent 心跳在线</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">默认 mita</div>
        <div class="stat-value ${mita?.running ? 'ok-text' : ''}">${mita?.running ? 'RUNNING' : mita?.status || '未知'}</div>
        <div class="stat-foot">出网出口状态</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">用户${blocked ? ' · 告警' : ''}</div>
        <div class="stat-value">${state.clients.length}${
          blocked ? `<span class="sub warn-text"> · ${blocked}⚠</span>` : ''
        }${dirtyN ? `<span class="sub warn-text"> · 未应用</span>` : ''}</div>
        <div class="stat-foot">启用 / 到期 / 下发</div>
      </div>
    </div>
    <div class="dash-meta" style="margin-top:14px">
      监听 <span class="mono">${esc(s.protocol || 'TCP')}:${esc(s.listenPort || 7901)}</span>
      · 出网 <span class="mono">${esc(ov.exitPublicIp || state.primaryNode?.exitPublicIp || '—')}</span>
      · 最近应用 ${esc(fmtTime(state.lastAppliedAt))}
    </div>
    <div class="mod-grid two" style="margin-top:16px">
      ${
        nodes.length
          ? `<div class="mod">
        <div class="mod-head"><h3>落地</h3>
          <button class="btn btn-sm btn-ghost" data-nav-jump="server">管理</button>
        </div>
        <div class="mod-body pad-sm">
          <div class="dash-list">
          ${nodes
            .map((n) => {
              const L = landingByNodeId(n.id) || {};
              const port = L.listenPort || n.listenPort || 7901;
              return `<div class="dash-list-row">
                <div>
                  <strong>${esc(n.name)}</strong>
                  ${n.isPrimary ? '<span class="badge ok">默认</span>' : ''}
                  ${
                    n.online
                      ? '<span class="status-dot ok">在线</span>'
                      : '<span class="status-dot warn">离线</span>'
                  }
                  ${n.dirty ? '<span class="badge warn">未应用</span>' : ''}
                </div>
                <div class="muted mono">:${esc(port)} · mita ${esc(n.mita?.status || '-')} · ${
                  n.clientCount ?? 0
                } 用户</div>
              </div>`;
            })
            .join('')}
          </div>
        </div>
      </div>`
          : '<div class="mod"><div class="empty-mod"><strong>还没有落地</strong><p>到「落地」页添加</p></div></div>'
      }
      <div class="mod">
        <div class="mod-head"><h3>用户</h3>
          <button class="btn btn-sm btn-primary" id="dash-add" title="添加客户端用户">添加</button>
        </div>
        <div class="mod-body pad-sm">
        ${
          recentClients.length
            ? `<div class="dash-list">
            ${recentClients
              .map(
                (c) => `<div class="dash-list-row">
              <div>
                <span class="mono">${esc(c.name)}</span>
                ${c.note ? `<span class="muted" style="font-size:12px"> · ${esc(c.note)}</span>` : ''}
                ${
                  c.statusFlags?.expired
                    ? '<span class="badge warn">到期</span>'
                    : c.statusFlags?.overQuota
                      ? '<span class="badge warn">超额</span>'
                      : c.enabled === false
                        ? '<span class="badge">停用</span>'
                        : ''
                }
              </div>
              <div class="dash-list-ops">
                <span class="muted" style="font-size:12px">${esc(nodeName(c.route?.landingNodeId))}</span>
                <button class="btn btn-sm btn-primary" data-qr="${c.id}" title="分享">分享</button>
              </div>
            </div>`
              )
              .join('')}
            ${
              state.clients.length > recentClients.length
                ? `<p class="field-hint" style="margin:8px 0 0">共 ${state.clients.length} 用户 · <a href="#" data-nav-jump="clients">查看全部</a></p>`
                : ''
            }
          </div>`
            : '<p class="muted" style="margin:0">还没有用户</p>'
        }
        </div>
      </div>
    </div>
  `);
  bindShell();
  document.getElementById('dash-exit').onclick = () => setupExit();
  document.getElementById('dash-apply').onclick = () => applyConfig(true, { all: true });
  document.getElementById('dash-topo').onclick = () => {
    state.page = 'topology';
    render();
  };
  document.getElementById('dash-clients').onclick = () => {
    state.page = 'clients';
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
  const ixes = ixesList();
  if (!state.selectedIxId && ixes[0]) state.selectedIxId = ixes[0].id;
  const ix = currentIx() || ixes[0] || t.ix || {};
  const ing = ixIngress(ix);
  const sideLandings = landingsForIx(ix.id);
  let curLandingId = state.selectedLandingId;
  if (!curLandingId || !sideLandings.find((L) => L.id === curLandingId)) {
    curLandingId = sideLandings[0]?.id || null;
    state.selectedLandingId = curLandingId;
  }
  const landing = sideLandings.find((L) => L.id === curLandingId) || sideLandings[0] || {};
  const script = state.forwardScript || '';
  const homeHost = landing.homeReachableHost || ix.homeReachableHost || '';
  const homePort =
    landing.homeReachablePort || landing.listenPort || ix.homeReachablePort || t.ingress?.port || 7901;
  const portMin = ix.portMin || 7900;
  const portMax = ix.portMax || 7999;
  const active = ing.active || 'external';

  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>拓扑 · IX 工作台</h2>
        <p class="muted">每台 IX 独立前置 IP/域名 + 端口段 · 本侧落地</p>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="topo-save" title="保存当前 IX 的前置/机器/落地转发参数">保存本 IX</button>
        <button class="btn btn-secondary" id="topo-diag" title="检查入口、转发与落地状态">诊断</button>
      </div>
    </div>

    <div class="ix-tabs" id="ix-tabs">
      ${ixes
        .map(
          (x) =>
            `<button type="button" class="ix-tab ${x.id === ix.id ? 'on' : ''}" data-ix-tab="${esc(x.id)}" title="点击切换 · 双击可改名">${esc(
              x.name || 'IX'
            )}<small class="mono">${esc(x.lanIp || '')}</small></button>`
        )
        .join('')}
      <button type="button" class="ix-tab add" id="t-add-ix">+ 添加 IX</button>
    </div>
    <p class="field-hint" style="margin:8px 0 0">上方标签显示名称可自定义：改下方「IX 显示名称」后点「保存本 IX」，或<strong>双击标签</strong>快速改名。</p>

    ${pathBanner(ix)}

    <div class="mod endpoint-card" style="margin-top:16px">
      <div class="mod-head">
        <h3><span class="mod-num">1</span> 本 IX 商家前置</h3>
        <span class="badge ok">端口段 ${esc(portMin)}–${esc(portMax)}</span>
      </div>
      <div class="mod-body">
      <p class="field-hint" style="margin-top:0">每 IX 独立前置 · Host 可填 IP/域名 · <strong>客户端只填前置</strong></p>
      <div class="choice-grid" style="margin:10px 0">
        <button type="button" class="choice-card ${active === 'external' || !active ? 'selected' : ''}" data-act="external">
          <strong>外部前置 114</strong>
          <span>当前选用下方 114 地址</span>
        </button>
        <button type="button" class="choice-card ${active === 'mobile' ? 'selected' : ''}" data-act="mobile">
          <strong>移动宽带前置 211</strong>
          <span>当前选用下方 211 地址</span>
        </button>
        <button type="button" class="choice-card ${active === 'custom' ? 'selected' : ''}" data-act="custom">
          <strong>自定义 / 域名</strong>
          <span>填自定义 Host</span>
        </button>
      </div>
      <div class="inline-fields">
        <div>
          <label>外部前置 114（IP 或域名）</label>
          <input class="field mono" id="t-ext" value="${esc(ing.externalHost || '114.111.176.37')}" placeholder="114.x 或 domain" />
        </div>
        <div>
          <label>移动宽带前置 211（IP 或域名）</label>
          <input class="field mono" id="t-mob" value="${esc(ing.mobileHost || '211.136.162.184')}" placeholder="211.x 或 domain" />
        </div>
        <div>
          <label>自定义 Host / 域名</label>
          <input class="field mono" id="t-custom" value="${esc(ing.customHost || '')}" placeholder="可选，如 front.example.com" />
        </div>
      </div>
      <div class="inline-fields" style="margin-top:8px">
        <div>
          <label>本 IX 端口下限</label>
          <input class="field mono" id="t-pmin" value="${esc(portMin)}" />
        </div>
        <div>
          <label>本 IX 端口上限</label>
          <input class="field mono" id="t-pmax" value="${esc(portMax)}" />
        </div>
        <div>
          <label>默认端口</label>
          <input class="field mono" id="t-port" value="${esc(t.ingress?.port || landing.listenPort || 7901)}" />
        </div>
        <div>
          <label>白名单提示</label>
          <input class="field" id="t-province" value="${esc(ing.provinceWhitelist || '商家白名单（如有）')}" />
        </div>
      </div>
      <div class="kv"><span>本 IX 当前 Endpoint</span><span class="mono">${esc(ix.endpoints?.active || activeEp(ix.id) || '—')}</span></div>
      </div>
    </div>

    <div class="mod" style="margin-top:16px">
      <div class="mod-head">
        <h3><span class="mod-num">2</span> 本 IX 机器</h3>
        <button class="btn btn-sm btn-danger" id="t-del-ix" ${ixes.length <= 1 ? 'disabled' : ''} title="删除当前 IX（至少保留一台）">删除本 IX</button>
      </div>
      <div class="mod-body">
      <div class="inline-fields">
        <div>
          <label>IX 显示名称</label>
          <input class="field" id="t-ix-name" value="${esc(ix.name || '')}" placeholder="如 沪日IX / 东京IX" maxlength="40" />
          <p class="field-hint" style="margin-top:4px">标签、路径条、落地「所属 IX」下拉均用此名称</p>
        </div>
        <div>
          <label>内网 IP</label>
          <input class="field mono" id="t-ix-lan" value="${esc(ix.lanIp || '172.16.2.79')}" />
        </div>
        <div>
          <label>SSH 端口</label>
          <input class="field mono" id="t-ix-ssh" value="${esc(ix.sshPort || 7900)}" />
        </div>
      </div>
      <label class="check-row">
        <input type="checkbox" id="t-fwd-ok" ${ix.forwardConfigured ? 'checked' : ''} />
        此 IX 已整段执行脚本且探测 OK
      </label>
      </div>
    </div>

    <div class="mod" style="margin-top:16px">
      <div class="mod-head">
        <h3><span class="mod-num">3</span> 本 IX 落地（${sideLandings.length}）</h3>
        <button class="btn btn-sm btn-secondary" data-nav-jump="server" title="打开落地列表与详情">管理落地</button>
      </div>
      <div class="mod-body">
      ${
        sideLandings.length
          ? `<div class="utable-wrap"><table class="utable"><thead><tr><th>名称</th><th>端口</th><th>Agent</th><th>出网</th><th></th></tr></thead><tbody>
          ${sideLandings
            .map((L) => {
              const n = (state.nodes || []).find((x) => x.id === L.nodeId);
              return `<tr>
                <td>${esc(L.name)}${n?.isPrimary ? ' <span class="badge ok">默认</span>' : ''}</td>
                <td class="mono">:${esc(L.listenPort || 7901)}</td>
                <td>${
                  n
                    ? n.online
                      ? '<span class="status-dot ok">在线</span>'
                      : '<span class="status-dot warn">离线</span>'
                    : '<span class="status-dot muted">未绑</span>'
                }</td>
                <td class="mono">${esc(n?.exitPublicIp || '—')}</td>
                <td><button class="btn btn-sm btn-secondary" data-open-landing="${esc(L.nodeId || L.id)}" title="打开落地详情">详情</button></td>
              </tr>`;
            })
            .join('')}
        </tbody></table></div>`
          : '<p class="muted" style="margin:0">本 IX 下暂无落地。到「落地」页添加并绑定本 IX。</p>'
      }
      </div>
    </div>

    <div class="mod" style="margin-top:16px">
      <div class="mod-head">
        <h3><span class="mod-num">4</span> 转发脚本（本 IX → 落地）</h3>
        <span class="badge ${ix.forwardConfigured ? 'ok' : 'warn'}">${ix.forwardConfigured ? '已标记' : '未配置'}</span>
      </div>
      <div class="mod-body">
      <div class="inline-fields">
        <div>
          <label>目标落地</label>
          <select class="field" id="t-landing-sel">
            ${sideLandings
              .map(
                (L) =>
                  `<option value="${esc(L.id)}" ${L.id === landing.id ? 'selected' : ''}>${esc(L.name)} · :${esc(
                    L.listenPort || 7901
                  )}</option>`
              )
              .join('') || '<option value="">（请先在落地页添加）</option>'}
          </select>
        </div>
        <div>
          <label>监听端口（前置侧）</label>
          <input class="field mono" id="t-fwd-port" value="${esc(landing.listenPort || t.ingress?.port || 7901)}" />
        </div>
        <div>
          <label>家宽可达地址</label>
          <input class="field mono" id="t-home" value="${esc(homeHost)}" placeholder="家宽公网 IP" />
        </div>
        <div>
          <label>家宽 mita 端口</label>
          <input class="field mono" id="t-home-port" value="${esc(homePort)}" />
        </div>
      </div>
      <div class="alert info compact" style="margin-top:12px"><div>
        <strong>顺序</strong>
        <span class="muted"> · 落地 mita 在听 → IX 整文件跑脚本 → 勾选已配置 → 客户端只连前置</span>
      </div></div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-sm btn-primary" id="t-load-script" title="按本 IX × 落地生成 DNAT 脚本">生成/刷新转发脚本</button>
        <button class="btn btn-sm btn-secondary" id="t-copy-script" ${script ? '' : 'disabled'} title="复制脚本到剪贴板">复制脚本</button>
        <a class="btn btn-sm btn-secondary" id="t-dl-script" href="/api/topology/forward-script?download=1" title="下载 .sh 文件">下载 .sh</a>
      </div>
      <pre class="code-block" id="t-script" style="margin-top:10px;max-height:220px;overflow:auto">${esc(
        script || '（先填家宽可达地址并生成）'
      )}</pre>
      </div>
    </div>
  `);
  bindShell();

  let activeChoice = active;
  document.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = () => {
      activeChoice = b.dataset.act;
      document.querySelectorAll('[data-act]').forEach((x) => x.classList.remove('selected'));
      b.classList.add('selected');
    };
  });

  // 单击切换（延迟，避免与双击改名冲突）；双击改名
  document.querySelectorAll('[data-ix-tab]').forEach((b) => {
    let clickTimer = null;
    b.onclick = (ev) => {
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(async () => {
        clickTimer = null;
        try {
          await saveCurrentIx(activeChoice);
        } catch {
          /* */
        }
        state.selectedIxId = b.dataset.ixTab;
        state.selectedLandingId = null;
        state.forwardScript = '';
        render();
      }, 280);
    };
    b.ondblclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      const id = b.dataset.ixTab;
      const cur = (ixesList().find((x) => x.id === id) || {}).name || '';
      const name = prompt('IX 显示名称', cur);
      if (name === null) return;
      const trimmed = String(name).trim();
      if (!trimmed) return toast('名称不能为空', 'err');
      if (trimmed.length > 40) return toast('名称太长（最多 40 字）', 'err');
      try {
        // 保留当前表单其它字段；只改被双击那台 IX 的名称
        const latest = collectIxes().map((x) => (x.id === id ? { ...x, name: trimmed } : x));
        // 若双击的不是当前 IX，collectIxes 仍带当前表单，名称改在目标 id 上
        if (!latest.some((x) => x.id === id)) {
          const all = ixesList().map((x) =>
            x.id === id ? { ...x, name: trimmed } : { ...x, ingress: { ...(x.ingress || {}) } }
          );
          const r = await api('/api/topology', {
            method: 'PUT',
            body: {
              ingress: {
                active: activeChoice,
                port: Number(val('t-port')) || 7901,
                externalHost: val('t-ext'),
                mobileHost: val('t-mob'),
                customHost: val('t-custom'),
                provinceWhitelist: val('t-province'),
                protocol: 'TCP',
              },
              ixId: ix.id,
              ixes: all,
              landings: collectLandings(),
            },
          });
          state.topology = r.topology;
        } else {
          const r = await api('/api/topology', {
            method: 'PUT',
            body: {
              ingress: {
                active: activeChoice,
                port: Number(val('t-port')) || 7901,
                externalHost: val('t-ext'),
                mobileHost: val('t-mob'),
                customHost: val('t-custom'),
                provinceWhitelist: val('t-province'),
                protocol: 'TCP',
              },
              ixId: ix.id,
              ixes: latest,
              landings: collectLandings(),
            },
          });
          state.topology = r.topology;
        }
        state.selectedIxId = id;
        toast(`IX 已改名为「${trimmed}」`);
        await refreshCore();
        render();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  });

  document.querySelectorAll('[data-open-landing]').forEach((b) => {
    b.onclick = () => {
      state.expandedLandingId = b.dataset.openLanding;
      state.page = 'server';
      render();
    };
  });

  const collectIxes = () => {
    const list = ixes.map((x) => ({ ...x, ingress: { ...(x.ingress || {}) } }));
    const idx = list.findIndex((x) => x.id === ix.id);
    const target = list[idx >= 0 ? idx : 0];
    if (target) {
      const nm = String(val('t-ix-name') || '').trim();
      target.name = nm || target.name || 'IX';
      target.lanIp = val('t-ix-lan');
      target.sshPort = Number(val('t-ix-ssh')) || 7900;
      target.portMin = Number(val('t-pmin')) || 7900;
      target.portMax = Number(val('t-pmax')) || 7999;
      target.forwardConfigured = document.getElementById('t-fwd-ok')?.checked;
      target.homeReachableHost = val('t-home') || target.homeReachableHost;
      target.homeReachablePort = Number(val('t-home-port')) || target.homeReachablePort;
      target.ingress = {
        active: activeChoice,
        externalHost: val('t-ext'),
        mobileHost: val('t-mob'),
        customHost: val('t-custom'),
        provinceWhitelist: val('t-province'),
      };
    }
    return list;
  };

  const collectLandings = () => {
    const all = landingsList().map((L) => ({ ...L }));
    const sel = document.getElementById('t-landing-sel')?.value;
    const target = all.find((L) => L.id === sel);
    if (target) {
      target.homeReachableHost = val('t-home');
      target.homeReachablePort = Number(val('t-home-port')) || target.homeReachablePort;
      target.listenPort = Number(val('t-fwd-port')) || target.listenPort;
      if (!target.ixId) target.ixId = ix.id;
    }
    return all;
  };

  async function saveCurrentIx(act) {
    if (act) activeChoice = act;
    const r = await api('/api/topology', {
      method: 'PUT',
      body: {
        ingress: {
          active: activeChoice,
          port: Number(val('t-port')) || 7901,
          externalHost: val('t-ext'),
          mobileHost: val('t-mob'),
          customHost: val('t-custom'),
          provinceWhitelist: val('t-province'),
          protocol: 'TCP',
        },
        ixId: ix.id,
        ixes: collectIxes(),
        landings: collectLandings(),
      },
    });
    state.topology = r.topology;
    state.server = r.server;
    state.dirty = r.dirty;
    state.clientsNeedRescan = Boolean(r.clientsNeedRescan);
    return r;
  }

  const scriptQs = () => {
    const ixId = ix.id || '';
    const landingId = document.getElementById('t-landing-sel')?.value || '';
    const port = Number(val('t-fwd-port')) || '';
    const q = new URLSearchParams();
    if (ixId) q.set('ixId', ixId);
    if (landingId) q.set('landingId', landingId);
    if (port) q.set('port', String(port));
    return q.toString();
  };

  document.getElementById('t-landing-sel')?.addEventListener('change', () => {
    state.selectedLandingId = document.getElementById('t-landing-sel').value;
    render();
  });

  document.getElementById('t-add-ix')?.addEventListener('click', async () => {
    try {
      await saveCurrentIx(activeChoice).catch(() => {});
      const list = collectIxes();
      const defName = `IX-${list.length + 1}`;
      const nameIn = prompt('新 IX 显示名称', defName);
      if (nameIn === null) return;
      const ixNameNew = String(nameIn).trim() || defName;
      const nid = 'ix-' + Math.random().toString(16).slice(2, 8);
      list.push({
        id: nid,
        name: ixNameNew,
        lanIp: '172.16.2.79',
        sshPort: 7900,
        portMin: 7900,
        portMax: 7999,
        forwardConfigured: false,
        homeReachableHost: '',
        homeReachablePort: Number(val('t-port')) || 7901,
        ingress: {
          active: 'external',
          externalHost: val('t-ext') || '114.111.176.37',
          mobileHost: val('t-mob') || '211.136.162.184',
          customHost: '',
          provinceWhitelist: val('t-province') || '',
        },
      });
      await api('/api/topology', { method: 'PUT', body: { ixes: list } });
      state.selectedIxId = nid;
      state.selectedLandingId = null;
      toast(`已添加 IX「${ixNameNew}」（请改本机前置 IP/端口段）`);
      await refreshCore();
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  document.getElementById('t-del-ix')?.addEventListener('click', async () => {
    if (ixes.length <= 1) return;
    if (!confirm('删除当前 IX？其落地绑定需另行调整。')) return;
    try {
      const list = collectIxes().filter((x) => x.id !== ix.id);
      await api('/api/topology', { method: 'PUT', body: { ixes: list } });
      state.selectedIxId = list[0]?.id;
      toast('已删除');
      await refreshCore();
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  document.getElementById('topo-save').onclick = async () => {
    try {
      const nm = String(val('t-ix-name') || '').trim();
      if (!nm) return toast('请填写 IX 显示名称', 'err');
      const r = await saveCurrentIx(activeChoice);
      toast(r.tip || `本 IX「${nm}」已保存`);
      const qs = scriptQs();
      const topoRes = await api('/api/topology' + (qs ? '?' + qs : ''));
      state.forwardScript = topoRes.forwardScript || '';
      state.topology = topoRes.topology;
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  document.getElementById('t-load-script').onclick = async () => {
    try {
      await saveCurrentIx(activeChoice);
      const qs = scriptQs();
      const topoRes = await api('/api/topology' + (qs ? '?' + qs : ''));
      state.forwardScript = topoRes.forwardScript || '';
      state.topology = topoRes.topology;
      const a = document.getElementById('t-dl-script');
      if (a) a.href = '/api/topology/forward-script?download=1&' + qs;
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
        const qs = scriptQs();
        const topoRes = await api('/api/topology' + (qs ? '?' + qs : ''));
        state.forwardScript = topoRes.forwardScript || '';
      }
      await copyText(state.forwardScript);
      toast('已复制转发脚本');
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  const dl = document.getElementById('t-dl-script');
  if (dl) dl.href = '/api/topology/forward-script?download=1&' + scriptQs();

  document.getElementById('topo-diag').onclick = () => {
    state.page = 'diagnose';
    render();
  };
}

/* ========== 落地 ========== */
async function renderServer() {
  await refreshCore().catch(() => {});
  const s = state.server || {};
  const agent = isAgentMode();
  const nodes = state.nodes || [];
  const landings = landingsList();
  const ixes = ixesList();
  const expanded = state.expandedLandingId;
  const globalOpen = state.globalMitaOpen;
  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>落地</h2>
        <p class="muted">列表展开详情 · Agent + mita · 绑定 IX</p>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="srv-add" title="新增一台落地家宽节点">添加落地</button>
        <button class="btn btn-success" id="srv-apply-all" title="把用户配置下发到全部落地 mita">应用全部</button>
        <button class="btn btn-secondary" id="srv-update-agents" title="向所有在线落地排队更新 Agent">全部更新 Agent</button>
      </div>
    </div>

    <div class="card mode-card compact-card">
      <div class="card-head">
        <h3>出口模式</h3>
        <span class="badge ${agent ? 'ok' : 'warn'}">${agent ? '远程家宽' : '本机'}</span>
      </div>
      <div class="btn-row">
        <button class="btn btn-sm ${agent ? 'btn-primary' : 'btn-secondary'}" id="mode-agent" title="Agent 装在落地家宽">远程家宽 Agent</button>
        <button class="btn btn-sm ${!agent ? 'btn-primary' : 'btn-secondary'}" id="mode-local" title="不推荐：mita 跑在面板本机">面板本机（不推荐）</button>
      </div>
    </div>

    <div style="margin-top:16px">
      <div class="card-head" style="margin-bottom:10px">
        <h3 style="margin:0;font-size:14px">落地列表</h3>
        <span class="muted" style="font-size:12px">单击展开 · 双击改名</span>
      </div>
      ${
        nodes.length
          ? nodes
              .map((n) => {
                const L = landings.find((x) => x.nodeId === n.id) || {};
                const isOpen = expanded === n.id;
                const userN = (state.clients || []).filter((c) => c.route?.landingNodeId === n.id).length;
                const ixOpts = ixes
                  .map(
                    (x) =>
                      `<option value="${esc(x.id)}" ${
                        (L.ixId || ixes[0]?.id) === x.id ? 'selected' : ''
                      }>${esc(x.name)} · ${esc(x.portMin || 7900)}–${esc(x.portMax || 7999)}</option>`
                  )
                  .join('');
                return `<div class="landing-row ${isOpen ? '' : 'collapsed'}" data-landing-row="${esc(n.id)}">
          <div class="landing-row-head" data-toggle-landing="${esc(n.id)}">
            <div class="title">
              <span class="chev">▶</span>
              <strong>${esc(n.name)}</strong>
              ${n.isPrimary ? '<span class="badge ok">默认</span>' : ''}
              ${n.online ? '<span class="badge ok">在线</span>' : '<span class="badge warn">离线</span>'}
              ${n.dirty ? '<span class="badge warn">未应用</span>' : ''}
              ${n.agentOutdated ? '<span class="badge warn" title="点「更新 Agent」对齐面板版本">Agent 过旧</span>' : ''}
            </div>
            <div class="landing-row-meta">
              <span>mita <span class="mono">${esc(n.mita?.status || '-')}</span></span>
              <span>端口 <span class="mono">:${esc(L.listenPort || n.listenPort || 7901)}</span></span>
              <span>IX ${esc(ixName(L.ixId || ixes[0]?.id))}</span>
              <span>用户 ${userN || n.clientCount || 0}</span>
              <span class="mono">${esc(n.exitPublicIp || '出网—')}</span>
            </div>
          </div>
          <div class="landing-row-body">
            <div class="kv"><span>主机 / Agent</span><span class="mono">${esc(n.hostname || '-')} · v${esc(
              n.agentVersion || '-'
            )}${n.agentOutdated ? ' ⚠ 需更新至面板 v' + esc(n.panelVersion || state.status?.version || '') : ''}</span></div>
            <div class="kv"><span>出网 IP</span><span class="mono">${esc(n.exitPublicIp || '-')}</span></div>
            <div class="inline-fields" style="margin-top:10px">
              <div>
                <label>落地显示名称</label>
                <input class="field" id="n-name-${n.id}" value="${esc(n.name || '')}" placeholder="如 pro3 / 家宽-北京" maxlength="40" />
              </div>
              <div>
                <label>所属 IX</label>
                <select class="field" id="n-ix-${n.id}">${ixOpts || '<option value="">—</option>'}</select>
              </div>
              <div>
                <label>本落地监听端口</label>
                <input class="field mono" id="n-port-${n.id}" value="${esc(L.listenPort || n.listenPort || 7901)}" title="同 IX 多落地须不同，如 7902" />
              </div>
              <div>
                <label>家宽可达地址（IX→家宽）</label>
                <input class="field mono" id="n-home-${n.id}" value="${esc(L.homeReachableHost || '')}" placeholder="家宽公网 IP 或隧道" />
              </div>
            </div>
            <p class="field-hint">保存后到「拓扑」生成该 IX 转发脚本。改端口后需「应用配置」。</p>
            <div class="landing-actions">
              <div class="btn-row landing-actions-primary">
                <button class="btn btn-sm btn-primary" data-save-node="${n.id}" title="保存本机名称/端口/IX/可达地址">保存配置</button>
                <button class="btn btn-sm btn-success" data-exit-node="${n.id}" title="安装/启动 mita 并套用基础参数">一键落地</button>
                <button class="btn btn-sm btn-success" data-apply-node="${n.id}" title="下发本机用户到 mita" ${userN ? '' : 'disabled'}>应用配置</button>
                <button class="btn btn-sm btn-secondary" data-users-node="${n.id}" title="查看绑定到本落地的客户端">本机用户</button>
                ${userN ? '' : '<span class="muted" style="font-size:12px">0 用户 · 先到客户端绑定</span>'}
              </div>
              <details class="landing-more">
                <summary>更多操作 · Agent / 危险</summary>
                <div class="btn-row" style="margin-top:8px">
                  <button class="btn btn-sm ${n.agentOutdated ? 'btn-warn' : 'btn-secondary'}" data-update-agent="${n.id}" title="在线时远程拉取面板最新 Agent 并重启" ${n.online ? '' : 'disabled'}>${n.agentOutdated ? '更新 Agent ⚠' : '更新 Agent'}</button>
                  <button class="btn btn-sm btn-secondary" data-cmd-node="${n.id}" title="复制 Agent 安装命令（离线/首次用）">安装命令</button>
                  ${n.isPrimary ? '' : `<button class="btn btn-sm btn-secondary" data-primary-node="${n.id}" title="未指定路由的用户落到此机">设为默认</button>`}
                  <button class="btn btn-sm btn-warn" data-rotate-node="${n.id}" title="旧 Agent 将失效，需重装">轮换 Token</button>
                  ${nodes.length > 1 ? `<button class="btn btn-sm btn-danger" data-del-node="${n.id}" title="删除节点；用户改绑默认落地">删除</button>` : ''}
                </div>
              </details>
            </div>
            <pre class="code-block" id="cmd-${n.id}" style="display:none;margin-top:8px"></pre>
          </div>
        </div>`;
              })
              .join('')
          : '<div class="card"><p class="muted">还没有落地。点「添加落地」或切换远程模式。</p></div>'
      }
    </div>

    <div class="card fold-card ${globalOpen ? 'open' : ''}" style="margin-top:16px">
      <div class="card-head fold-head" id="global-mita-toggle" role="button" tabindex="0">
        <h3>全局 mita 默认参数 <span class="muted" style="font-weight:500;font-size:12px">（非单落地端口）</span></h3>
        <span class="muted" style="font-size:12px">${globalOpen ? '收起 ▴' : '展开 ▾'}</span>
      </div>
      <div class="fold-body">
        <p class="card-desc">影响分享链默认 / 新建落地参考。
          <strong>改某台落地端口：展开上方列表 → 监听端口 → 保存</strong>。
          同 IX 多落地须不同端口。前置到「拓扑」。</p>
        <div class="kv"><span>当前默认 Endpoint</span><span class="mono">${esc(activeEp() || '未配置')}</span></div>
        <p class="field-hint"><a href="#" id="srv-to-topo">到「拓扑」修改前置与转发</a></p>
        <div class="inline-fields">
          <div>
            <label>全局默认端口</label>
            <input class="field mono" id="s-port" value="${esc(s.listenPort || 7901)}" title="不要用这里改单落地端口" />
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
        <p class="field-hint">商家入口请保持 <strong>TCP</strong>。</p>
        <div class="section-actions">
          <button class="btn btn-primary" id="srv-save" title="保存全局 mita 参数">保存全局参数</button>
          <button class="btn btn-primary" id="srv-save-2" title="保存全局 mita 参数" style="display:none">保存</button>
        </div>
      </div>
    </div>
  `);
  bindShell();

  document.getElementById('global-mita-toggle')?.addEventListener('click', () => {
    state.globalMitaOpen = !state.globalMitaOpen;
    render();
  });
  document.getElementById('global-mita-toggle')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      state.globalMitaOpen = !state.globalMitaOpen;
      render();
    }
  });

  document.querySelectorAll('[data-toggle-landing]').forEach((el) => {
    let tmr = null;
    el.onclick = () => {
      if (tmr) clearTimeout(tmr);
      tmr = setTimeout(() => {
        tmr = null;
        const id = el.dataset.toggleLanding;
        state.expandedLandingId = state.expandedLandingId === id ? null : id;
        render();
      }, 260);
    };
    el.ondblclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (tmr) {
        clearTimeout(tmr);
        tmr = null;
      }
      const id = el.dataset.toggleLanding;
      const node = (state.nodes || []).find((n) => n.id === id);
      if (!node) return;
      const name = prompt('落地显示名称', node.name || '');
      if (name === null) return;
      const trimmed = String(name).trim();
      if (!trimmed) return toast('名称不能为空', 'err');
      if (trimmed.length > 40) return toast('名称太长（最多 40 字）', 'err');
      try {
        await api(`/api/nodes/${id}`, { method: 'PUT', body: { name: trimmed } });
        toast(`落地已改名为「${trimmed}」`);
        state.expandedLandingId = id;
        await refreshCore();
        render();
      } catch (e) {
        toast(e.data?.error || e.message, 'err');
      }
    };
  });

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

  document.getElementById('srv-add')?.addEventListener('click', async () => {
    const name = prompt('落地名称', `落地-${(state.nodes || []).length + 1}`);
    if (name === null) return;
    try {
      const r = await api('/api/nodes', {
        method: 'POST',
        body: {
          name: name || undefined,
          template: 'cm',
          ixId: state.selectedIxId || ixesList()[0]?.id || null,
        },
      });
      const p = r.landing?.listenPort || r.node?.listenPort;
      toast(p ? `已创建落地 · 自动端口 ${p}` : '已创建落地');
      state.expandedLandingId = r.node?.id || r.id || null;
      openModal({
        title: '安装 Agent',
        body: `<p class="field-hint">在<strong>新落地家宽</strong> root 执行（不是 IX、不是面板）：</p>
          <pre class="code-block">${esc(r.installCommand)}</pre>
          <button class="btn btn-sm btn-primary" id="new-copy" title="复制安装命令">复制命令</button>`,
        actions: `<button class="btn btn-primary" data-close>关闭</button>`,
      });
      document.getElementById('new-copy')?.addEventListener('click', async () => {
        await copyText(r.installCommand);
        toast('已复制');
      });
      await refreshCore();
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  document.querySelectorAll('[data-save-node]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.saveNode;
      const portRaw = document.getElementById(`n-port-${id}`)?.value;
      const listenPort = Number(portRaw);
      if (!Number.isFinite(listenPort) || listenPort < 1 || listenPort > 65535) {
        return toast('请填写有效监听端口（如 7902）', 'err');
      }
      const displayName = document.getElementById(`n-name-${id}`)?.value?.trim() || '';
      if (!displayName) return toast('请填写落地显示名称', 'err');
      if (displayName.length > 40) return toast('名称太长（最多 40 字）', 'err');
      try {
        const r = await api(`/api/nodes/${id}`, {
          method: 'PUT',
          body: {
            name: displayName,
            listenPort,
            homeReachableHost: document.getElementById(`n-home-${id}`)?.value?.trim() || '',
            ixId: document.getElementById(`n-ix-${id}`)?.value || null,
          },
        });
        const savedPort = r.landing?.listenPort || r.node?.listenPort || listenPort;
        const savedName = r.node?.name || r.landing?.name || displayName;
        toast(`已保存「${savedName}」· 端口 ${savedPort}`);
        state.expandedLandingId = id;
        await refreshCore();
        render();
      } catch (e) {
        toast(e.data?.error || e.message, 'err');
      }
    };
  });
  document.querySelectorAll('[data-apply-node]').forEach((b) => {
    b.onclick = () => applyConfig(true, { nodeId: b.dataset.applyNode });
  });
  document.querySelectorAll('[data-update-agent]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.updateAgent;
      const n = (state.nodes || []).find((x) => x.id === id);
      if (!n?.online) return toast('Agent 离线，无法远程更新', 'err');
      try {
        b.disabled = true;
        const r = await api(`/api/nodes/${id}/update-agent`, { method: 'POST', body: {} });
        toast(r.message || '已下发更新');
        state.expandedLandingId = id;
        // 多刷几次等 agent 重启上报新版本
        setTimeout(() => refreshCore().then(() => render()).catch(() => {}), 8000);
        setTimeout(() => refreshCore().then(() => render()).catch(() => {}), 20000);
      } catch (e) {
        toast(e.data?.error || e.message, 'err');
      } finally {
        b.disabled = false;
      }
    };
  });
  document.getElementById('srv-update-agents')?.addEventListener('click', async () => {
    if (!confirm('向所有在线落地排队「更新 Agent」？离线的会跳过。')) return;
    try {
      const r = await api('/api/nodes/update-agent-all', { method: 'POST', body: {} });
      toast(r.message || '已排队');
      setTimeout(() => refreshCore().then(() => render()).catch(() => {}), 10000);
    } catch (e) {
      toast(e.data?.error || e.message, 'err');
    }
  });
  document.querySelectorAll('[data-exit-node]').forEach((b) => {
    b.onclick = () => setupExit(b.dataset.exitNode);
  });
  document.querySelectorAll('[data-cmd-node]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.cmdNode;
      try {
        const r = await api(`/api/nodes/${id}/install-command`);
        const pre = document.getElementById(`cmd-${id}`);
        if (pre) {
          pre.style.display = 'block';
          pre.textContent = r.installCommand;
        }
        await copyText(r.installCommand);
        toast('安装命令已复制');
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  });
  document.querySelectorAll('[data-users-node]').forEach((b) => {
    b.onclick = () => {
      state.page = 'clients';
      state.expandedLandingId = b.dataset.usersNode;
      render();
    };
  });
  document.querySelectorAll('[data-rotate-node]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('轮换 Token 后旧 Agent 将失效，需用新命令重装。继续？')) return;
      try {
        const r = await api(`/api/nodes/${b.dataset.rotateNode}/token`, { method: 'POST', body: {} });
        toast('已轮换，请复制新安装命令');
        const pre = document.getElementById(`cmd-${b.dataset.rotateNode}`);
        if (pre) {
          pre.style.display = 'block';
          pre.textContent = r.installCommand;
        }
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  });
  document.querySelectorAll('[data-primary-node]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/nodes/${b.dataset.primaryNode}`, { method: 'PUT', body: { setPrimary: true } });
        toast('已设为默认落地');
        render();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  });
  document.querySelectorAll('[data-del-node]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除该落地？绑定用户将改到默认落地。')) return;
      try {
        await api(`/api/nodes/${b.dataset.delNode}?force=1`, { method: 'DELETE' });
        toast('已删除');
        render();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  });

  const saveGlobal = async () => {
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
    return r;
  };
  const onSaveGlobal = async () => {
    try {
      const r = await saveGlobal();
      toast(r.tip || '全局参数已保存');
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  document.getElementById('srv-save').onclick = onSaveGlobal;
  document.getElementById('srv-save-2')?.addEventListener('click', onSaveGlobal);
  document.getElementById('srv-apply-all').onclick = () => applyConfig(true, { all: true });
}

/* ========== 客户端（模块化工作台） ========== */
function clientStatusBadge(c) {
  const st = c.statusFlags || {};
  if (st.expired) return '<span class="badge warn">到期</span>';
  if (st.overQuota) return '<span class="badge warn">超额</span>';
  if (c.enabled === false) return '<span class="badge">停用</span>';
  return '<span class="badge ok">启用</span>';
}

function clientStatusDot(c) {
  const st = c.statusFlags || {};
  if (st.expired) return '<span class="status-dot warn">到期</span>';
  if (st.overQuota) return '<span class="status-dot warn">超额</span>';
  if (c.enabled === false) return '<span class="status-dot muted">停用</span>';
  return '<span class="status-dot ok">启用</span>';
}

function expireLabel(c) {
  const raw = c.package?.expireAt ? String(c.package.expireAt).trim() : '';
  if (!raw) return { text: '不限', cls: 'muted', title: '未设置到期' };
  const day = raw.slice(0, 10);
  const t = new Date(raw).getTime();
  if (!Number.isFinite(t)) return { text: day, cls: '', title: raw };
  const left = t - Date.now();
  if (left < 0) return { text: day + ' 已到期', cls: 'expire-bad', title: raw };
  const days = Math.ceil(left / 86400000);
  if (days <= 7) return { text: day + ` · ${days}天后`, cls: 'expire-soon', title: raw };
  return { text: day, cls: '', title: raw };
}

function rateCellHtml(c) {
  const u = c.usage || {};
  const down = u.downRateHuman || '—';
  const up = u.upRateHuman || '—';
  const active = (Number(u.downBps) || 0) + (Number(u.upBps) || 0) > 0;
  return `<div class="rate-inline mono ${active ? 'rate-on' : ''}" data-rate-for="${esc(c.id)}" title="相邻两次用量差估算 · 约 3s 刷新">
    <div><span class="usage-dir down">↓</span> <span data-rate-down>${esc(down)}</span></div>
    <div><span class="usage-dir up">↑</span> <span data-rate-up>${esc(up)}</span></div>
  </div>`;
}

function usageCellHtml(c) {
  const u = c.usage || {};
  const has = Number(u.totalBytes) > 0 || Number(u.downloadBytes) > 0 || Number(u.uploadBytes) > 0;
  if (!has && !u.collectedAt) {
    return `<span class="muted">—</span><div class="muted" style="font-size:10px">等待上报</div>`;
  }
  const d = u.downloadHuman || '0 B';
  const up = u.uploadHuman || '0 B';
  const tot = u.totalHuman || '0 B';
  return `<div class="usage-cell mono">
    <div title="下行累计"><span class="usage-dir down">↓</span> ${esc(d)}</div>
    <div title="上行累计"><span class="usage-dir up">↑</span> ${esc(up)}</div>
    <div class="muted" style="font-size:10px" title="合计">Σ ${esc(tot)}</div>
  </div>`;
}

function buildClientGroups() {
  const nodes = state.nodes || [];
  const primaryId = state.primaryNode?.id || nodes.find((n) => n.isPrimary)?.id;
  const groups = [];
  for (const n of nodes) {
    const list = (state.clients || []).filter((c) => c.route?.landingNodeId === n.id);
    groups.push({ node: n, clients: list, unbound: false });
  }
  const unbound = (state.clients || []).filter(
    (c) => !c.route?.landingNodeId || !nodes.some((n) => n.id === c.route.landingNodeId)
  );
  if (unbound.length || !nodes.length) {
    groups.push({
      node: {
        id: primaryId || '__default',
        name: nodes.length ? '未绑定' : '默认',
        online: state.primaryNode?.online,
        isPrimary: true,
      },
      clients: unbound.length ? unbound : nodes.length ? [] : state.clients || [],
      unbound: true,
    });
  }
  return groups.filter((g) => g.clients.length || (!g.unbound && nodes.length));
}

function filterClientsList(list) {
  const q = String(state.clientsQuery || '')
    .trim()
    .toLowerCase();
  const f = state.clientsFilter || 'all';
  return (list || []).filter((c) => {
    if (f === 'on' && c.enabled === false) return false;
    if (f === 'off' && c.enabled !== false) return false;
    if (f === 'warn') {
      const st = c.statusFlags || {};
      if (!(st.expired || st.overQuota)) return false;
    }
    if (!q) return true;
    const hay = `${c.name || ''} ${c.note || ''} ${effectiveClientPort(c)}`.toLowerCase();
    return hay.includes(q);
  });
}

function clientTableRowHtml(c) {
  const exp = expireLabel(c);
  const note = (c.note || '').trim();
  const open = state.clientsExpandedId === c.id;
  const disabled = c.enabled === false;
  const detail = open
    ? `<tr class="urow-detail" data-detail-for="${esc(c.id)}">
        <td colspan="7">
          <div class="urow-detail-inner">
            <div class="mini-stat"><div class="l">累计流量</div><div class="v">${usageCellHtml(c)}</div></div>
            <div class="mini-stat"><div class="l">配额</div><div class="v mono">${esc(
              c.package?.quotaMb ? c.package.quotaMb + ' MB' : '不限'
            )}</div></div>
            <div class="mini-stat"><div class="l">到期</div><div class="v mono ${exp.cls}" title="${esc(
              exp.title
            )}">${esc(exp.text)}</div></div>
            <div class="mini-stat"><div class="l">端口</div><div class="v mono">:${esc(
              effectiveClientPort(c)
            )}</div></div>
            <div class="urow-detail-actions">
              <button class="btn btn-sm btn-primary" data-qr="${c.id}">分享</button>
              <button class="btn btn-sm ${disabled ? 'btn-primary' : 'btn-secondary'}" data-toggle-enable="${c.id}">${
                disabled ? '启用' : '禁用'
              }</button>
              <button class="btn btn-sm btn-secondary" data-edit="${c.id}">编辑</button>
              <button class="btn btn-sm btn-danger" data-del="${c.id}">删除</button>
            </div>
          </div>
        </td>
      </tr>`
    : '';
  return `<tr class="${disabled ? 'is-disabled' : ''} ${open ? 'is-open' : ''}" data-user-id="${esc(
    c.id
  )}" data-row-toggle="${esc(c.id)}">
    <td class="cell-user">
      <div class="name">${esc(c.name)}</div>
      <span class="note" title="${esc(note || '')}">${note ? esc(note) : '—'}</span>
    </td>
    <td>${clientStatusDot(c)}</td>
    <td class="mono">:${esc(effectiveClientPort(c))}</td>
    <td>${rateCellHtml(c)}</td>
    <td class="mono ${exp.cls}" title="${esc(exp.title)}">${esc(exp.text)}</td>
    <td class="mono muted">${esc(c.package?.quotaMb ? c.package.quotaMb + ' MB' : '不限')}</td>
    <td>
      <div class="ops" onclick="event.stopPropagation()">
        <button class="btn btn-sm btn-primary" data-qr="${c.id}" title="分享">分享</button>
        <button class="btn btn-sm btn-secondary" data-edit="${c.id}" title="编辑">编辑</button>
        <button class="btn btn-sm btn-ghost" data-more="${c.id}" title="更多">⋯</button>
      </div>
    </td>
  </tr>${detail}`;
}

async function toggleClientEnable(id) {
  const c = (state.clients || []).find((x) => x.id === id);
  if (!c) return toast('用户不存在，请刷新', 'err');
  const next = c.enabled === false;
  const tip = next
    ? `启用「${c.name}」？将自动下发到落地 mita，约 10–30 秒后可连。`
    : `禁用「${c.name}」？将自动下发到落地 mita，去掉该账号，约 10–30 秒后无法认证。`;
  if (!confirm(tip)) return;
  try {
    const putRes = await api(`/api/clients/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: { enabled: next },
    });
    const landingId =
      putRes.applyNodeId || putRes.client?.route?.landingNodeId || c.route?.landingNodeId || '';
    if (putRes.applyQueued) {
      toast(putRes.message || (next ? '已启用并下发' : '已禁用并下发'), 'ok');
    } else if (landingId) {
      try {
        const ap = await api(`/api/nodes/${encodeURIComponent(landingId)}/apply`, {
          method: 'POST',
          body: {},
        });
        toast(ap.message || (next ? '已下发启用' : '已下发禁用'), 'ok');
      } catch (ae) {
        toast(
          `状态已改，自动应用失败：${ae.data?.error || ae.message}。请点「应用本落地」`,
          'err'
        );
      }
    } else {
      toast(next ? '已启用，请绑定落地后应用' : '已禁用，请绑定落地后应用', 'err');
    }
    await refreshCore();
    render();
  } catch (e) {
    toast(e.data?.error || e.message, 'err');
  }
}

function bindClientActions(primaryId) {
  document.querySelectorAll('[data-qr]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      showClientQr(b.dataset.qr);
    };
  });
  document.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const id = b.dataset.edit;
      const c = state.clients.find((x) => x.id === id);
      if (!c?.id) return toast('用户不存在，请刷新', 'err');
      openClientModal(c);
    };
  });
  document.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('删除该用户？删除后需应用配置才会从 mita 移除。')) return;
      try {
        await api(`/api/clients/${b.dataset.del}`, { method: 'DELETE' });
        toast('已删除');
        render();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  });
  document.querySelectorAll('[data-toggle-enable]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      toggleClientEnable(b.dataset.toggleEnable);
    };
  });
  document.querySelectorAll('[data-more]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const id = b.dataset.more;
      const c = (state.clients || []).find((x) => x.id === id);
      if (!c) return;
      openModal({
        title: `${c.name}`,
        body: `<p class="field-hint" style="margin-top:0">备注：${esc(c.note || '—')} · 端口 :${esc(
          effectiveClientPort(c)
        )}</p>
          <div class="btn-row" style="flex-direction:column;align-items:stretch">
            <button class="btn btn-primary" data-m-qr="${id}">分享链接 / YAML</button>
            <button class="btn btn-secondary" data-m-en="${id}">${
              c.enabled === false ? '启用用户' : '禁用用户'
            }</button>
            <button class="btn btn-secondary" data-m-ed="${id}">编辑</button>
            <button class="btn btn-danger" data-m-del="${id}">删除</button>
          </div>`,
        actions: `<button class="btn btn-ghost" data-close>关闭</button>`,
      });
      document.querySelector(`[data-m-qr="${id}"]`)?.addEventListener('click', () => {
        closeModal();
        showClientQr(id);
      });
      document.querySelector(`[data-m-en="${id}"]`)?.addEventListener('click', () => {
        closeModal();
        toggleClientEnable(id);
      });
      document.querySelector(`[data-m-ed="${id}"]`)?.addEventListener('click', () => {
        closeModal();
        openClientModal(c);
      });
      document.querySelector(`[data-m-del="${id}"]`)?.addEventListener('click', async () => {
        if (!confirm('确认删除？')) return;
        try {
          await api(`/api/clients/${id}`, { method: 'DELETE' });
          closeModal();
          toast('已删除');
          render();
        } catch (err) {
          toast(err.message, 'err');
        }
      });
    };
  });
  document.querySelectorAll('[data-row-toggle]').forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest('button,a,input')) return;
      const id = tr.dataset.rowToggle;
      state.clientsExpandedId = state.clientsExpandedId === id ? null : id;
      renderClients({ skipRefresh: true });
    };
  });
}

async function renderClients(opts = {}) {
  if (!opts.skipRefresh) await refreshCore().catch(() => {});
  const nodes = state.nodes || [];
  const primaryId = state.primaryNode?.id || nodes.find((n) => n.isPrimary)?.id;
  const groups = buildClientGroups();
  // 默认页签：有用户的第一个落地
  if (!state.clientsTabId || !groups.some((g) => g.node.id === state.clientsTabId)) {
    const prefer = groups.find((g) => g.clients.length) || groups[0];
    state.clientsTabId = prefer?.node?.id || primaryId || '__default';
  }
  const activeG =
    groups.find((g) => g.node.id === state.clientsTabId) || groups[0] || null;
  const activeNode = activeG?.node;
  const L = activeNode ? landingByNodeId(activeNode.id) : null;
  const rawList = activeG?.clients || [];
  const list = filterClientsList(rawList);
  const enN = rawList.filter((c) => c.enabled !== false).length;
  const offN = rawList.length - enN;
  const warnN = rawList.filter((c) => c.statusFlags?.expired || c.statusFlags?.overQuota).length;

  const tabsHtml = groups.length
    ? `<div class="seg-tabs" id="c-tabs">
        ${groups
          .map((g) => {
            const n = g.node;
            const on = n.id === state.clientsTabId;
            const cnt = g.clients.length;
            const dot =
              g.unbound ? 'off' : n.online ? 'on' : 'off';
            return `<button type="button" class="seg-tab ${on ? 'on' : ''}" data-c-tab="${esc(
              n.id
            )}">
              <span class="dot ${dot}"></span>
              ${esc(n.name || '落地')}
              <small>${cnt}</small>
            </button>`;
          })
          .join('')}
      </div>`
    : '';

  const tableHtml = list.length
    ? `<div class="utable-wrap"><table class="utable">
        <thead>
          <tr>
            <th>用户</th>
            <th>状态</th>
            <th>端口</th>
            <th>网速</th>
            <th>到期</th>
            <th>配额</th>
            <th style="text-align:right">操作</th>
          </tr>
        </thead>
        <tbody>${list.map(clientTableRowHtml).join('')}</tbody>
      </table></div>`
    : rawList.length
      ? `<div class="empty-mod"><strong>无匹配用户</strong><p>试试清空搜索或切换筛选</p></div>`
      : `<div class="empty-mod"><strong>本落地暂无用户</strong><p>创建后记得点「应用本落地」下发到 mita</p>
          <button class="btn btn-primary" data-add-landing="${esc(
            activeG?.unbound ? '' : activeNode?.id || ''
          )}">添加用户</button></div>`;

  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>客户端</h2>
        <p class="muted">落地页签 · 紧凑列表 · 只连前置</p>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="c-add" title="创建用户">添加用户</button>
        <button class="btn btn-secondary" id="c-apply" title="下发全部落地">应用全部</button>
      </div>
    </div>
    ${
      !activeEp()
        ? `<div class="alert warn"><div>尚未配置入站。请先到「拓扑」填写前置。</div>
          <button class="btn btn-sm btn-primary" data-nav-jump="topology">去拓扑</button></div>`
        : multiLandingEndpointBanner()
    }
    ${tabsHtml}
    ${
      activeG
        ? `<div class="workbench-summary">
        <div class="ws-left">
          <span class="ws-title">${esc(activeNode?.name || '落地')}</span>
          ${
            activeG.unbound
              ? '<span class="badge warn">未绑定</span>'
              : activeNode?.online
                ? '<span class="badge ok">在线</span>'
                : '<span class="badge warn">离线</span>'
          }
          ${activeNode?.isPrimary && !activeG.unbound ? '<span class="badge ok">默认</span>' : ''}
          <span class="ws-meta mono">:${esc(
            L?.listenPort || activeNode?.listenPort || 7901
          )} · ${rawList.length} 用户 · 启用 ${enN}${offN ? ` · 停用 ${offN}` : ''}${
            warnN ? ` · 告警 ${warnN}` : ''
          }${L?.ixId ? ` · IX ${esc(ixName(L.ixId))}` : ''}</span>
        </div>
        <div class="ws-actions">
          ${
            !activeG.unbound && activeNode?.id && activeNode.id !== '__default'
              ? `<button class="btn btn-sm btn-primary" data-apply-landing="${esc(
                  activeNode.id
                )}">应用本落地</button>`
              : ''
          }
          <button class="btn btn-sm btn-secondary" data-add-landing="${esc(
            activeG.unbound ? '' : activeNode?.id || ''
          )}">添加用户</button>
        </div>
      </div>
      <div class="mod">
        <div class="filter-bar">
          <input class="field" id="c-q" placeholder="搜索登录名 / 备注 / 端口" value="${esc(
            state.clientsQuery || ''
          )}" />
          <div class="filter-chips">
            <button type="button" class="filter-chip ${
              state.clientsFilter === 'all' ? 'on' : ''
            }" data-c-filter="all">全部</button>
            <button type="button" class="filter-chip ${
              state.clientsFilter === 'on' ? 'on' : ''
            }" data-c-filter="on">启用</button>
            <button type="button" class="filter-chip ${
              state.clientsFilter === 'off' ? 'on' : ''
            }" data-c-filter="off">停用</button>
            <button type="button" class="filter-chip ${
              state.clientsFilter === 'warn' ? 'on' : ''
            }" data-c-filter="warn">告警</button>
          </div>
        </div>
        <div class="mod-body tight">${tableHtml}</div>
      </div>
      <p class="field-hint">点行展开详情 · 登录名英文/数字，中文写备注 · 改落地后需应用 · 只连前置</p>`
        : `<div class="mod"><div class="empty-mod"><strong>还没有落地</strong><p>请先到「落地」添加节点</p></div></div>`
    }
  `);
  bindShell();
  document.getElementById('c-add').onclick = () =>
    openClientModal(null, activeG?.unbound ? primaryId : activeNode?.id || primaryId);
  document.getElementById('c-apply').onclick = () => applyConfig(true, { all: true });
  document.querySelectorAll('[data-c-tab]').forEach((b) => {
    b.onclick = () => {
      state.clientsTabId = b.dataset.cTab;
      state.clientsExpandedId = null;
      renderClients({ skipRefresh: true });
    };
  });
  document.querySelectorAll('[data-c-filter]').forEach((b) => {
    b.onclick = () => {
      state.clientsFilter = b.dataset.cFilter;
      renderClients({ skipRefresh: true });
    };
  });
  const qEl = document.getElementById('c-q');
  if (qEl) {
    qEl.oninput = () => {
      state.clientsQuery = qEl.value;
      // 防抖：输入时不全量 refresh，只重绘；重绘后恢复焦点
      if (window.__cQTimer) clearTimeout(window.__cQTimer);
      window.__cQTimer = setTimeout(() => {
        const pos = qEl.selectionStart;
        renderClients({ skipRefresh: true }).then(() => {
          const again = document.getElementById('c-q');
          if (again) {
            again.focus();
            try {
              again.setSelectionRange(pos, pos);
            } catch {
              /* */
            }
          }
        });
      }, 180);
    };
  }
  document.querySelectorAll('[data-add-landing]').forEach((b) => {
    b.onclick = () => openClientModal(null, b.dataset.addLanding || primaryId);
  });
  document.querySelectorAll('[data-apply-landing]').forEach((b) => {
    b.onclick = () => {
      const nodeId = (b.dataset.applyLanding || '').trim();
      if (!nodeId) return toast('落地 id 缺失，请刷新页面', 'err');
      applyConfig(true, { nodeId });
    };
  });
  bindClientActions(primaryId);
  startClientsLivePoll();
}

function stopClientsLivePoll() {
  if (window.__clientsRefreshTimer) {
    clearTimeout(window.__clientsRefreshTimer);
    window.__clientsRefreshTimer = null;
  }
}

function patchClientLiveStats() {
  for (const c of state.clients || []) {
    // 兼容旧卡片 + 新表格行
    const row =
      document.querySelector(`tr[data-user-id="${CSS.escape(c.id)}"]`) ||
      document.querySelector(`.user-card[data-user-id="${CSS.escape(c.id)}"]`);
    const rate =
      document.querySelector(`[data-rate-for="${CSS.escape(c.id)}"]`) ||
      row?.querySelector('[data-rate-for]');
    if (rate) {
      const u = c.usage || {};
      const down = u.downRateHuman || '—';
      const up = u.upRateHuman || '—';
      const active = (Number(u.downBps) || 0) + (Number(u.upBps) || 0) > 0;
      rate.classList.toggle('rate-on', active);
      const dEl = rate.querySelector('[data-rate-down]');
      const uEl = rate.querySelector('[data-rate-up]');
      if (dEl) dEl.textContent = down;
      if (uEl) uEl.textContent = up;
    }
    // 展开详情里的累计流量
    const detail = document.querySelector(`tr.urow-detail[data-detail-for="${CSS.escape(c.id)}"]`);
    if (detail) {
      const mini = detail.querySelector('.mini-stat .v');
      if (mini && mini.querySelector('.usage-cell, .muted')) {
        mini.innerHTML = usageCellHtml(c);
      }
    }
  }
}

function startClientsLivePoll() {
  stopClientsLivePoll();
  const tick = () => {
    window.__clientsRefreshTimer = setTimeout(async () => {
      if (state.page !== 'clients') return;
      try {
        await refreshCore();
        if (state.page !== 'clients') return;
        const modalOpen = Boolean(
          document.querySelector('.modal-backdrop, .modal.show, #modal-root .modal, #modal-root [class*="modal"]')
        );
        if (modalOpen) {
          // 弹窗打开时不整页重绘，只补丁网速
          patchClientLiveStats();
        } else {
          // 无弹窗：优先局部更新，避免闪烁；每 5 次整页同步徽章等
          window.__clientsLiveN = (window.__clientsLiveN || 0) + 1;
          if (window.__clientsLiveN % 5 === 0) {
            await renderClients();
            return;
          }
          patchClientLiveStats();
        }
      } catch {
        /* */
      }
      if (state.page === 'clients') tick();
    }, 3000);
  };
  tick();
}

function openClientModal(client, preferLandingId) {
  // 只认有 id 的对象为编辑；否则走创建（避免 PUT /undefined → 用户不存在）
  const editId = client && client.id ? String(client.id) : '';
  const isEdit = Boolean(editId);
  const nodes = state.nodes || [];
  const defaultLanding =
    client?.route?.landingNodeId || preferLandingId || state.primaryNode?.id || nodes[0]?.id || '';
  const landingOpts = nodes
    .map((n) => {
      const L = landingByNodeId(n.id);
      const ix = L?.ixId ? ` · ${ixName(L.ixId)}` : '';
      return `<option value="${esc(n.id)}" ${defaultLanding === n.id ? 'selected' : ''}>${esc(
        n.name
      )}${n.isPrimary ? '（默认）' : ''}${ix}</option>`;
    })
    .join('');
  openModal({
    title: isEdit ? '编辑用户' : '添加用户',
    body: `
      <p class="field-hint" style="margin-top:0">登录名 = mieru 客户端「用户」栏（须英文/数字）。中文写备注。密码可自动生成。</p>
      <label>登录用户名（须英文/数字）</label>
      <input class="field mono" id="c-name" value="${esc(client?.name || '')}" placeholder="留空自动生成" autocomplete="off" />
      <label>密码${isEdit ? '（留空不改）' : '（留空自动生成）'}</label>
      <div class="field-with-btn">
        <input class="field mono" id="c-pass" value="" placeholder="${isEdit ? '留空保持' : '留空自动'}" autocomplete="new-password" />
        <button type="button" class="btn btn-secondary" id="c-pass-gen" title="随机生成密码">随机</button>
      </div>
      <label>备注（可中文）</label>
      <input class="field" id="c-note" value="${esc(client?.note || '')}" placeholder="例如：我的电脑" />
      <label>绑定落地</label>
      <select class="field" id="c-landing">${landingOpts || '<option value="">默认</option>'}</select>
      <p class="field-hint">分享链会按该落地所属 IX 的前置 IP/域名生成。</p>
      <label>专用端口（空=落地默认；须在所属 IX 端口段内）</label>
      <input class="field mono" id="c-port" value="${esc(client?.route?.listenPort || '')}" placeholder="7901" />
      <div class="inline-fields">
        <div>
          <label>流量配额 MB（0=不限）</label>
          <input class="field mono" id="c-quota" value="${esc(client?.package?.quotaMb ?? 0)}" />
        </div>
        <div>
          <label>配额天数</label>
          <input class="field mono" id="c-qdays" value="${esc(client?.package?.quotaDays ?? 30)}" />
        </div>
      </div>
      <label>到期日（点选日期，清空=不限）</label>
      <div class="field-with-btn">
        <input class="field mono" type="date" id="c-expire" value="${esc(
          client?.package?.expireAt ? String(client.package.expireAt).slice(0, 10) : ''
        )}" />
        <button type="button" class="btn btn-secondary" id="c-expire-clear" title="清空为不限">不限</button>
      </div>
      <div class="btn-row tight" style="margin:6px 0 10px;flex-wrap:wrap">
        <button type="button" class="btn btn-sm btn-ghost" data-expire-days="7">+7天</button>
        <button type="button" class="btn btn-sm btn-ghost" data-expire-days="30">+30天</button>
        <button type="button" class="btn btn-sm btn-ghost" data-expire-days="90">+90天</button>
        <button type="button" class="btn btn-sm btn-ghost" data-expire-days="365">+1年</button>
      </div>
      ${
        isEdit
          ? `<label class="check-row"><input type="checkbox" id="c-enabled" ${
              client.enabled !== false ? 'checked' : ''
            } /> 启用</label>
             <label class="check-row"><input type="checkbox" id="c-regen" /> 重新生成密码</label>`
          : ''
      }
    `,
    actions: `
      <button class="btn btn-ghost" data-close title="关闭不保存">取消</button>
      <button class="btn btn-primary" id="c-save" title="${isEdit ? '保存用户' : '创建用户'}">${
      isEdit ? '保存' : '创建'
    }</button>
    `,
  });
  document.getElementById('c-pass-gen')?.addEventListener('click', () => {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
    document.getElementById('c-pass').value = s;
    toast('已填入随机密码');
  });
  document.getElementById('c-expire-clear')?.addEventListener('click', () => {
    const el = document.getElementById('c-expire');
    if (el) el.value = '';
    toast('已设为不限');
  });
  document.querySelectorAll('[data-expire-days]').forEach((b) => {
    b.addEventListener('click', () => {
      const days = Number(b.dataset.expireDays) || 0;
      if (!days) return;
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + days);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const el = document.getElementById('c-expire');
      if (el) el.value = `${yyyy}-${mm}-${dd}`;
    });
  });
  document.getElementById('c-save').onclick = async () => {
    try {
      const landingNodeId = (val('c-landing') || '').trim() || null;
      const L = landingByNodeId(landingNodeId);
      // 校验下拉值必须是已知 node.id，避免绑到错误 id
      const known = (state.nodes || []).some((n) => n.id === landingNodeId);
      if (landingNodeId && !known) {
        toast('绑定落地无效，请重新选择落地后再保存', 'err');
        return;
      }
      const body = {
        name: val('c-name') || client?.name,
        note: val('c-note'),
        route: {
          landingNodeId,
          ixId: L?.ixId || null,
          listenPort: val('c-port') ? Number(val('c-port')) : null,
        },
        package: {
          quotaMb: Number(val('c-quota')) || 0,
          quotaDays: Number(val('c-qdays')) || 30,
          expireAt: val('c-expire') || '',
        },
      };
      if (val('c-pass')) body.password = val('c-pass');
      if (isEdit && editId) {
        body.regeneratePassword = document.getElementById('c-regen')?.checked;
        body.enabled = document.getElementById('c-enabled')?.checked;
        // 保存前再确认列表里还有该 id（防页面过期）
        const still = (state.clients || []).find((x) => x.id === editId);
        if (!still) {
          await refreshCore().catch(() => {});
        }
        const again = (state.clients || []).find((x) => x.id === editId);
        if (!again) {
          toast('用户不存在或页面已过期，请关闭后刷新再编辑', 'err');
          return;
        }
        await api(`/api/clients/${encodeURIComponent(editId)}`, { method: 'PUT', body });
        toast('已保存（记得到 pro3 点「应用本落地」）');
        closeModal();
        await refreshCore();
        render();
      } else {
        const r = await api('/api/clients', { method: 'POST', body });
        toast('已创建（记得点应用下发）');
        closeModal();
        await refreshCore();
        state.page = 'clients';
        render();
        if (r.client?.id) showClientQr(r.client.id);
      }
    } catch (e) {
      toast(e.data?.error || e.message, 'err');
    }
  };
}

async function showClientQr(id) {
  try {
    const data = await api(`/api/clients/${id}/config?format=qr`);
    const mobile = data.shareLinks?.mobile || data.shareLink;
    const external = data.shareLinks?.external || data.shareLink;
    const exp = data.expireAt ? String(data.expireAt).slice(0, 10) : '不限';
    const note = (data.note || '').trim();
    let tab = 'qr'; // qr | link | conf
    const paint = () => {
      openModal({
        title: `分享 · ${data.name || ''}`,
        body: `
          <div class="qr-user-banner">
            <div class="qr-user-line"><span class="muted">登录名</span> <strong class="mono">${esc(
              data.name || ''
            )}</strong>
              ${note ? ` · <strong>${esc(note)}</strong>` : ''}
            </div>
            <div class="qr-user-line"><span class="muted">到期</span> <span class="mono">${esc(exp)}</span>
              ${
                data.package?.quotaMb
                  ? ` · 配额 <span class="mono">${esc(data.package.quotaMb)} MB</span>`
                  : ''
              }
            </div>
            <div class="qr-user-line muted" style="font-size:12px">${esc(
              data.tip || '电脑连商家 IX 前置 114/211'
            )}</div>
          </div>
          <div class="share-tabs">
            <button type="button" class="share-tab ${tab === 'qr' ? 'on' : ''}" data-share-tab="qr">扫码</button>
            <button type="button" class="share-tab ${tab === 'link' ? 'on' : ''}" data-share-tab="link">链接</button>
            <button type="button" class="share-tab ${tab === 'conf' ? 'on' : ''}" data-share-tab="conf">配置</button>
          </div>
          <div class="share-pane ${tab === 'qr' ? 'on' : ''}" data-share-pane="qr">
            <div class="dual-qr">
              <div class="dual-qr-col">
                <strong>移动宽带 211</strong>
                <div class="qr-wrap"><img src="${data.qrMobile || data.qr}" alt="qr-mobile" /></div>
                <p class="mono center" style="font-size:11px;word-break:break-all">${esc(
                  data.endpoints?.mobile || ''
                )}</p>
              </div>
              <div class="dual-qr-col">
                <strong>外部前置 114</strong>
                <div class="qr-wrap"><img src="${data.qrExternal || data.qr}" alt="qr-ext" /></div>
                <p class="mono center" style="font-size:11px;word-break:break-all">${esc(
                  data.endpoints?.external || ''
                )}</p>
              </div>
            </div>
          </div>
          <div class="share-pane ${tab === 'link' ? 'on' : ''}" data-share-pane="link">
            <label>移动宽带 211</label>
            <div class="field-with-btn">
              <input class="field mono" readonly value="${esc(mobile || '')}" id="share-link-m" />
              <button type="button" class="btn btn-primary" id="qr-copy-m">复制</button>
            </div>
            <label style="margin-top:10px">外部前置 114</label>
            <div class="field-with-btn">
              <input class="field mono" readonly value="${esc(external || '')}" id="share-link-e" />
              <button type="button" class="btn btn-secondary" id="qr-copy-e">复制</button>
            </div>
            <p class="field-hint">只填前置 Endpoint，勿填 IX 或家宽公网</p>
          </div>
          <div class="share-pane ${tab === 'conf' ? 'on' : ''}" data-share-pane="conf">
            <p class="field-hint" style="margin-top:0">YAML = 完整 OpenClash/mihomo（211/114 + 防环），下载后直接导入</p>
            <div class="btn-row" style="flex-wrap:wrap;margin-bottom:10px">
              <a class="btn btn-primary" href="/api/clients/${id}/config?format=yaml" title="完整 OpenClash 配置">下载 YAML</a>
              <a class="btn btn-secondary" href="/api/clients/${id}/config?format=download">下载 JSON</a>
              <button class="btn btn-ghost" id="qr-copy-json">复制 JSON</button>
            </div>
            <pre class="code-block" style="max-height:160px;overflow:auto;font-size:11px">${esc(
              data.config || mobile || ''
            )}</pre>
          </div>
        `,
        actions: `<button class="btn btn-primary" data-close>关闭</button>`,
      });
      document.querySelectorAll('[data-share-tab]').forEach((b) => {
        b.onclick = () => {
          tab = b.dataset.shareTab;
          paint();
        };
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
    };
    paint();
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
        <p class="muted">前置 → IX 转发 → 落地 Agent/mita</p>
      </div>
      <button class="btn btn-primary" id="d-refresh" title="重新跑一遍分层检查">重新诊断</button>
    </div>
    ${pathBanner(null, { compact: true })}
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
          <button class="btn btn-success" id="d-exit" title="在默认落地安装/启动 mita">一键落地</button>
          <button class="btn btn-success" id="d-apply" title="下发配置到落地">应用配置</button>
          <button class="btn btn-secondary" data-nav-jump="topology" title="配置前置与转发">去拓扑</button>
          <button class="btn btn-secondary" data-nav-jump="clients" title="管理用户">去客户端</button>
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
  const auto = state.status?.settings?.autoApplyEnforce !== false;
  const nodes = state.nodes || [];
  const username = state.status?.username || 'admin';
  const forcePw = Boolean(state.status?.forcePasswordChange);
  app.innerHTML = shell(`
    <div class="page-header">
      <div>
        <h2>设置</h2>
        <p class="muted">账号安全 · 套餐策略 · 导出备份</p>
      </div>
    </div>
    ${
      forcePw
        ? `<div class="alert warn"><div><strong>请先修改初始密码</strong> · 当前仍在使用初始化或重置后的密码</div></div>`
        : ''
    }
    <div class="settings-grid two">
      <div class="card">
        <div class="card-head"><h3>管理员账号</h3><span class="badge ok">已登录</span></div>
        <p class="card-desc">面板 Web 登录账号，与客户端 mieru 用户无关。可改用户名与密码。</p>
        <div class="kv"><span>当前用户名</span><span class="mono">${esc(username)}</span></div>
        <label for="acc-user">新用户名（可空=不改）</label>
        <input class="field mono" id="acc-user" value="${esc(username)}" autocomplete="username" />
        <p class="field-hint">建议英文短名；改名后下次登录用新用户名。</p>
        <label for="pw-old">当前密码</label>
        <div class="field-with-btn">
          <input class="field" type="password" id="pw-old" autocomplete="current-password" placeholder="验证身份" />
          <button type="button" class="btn btn-secondary" id="pw-toggle" title="显示或隐藏密码">显示</button>
        </div>
        <label for="pw-new">新密码（至少 6 位）</label>
        <input class="field" type="password" id="pw-new" autocomplete="new-password" placeholder="设置新密码" />
        <label for="pw-new2">确认新密码</label>
        <input class="field" type="password" id="pw-new2" autocomplete="new-password" placeholder="再输入一次" />
        <p class="field-hint">忘记密码时，在<strong>面板机</strong>执行：
          <code>sudo bash install.sh --reset-password '新密码'</code></p>
        <div class="section-actions">
          <button class="btn btn-primary" id="pw-save" title="保存用户名与密码">保存账号</button>
          <button class="btn btn-ghost" id="btn-logout-set" title="退出当前会话">退出登录</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>套餐与默认落地</h3></div>
        <p class="card-desc">到期/超额时自动停用用户并下发到落地 mita；默认落地用于未指定路由的用户。</p>
        <label class="check-row">
          <input type="checkbox" id="set-auto" ${auto ? 'checked' : ''} />
          到期/超额自动停用并下发（推荐开启）
        </label>
        <label style="margin-top:12px" for="set-primary">默认落地</label>
        <select class="field" id="set-primary">
          ${nodes
            .map(
              (n) =>
                `<option value="${esc(n.id)}" ${n.isPrimary ? 'selected' : ''}>${esc(n.name)}${
                  n.online ? ' · 在线' : ' · 离线'
                }</option>`
            )
            .join('') || '<option value="">（暂无落地）</option>'}
        </select>
        <div class="section-actions">
          <button class="btn btn-primary" id="set-save" title="保存套餐策略与默认落地">保存设置</button>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>关于与备份</h3></div>
      <p class="muted">版本 <strong>v${esc(state.status?.version || '')}</strong> · 协议 <strong>mieru / mita</strong> · 多 IX / 多落地</p>
      <p class="field-hint">路径：客户端 → 前置 → IX → 落地。面板独立 VPS。升级前备份 <code>data/state.json</code>。</p>
      <div class="section-actions">
        <a class="btn btn-secondary" href="/api/export" title="导出完整配置 JSON">导出 JSON</a>
        <button class="btn btn-ghost" data-nav-jump="diagnose" title="检查链路健康">打开诊断</button>
      </div>
    </div>
  `);
  bindShell();

  let showPw = false;
  document.getElementById('pw-toggle')?.addEventListener('click', () => {
    showPw = !showPw;
    ['pw-old', 'pw-new', 'pw-new2'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.type = showPw ? 'text' : 'password';
    });
    document.getElementById('pw-toggle').textContent = showPw ? '隐藏' : '显示';
  });

  document.getElementById('set-save').onclick = async () => {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: {
          autoApplyEnforce: document.getElementById('set-auto')?.checked,
          primaryNodeId: val('set-primary') || undefined,
        },
      });
      toast('设置已保存');
      await refreshCore();
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  document.getElementById('pw-save').onclick = async () => {
    const oldP = document.getElementById('pw-old')?.value || '';
    const n1 = document.getElementById('pw-new')?.value || '';
    const n2 = document.getElementById('pw-new2')?.value || '';
    const newUser = val('acc-user');
    if (!oldP) return toast('请填写当前密码', 'err');
    if (n1.length < 6) return toast('新密码至少 6 位', 'err');
    if (n1 !== n2) return toast('两次新密码不一致', 'err');
    try {
      const r = await api('/api/password', {
        method: 'POST',
        body: {
          currentPassword: oldP,
          newPassword: n1,
          newUsername: newUser || undefined,
        },
      });
      toast(r.message || '账号已更新');
      document.getElementById('pw-old').value = '';
      document.getElementById('pw-new').value = '';
      document.getElementById('pw-new2').value = '';
      await refreshCore();
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  document.getElementById('btn-logout-set')?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    await boot();
  });
}

/* ========== 动作 ========== */
let _jobPollTimer = null;
let _jobPollNodeId = null;
function stopJobPoll() {
  if (_jobPollTimer) {
    clearInterval(_jobPollTimer);
    _jobPollTimer = null;
  }
}
function pickJob(nodeId) {
  const list = state.nodes || [];
  if (nodeId) {
    const n = list.find((x) => x.id === nodeId);
    if (n?.latestJob) return n.latestJob;
  }
  // 任一落地有 pending/running 优先；否则 primary 最近任务
  const busy = list.find(
    (n) => n.latestJob && (n.latestJob.status === 'pending' || n.latestJob.status === 'running')
  );
  if (busy) return busy.latestJob;
  return state.primaryNode?.latestJob || list.find((n) => n.latestJob)?.latestJob || null;
}
function startJobPoll(nodeId) {
  stopJobPoll();
  _jobPollNodeId = nodeId || null;
  let n = 0;
  _jobPollTimer = setInterval(async () => {
    n += 1;
    try {
      await refreshCore();
      const job = pickJob(_jobPollNodeId);
      const pending = job && (job.status === 'pending' || job.status === 'running');
      if (!pending || n >= 45) {
        stopJobPoll();
        if (job?.status === 'done') {
          let m = job.message || '任务完成';
          if (/脚本异常.*回退成功/.test(m)) {
            m = '落地/应用成功 · mita 已更新（请升级落地 Agent，避免旧提示）';
          }
          toast(m, 'ok');
        } else if (job?.status === 'error' || job?.status === 'failed')
          toast(job.message || '任务失败', 'err');
        render();
      } else if (n % 2 === 0) {
        render();
      }
    } catch {
      /* */
    }
  }, 4000);
}

async function applyConfig(confirmFirst = false, opts = {}) {
  if (confirmFirst) {
    const tip = opts.nodeId
      ? '将 mita 配置下发到该落地。继续？'
      : opts.all
        ? '将配置下发到全部落地。继续？'
        : '将 mita 配置下发到默认落地。继续？';
    if (!confirm(tip)) return;
  }
  try {
    toast('正在下发…', 'warn');
    const body = {};
    if (opts.nodeId) body.nodeId = opts.nodeId;
    if (opts.all) body.all = true;
    const res = opts.nodeId
      ? await api(`/api/nodes/${opts.nodeId}/apply`, { method: 'POST', body: {} })
      : await api('/api/apply', { method: 'POST', body });
    toast(res.message || '完成', res.ok ? 'ok' : 'err');
    if (res.pending) startJobPoll(opts.nodeId || null);
    await refreshCore();
    render();
  } catch (e) {
    toast(e.data?.error || e.message, 'err');
  }
}

async function setupExit(nodeId) {
  if (!confirm('在落地家宽安装/配置 mita 并放行端口？不会改面板机/IX 网络。')) return;
  try {
    toast('正在一键落地…', 'warn');
    const res = nodeId
      ? await api(`/api/nodes/${nodeId}/exit`, { method: 'POST', body: {} })
      : await api('/api/exit/setup', { method: 'POST', body: {} });
    toast(res.message || '完成', res.ok ? 'ok' : 'err');
    if (res.pending) startJobPoll(nodeId || res.node?.id || null);
    openModal({
      title: '落地任务',
      body: `
        <p>${esc(res.message || '')}</p>
        <ol class="field-hint" style="padding-left:18px">
          <li>Agent 约 10 秒拉取任务</li>
          <li>在「拓扑」生成 IX 转发脚本并在对应 IX root 整文件执行</li>
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
  if (state.page !== 'clients') stopClientsLivePoll();
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
    state.nodes = status.nodes || [];
    state.wizardDone = status.wizardDone;
    state.topology = status.topology || null;
    await refreshCore();
    await render();
  } catch (e) {
    renderBoot('加载失败: ' + e.message);
  }
}

boot();
