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

function help(tip) {
  return `<span class="help" tabindex="0" data-tip="${esc(tip)}">?</span>`;
}

function fmtTime(iso) {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleString('zh-CN'); } catch { return iso; }
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

function dirtyBanner() {
  if (!state.dirty) return '';
  return `<div class="tip warn dirty-banner" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
    <div><strong>有未应用的配置变更</strong> · 修改已保存到面板，但尚未写入服务器 WireGuard</div>
    <div class="btn-row">
      <button class="btn btn-ghost btn-sm" id="banner-preflight">预检</button>
      <button class="btn btn-success btn-sm" id="banner-apply">应用到服务器</button>
    </div>
  </div>`;
}

function bindDirtyBanner() {
  document.getElementById('banner-apply')?.addEventListener('click', applyConfig);
  document.getElementById('banner-preflight')?.addEventListener('click', showPreflight);
}

function forcePasswordBanner() {
  if (!state.status?.forcePasswordChange) return '';
  return `<div class="tip warn" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
    <div><strong>建议立即修改初始密码</strong> · 当前仍在使用安装时生成的密码</div>
    <button class="btn btn-primary btn-sm" data-nav-jump="settings">去修改</button>
  </div>`;
}

function renderBoot(msg = '正在加载…') {
  app.innerHTML = `
    <div class="boot-screen">
      <div class="boot-card">
        <div class="logo">WG</div>
        <h1>WireGuard 配置面板</h1>
        <p class="muted">${esc(msg)}</p>
      </div>
    </div>`;
}

function renderSetup() {
  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="logo">WG</div>
        <h1>欢迎使用</h1>
        <p class="muted">首次使用请设置登录账号。默认用户名 <strong>admin</strong>，密码只保存在服务器上。</p>
        <div class="tip">若通过 install.sh 安装，终端会打印随机密码；也可在此重新设置。</div>
        <form id="setup-form">
          <div class="form-row">
            <label>用户名</label>
            <input class="field" type="text" name="username" value="admin" required autocomplete="username" />
          </div>
          <div class="form-row">
            <label>登录密码 ${help('至少 6 位，用于保护面板')}</label>
            <input class="field" type="password" name="password" minlength="6" required placeholder="请输入密码" autocomplete="new-password" />
          </div>
          <div class="form-row">
            <label>确认密码</label>
            <input class="field" type="password" name="password2" minlength="6" required placeholder="再输入一次" autocomplete="new-password" />
          </div>
          <button class="btn btn-primary" style="width:100%" type="submit">开始使用</button>
          <p class="field-hint" id="setup-err" style="color:var(--danger)"></p>
        </form>
      </div>
    </div>`;
  document.getElementById('setup-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const username = fd.get('username') || 'admin';
    const password = fd.get('password');
    const password2 = fd.get('password2');
    const err = document.getElementById('setup-err');
    if (password !== password2) { err.textContent = '两次密码不一致'; return; }
    try {
      await api('/api/setup', { method: 'POST', body: { username, password } });
      toast('初始化成功');
      await boot();
    } catch (ex) { err.textContent = ex.message; }
  };
}

function renderLogin() {
  const defaultUser = state.status?.defaultUsername || 'admin';
  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="logo">WG</div>
        <h1>登录面板</h1>
        <p class="muted">WireGuard 服务端配置管理</p>
        <form id="login-form">
          <div class="form-row">
            <label>用户名</label>
            <input class="field" type="text" name="username" value="${esc(defaultUser)}" required autocomplete="username" />
          </div>
          <div class="form-row">
            <label>密码</label>
            <input class="field" type="password" name="password" required placeholder="输入面板密码" autocomplete="current-password" />
          </div>
          <button class="btn btn-primary" style="width:100%" type="submit">登录</button>
          <p class="field-hint" id="login-err" style="color:var(--danger)"></p>
          <p class="field-hint">默认用户名 <strong>admin</strong>，密码见安装时终端输出</p>
        </form>
      </div>
    </div>`;
  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const username = fd.get('username') || 'admin';
    const password = fd.get('password');
    try {
      await api('/api/login', { method: 'POST', body: { username, password } });
      await boot();
    } catch (ex) {
      document.getElementById('login-err').textContent = ex.message;
    }
  };
}

function shell(content) {
  const page = state.page;
  const nav = [
    ['dashboard', '仪表盘', '📊'],
    ['clients', '客户端', '📱'],
    ['server', '服务器', '🖥️'],
    ['deploy', '部署指南', '🚀'],
    ['settings', '设置', '⚙️'],
  ];
  const ver = state.status?.version ? `v${state.status.version}` : '';
  return `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand">
          <div class="logo">WG</div>
          <div><strong>WG 面板</strong><span>${esc(ver)} · 新手友好</span></div>
        </div>
        ${nav.map(([id, label, icon]) => `
          <button class="nav-btn ${page === id ? 'active' : ''}" data-nav="${id}">
            <span>${icon}</span><span class="nav-label">${label}${id === 'clients' && state.dirty ? ' •' : ''}</span>
          </button>`).join('')}
        <div class="sidebar-footer">
          <button class="nav-btn" id="btn-logout"><span>🚪</span><span class="nav-label">退出登录</span></button>
        </div>
      </aside>
      <main class="main">
        ${forcePasswordBanner()}
        ${dirtyBanner()}
        ${content}
      </main>
    </div>
    <div id="modal-root"></div>`;
}

function bindShell() {
  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.onclick = () => { state.page = btn.dataset.nav; render(); };
  });
  document.querySelectorAll('[data-nav-jump]').forEach((b) => {
    b.onclick = () => { state.page = b.dataset.navJump; render(); };
  });
  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    await boot();
  });
  bindDirtyBanner();
  if (state.modal) renderModal(state.modal);
}

async function loadMainData() {
  const [serverRes, clientsRes, statusRes] = await Promise.all([
    api('/api/server'),
    api('/api/clients'),
    api('/api/status'),
  ]);
  state.server = serverRes.server;
  state.wizardDone = serverRes.wizardDone;
  state.clients = clientsRes.clients;
  state.status = statusRes;
  state.dirty = Boolean(statusRes.dirty ?? serverRes.dirty ?? clientsRes.dirty);
  state.lastAppliedAt = statusRes.lastAppliedAt || serverRes.lastAppliedAt || null;
}

function onlineCount() {
  return state.clients.filter((c) => c.online).length;
}

function renderDashboard() {
  const s = state.server || {};
  const st = state.status || {};
  const iface = st.interface || {};
  const tools = st.tools || {};
  const up = iface.up;
  return `
    <div class="page-header">
      <div>
        <h2>仪表盘</h2>
        <p>一眼看清服务器状态 · 上次应用：${esc(fmtTime(state.lastAppliedAt))}</p>
      </div>
      <div class="btn-row">
        <button class="btn btn-ghost" id="dash-preflight">应用预检</button>
        <button class="btn btn-primary" id="dash-add">＋ 添加客户端</button>
        <button class="btn btn-success" id="dash-apply">应用到服务器</button>
      </div>
    </div>
    <div class="grid grid-4" style="margin-bottom:14px">
      <div class="card"><div class="stat-label">接口状态</div><div class="stat-value"><span class="badge ${up ? 'ok' : 'warn'}">${up ? '运行中' : '未启动'}</span></div></div>
      <div class="card"><div class="stat-label">客户端 / 在线</div><div class="stat-value">${state.clients.length} <span class="muted" style="font-size:0.9rem">/ ${onlineCount()} 在线</span></div></div>
      <div class="card"><div class="stat-label">监听端口</div><div class="stat-value">UDP ${esc(s.listenPort || 51820)}</div></div>
      <div class="card"><div class="stat-label">配置状态</div><div class="stat-value"><span class="badge ${state.dirty ? 'warn' : 'ok'}">${state.dirty ? '待应用' : '已同步'}</span></div></div>
    </div>
    <div class="grid grid-2">
      <div class="card">
        <h3>服务器摘要</h3>
        <div class="kvs">
          <div class="kv"><span>接口名</span><span class="mono">${esc(s.interfaceName || 'wg0')}</span></div>
          <div class="kv"><span>内网地址</span><span class="mono">${esc(s.address || '-')}</span></div>
          <div class="kv"><span>Endpoint</span><span class="mono">${esc(s.endpoint || '未设置')}</span></div>
          <div class="kv"><span>系统工具</span><span>
            <span class="badge ${tools.wg ? 'ok' : 'err'}">wg</span>
            <span class="badge ${tools.wgQuick ? 'ok' : 'err'}">wg-quick</span>
          </span></div>
          <div class="kv"><span>公钥</span><span class="mono" style="max-width:55%;word-break:break-all;text-align:right">${esc(s.publicKey || '-')}</span></div>
        </div>
        <div class="btn-row" style="margin-top:14px">
          <button class="btn btn-ghost btn-sm" id="dash-fill-ip">一键填公网 IP</button>
          <button class="btn btn-ghost btn-sm" id="dash-server-conf">查看服务端配置</button>
          <button class="btn btn-ghost btn-sm" id="dash-dl-server">下载 wg 配置</button>
          <button class="btn btn-ghost btn-sm" data-nav-jump="server">修改设置</button>
        </div>
      </div>
      <div class="card">
        <h3>新手下一步</h3>
        <ol class="guide" style="margin:0;padding-left:1.1rem;color:var(--muted)">
          <li>确认 Endpoint 为公网 IP:端口（可点「一键填公网 IP」）</li>
          <li>添加客户端，手机扫码或下载 .conf</li>
          <li>先「应用预检」，再点「应用到服务器」</li>
          <li>防火墙放行 UDP ${esc(s.listenPort || 51820)}</li>
        </ol>
        <div class="tip" style="margin-top:12px;margin-bottom:0">应用前会自动备份旧配置。失败时面板会给出中文原因。</div>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="page-header" style="margin-bottom:8px">
        <h3 style="margin:0">客户端状态</h3>
        <button class="btn btn-ghost btn-sm" data-nav-jump="clients">查看全部</button>
      </div>
      ${state.clients.length ? `<div class="table-wrap"><table>
        <thead><tr><th>名称</th><th>IP</th><th>在线</th><th>握手</th><th>流量</th><th>操作</th></tr></thead>
        <tbody>${state.clients.slice(0, 8).map(c => `<tr>
          <td><strong>${esc(c.name)}</strong></td>
          <td class="mono">${esc(c.address)}</td>
          <td><span class="badge ${c.online ? 'ok' : (c.enabled ? 'warn' : '')}">${c.online ? '在线' : (c.enabled ? '离线' : '停用')}</span></td>
          <td class="small muted">${esc(c.latestHandshake || '-')}</td>
          <td class="small muted">${esc(c.transfer || '-')}</td>
          <td><button class="btn btn-sm btn-primary" data-qr="${c.id}">二维码</button></td>
        </tr>`).join('')}</tbody></table></div>`
      : `<div class="empty"><div class="emoji">📭</div><div>还没有客户端，先添加第一个吧</div>
          <button class="btn btn-primary" style="margin-top:12px" id="dash-add-2">添加客户端</button></div>`}
    </div>`;
}

function bindDashboard() {
  const add = () => openClientModal();
  document.getElementById('dash-add')?.addEventListener('click', add);
  document.getElementById('dash-add-2')?.addEventListener('click', add);
  document.getElementById('dash-apply')?.addEventListener('click', applyConfig);
  document.getElementById('dash-preflight')?.addEventListener('click', showPreflight);
  document.getElementById('dash-server-conf')?.addEventListener('click', showServerConfig);
  document.getElementById('dash-dl-server')?.addEventListener('click', () => {
    window.location.href = '/api/server/config?format=download';
  });
  document.getElementById('dash-fill-ip')?.addEventListener('click', fillPublicIp);
  document.querySelectorAll('[data-qr]').forEach((b) => {
    b.onclick = () => showClientQr(b.dataset.qr);
  });
}

function renderClients() {
  return `
    <div class="page-header">
      <div><h2>客户端管理</h2><p>在线状态来自 wg show 握手时间（约 3 分钟内视为在线）</p></div>
      <div class="btn-row">
        <button class="btn btn-ghost" id="client-export-all">批量导出</button>
        <button class="btn btn-primary" id="client-add">＋ 添加客户端</button>
        <button class="btn btn-success" id="client-apply">应用到服务器</button>
      </div>
    </div>
    <div class="card">
      ${state.clients.length ? `<div class="table-wrap"><table>
        <thead><tr>
          <th>名称</th><th>内网 IP</th><th>在线</th><th>握手</th><th>流量</th><th>AllowedIPs</th><th>状态</th><th>操作</th>
        </tr></thead>
        <tbody>${state.clients.map(c => `<tr>
          <td><strong>${esc(c.name)}</strong>${c.note ? `<div class="small muted">${esc(c.note)}</div>` : ''}</td>
          <td class="mono">${esc(c.address)}</td>
          <td><span class="badge ${c.online ? 'ok' : (c.enabled ? 'warn' : '')}">${c.online ? '在线' : (c.enabled ? '离线' : '停用')}</span></td>
          <td class="small muted">${esc(c.latestHandshake || '-')}</td>
          <td class="small muted">${esc(c.transfer || '-')}</td>
          <td class="mono small">${esc(c.allowedIPs)}</td>
          <td><label class="switch"><input type="checkbox" data-toggle="${c.id}" ${c.enabled ? 'checked' : ''} /><span></span></label></td>
          <td><div class="btn-row">
            <button class="btn btn-sm btn-primary" data-qr="${c.id}">二维码</button>
            <button class="btn btn-sm btn-ghost" data-cfg="${c.id}">配置</button>
            <button class="btn btn-sm btn-ghost" data-dl="${c.id}">下载</button>
            <button class="btn btn-sm btn-ghost" data-edit="${c.id}">编辑</button>
            <button class="btn btn-sm btn-danger" data-del="${c.id}">删除</button>
          </div></td>
        </tr>`).join('')}</tbody></table></div>`
      : `<div class="empty"><div class="emoji">📱</div><div>还没有客户端</div>
          <p class="small">添加后可生成二维码，用手机 WireGuard App 扫码导入</p>
          <button class="btn btn-primary" id="client-add-2">添加第一个客户端</button></div>`}
    </div>`;
}

function bindClients() {
  document.getElementById('client-add')?.addEventListener('click', () => openClientModal());
  document.getElementById('client-add-2')?.addEventListener('click', () => openClientModal());
  document.getElementById('client-apply')?.addEventListener('click', applyConfig);
  document.getElementById('client-export-all')?.addEventListener('click', exportAllClients);
  document.querySelectorAll('[data-qr]').forEach((b) => (b.onclick = () => showClientQr(b.dataset.qr)));
  document.querySelectorAll('[data-cfg]').forEach((b) => (b.onclick = () => showClientConfig(b.dataset.cfg)));
  document.querySelectorAll('[data-dl]').forEach((b) => {
    b.onclick = () => { window.location.href = `/api/clients/${b.dataset.dl}/config?format=download`; };
  });
  document.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => {
      const c = state.clients.find((x) => x.id === b.dataset.edit);
      if (c) openClientModal(c);
    };
  });
  document.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const c = state.clients.find((x) => x.id === b.dataset.del);
      if (!confirm(`确定删除客户端「${c?.name || ''}」？`)) return;
      try {
        await api(`/api/clients/${b.dataset.del}`, { method: 'DELETE' });
        toast('已删除');
        await refreshAndRender();
      } catch (ex) { toast(ex.message, 'err'); }
    };
  });
  document.querySelectorAll('[data-toggle]').forEach((inp) => {
    inp.onchange = async () => {
      try {
        await api(`/api/clients/${inp.dataset.toggle}`, { method: 'PUT', body: { enabled: inp.checked } });
        toast(inp.checked ? '已启用' : '已停用');
        await refreshAndRender();
      } catch (ex) {
        toast(ex.message, 'err');
        inp.checked = !inp.checked;
      }
    };
  });
}

function renderServer() {
  const s = state.server || {};
  return `
    <div class="page-header">
      <div><h2>服务器设置</h2><p>这些信息会写进服务端配置，并影响所有客户端</p></div>
      <div class="btn-row">
        <button class="btn btn-ghost" id="srv-fill-ip">一键公网 IP</button>
        <button class="btn btn-ghost" id="srv-nat">填入 NAT 模板</button>
        <button class="btn btn-primary" id="srv-save">保存设置</button>
      </div>
    </div>
    <div class="grid grid-2">
      <div class="card">
        <h3>基本信息</h3>
        <div class="form-row">
          <label>接口名 ${help('一般用 wg0')}</label>
          <input class="field" id="s-interfaceName" value="${esc(s.interfaceName || 'wg0')}" />
        </div>
        <div class="inline-fields">
          <div class="form-row">
            <label>监听端口 ${help('UDP 端口，默认 51820')}</label>
            <input class="field" type="number" id="s-listenPort" value="${esc(s.listenPort || 51820)}" />
          </div>
          <div class="form-row">
            <label>MTU</label>
            <input class="field" type="number" id="s-mtu" value="${esc(s.mtu ?? 1420)}" />
          </div>
        </div>
        <div class="form-row">
          <label>服务器内网地址</label>
          <input class="field mono" id="s-address" value="${esc(s.address || '10.8.0.1/24')}" />
        </div>
        <div class="form-row">
          <label>Endpoint（公网地址） ${help('客户端连接地址：公网IP:端口')}</label>
          <div style="display:flex;gap:8px">
            <input class="field mono" id="s-endpoint" value="${esc(s.endpoint || '')}" placeholder="例如 203.0.113.10:51820" style="flex:1" />
            <button class="btn btn-ghost" type="button" id="srv-fill-ip-2">探测</button>
          </div>
        </div>
        <div class="form-row">
          <label>客户端 DNS</label>
          <input class="field mono" id="s-dns" value="${esc(s.dns || '')}" placeholder="1.1.1.1" />
        </div>
        <div class="form-row">
          <label>配置文件路径</label>
          <input class="field mono" id="s-confPath" value="${esc(s.confPath || '/etc/wireguard/wg0.conf')}" />
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-weight:500" class="small">
          <input type="checkbox" id="s-sync-port" checked /> 保存时自动同步 Endpoint 端口
        </label>
      </div>
      <div class="card">
        <h3>密钥与 NAT</h3>
        <div class="form-row">
          <label>服务器公钥</label>
          <input class="field mono" readonly value="${esc(s.publicKey || '')}" />
        </div>
        <div class="btn-row" style="margin-bottom:14px">
          <button class="btn btn-ghost" id="srv-regen">重新生成服务器密钥</button>
          <button class="btn btn-ghost" id="srv-view-conf">预览服务端配置</button>
          <button class="btn btn-ghost" id="srv-preflight">应用预检</button>
        </div>
        <div class="tip warn">重新生成服务器密钥后，所有客户端配置都会失效。</div>
        <div class="form-row">
          <label>PostUp ${help('接口启动时执行，常用于 NAT')}</label>
          <textarea class="textarea mono" id="s-postUp">${esc(s.postUp || '')}</textarea>
        </div>
        <div class="form-row">
          <label>PostDown</label>
          <textarea class="textarea mono" id="s-postDown">${esc(s.postDown || '')}</textarea>
          <div class="field-hint">点「填入 NAT 模板」会自动识别出口网卡</div>
        </div>
      </div>
    </div>`;
}

function bindServer() {
  const fill = () => fillPublicIp(true);
  document.getElementById('srv-fill-ip').onclick = fill;
  document.getElementById('srv-fill-ip-2').onclick = fill;
  document.getElementById('srv-save').onclick = async () => {
    try {
      const body = {
        interfaceName: val('s-interfaceName'),
        listenPort: Number(val('s-listenPort')) || 51820,
        mtu: Number(val('s-mtu')) || null,
        address: val('s-address'),
        endpoint: val('s-endpoint'),
        dns: val('s-dns'),
        confPath: val('s-confPath'),
        postUp: val('s-postUp'),
        postDown: val('s-postDown'),
        syncEndpointPort: document.getElementById('s-sync-port')?.checked,
      };
      const res = await api('/api/server', { method: 'PUT', body });
      state.server = res.server;
      state.dirty = Boolean(res.dirty);
      toast('服务器设置已保存');
      render();
    } catch (ex) { toast(ex.message, 'err'); }
  };
  document.getElementById('srv-nat').onclick = async () => {
    try {
      const res = await api('/api/server/nat-template', { method: 'POST' });
      document.getElementById('s-postUp').value = res.postUp;
      document.getElementById('s-postDown').value = res.postDown;
      toast(res.tip || '已填入 NAT 模板', 'warn');
    } catch (ex) { toast(ex.message, 'err'); }
  };
  document.getElementById('srv-regen').onclick = async () => {
    if (!confirm('确定重新生成服务器密钥？所有现有客户端都需要重新导入配置。')) return;
    try {
      const res = await api('/api/server', { method: 'PUT', body: { regenerateKeys: true } });
      state.server = res.server;
      state.dirty = true;
      toast('服务器密钥已更新', 'warn');
      render();
    } catch (ex) { toast(ex.message, 'err'); }
  };
  document.getElementById('srv-view-conf').onclick = showServerConfig;
  document.getElementById('srv-preflight').onclick = showPreflight;
}

function renderDeploy() {
  const s = state.server || {};
  const port = s.listenPort || 51820;
  const iface = s.interfaceName || 'wg0';
  return `
    <div class="page-header"><div><h2>部署指南</h2><p>按下面步骤即可在闲置服务器上跑通 VPN</p></div></div>
    <div class="grid">
      <div class="card guide"><h3>1. 安装 / 更新面板</h3>
        <pre class="pre-box">git clone https://github.com/cheesydui-cloud/wg.git
cd wg
sudo bash install.sh
# 更新（保留 data 与密码）：
git pull && sudo bash install.sh</pre></div>
      <div class="card guide"><h3>2. 开启 IP 转发</h3>
        <pre class="pre-box">echo "net.ipv4.ip_forward=1" | sudo tee /etc/sysctl.d/99-wireguard.conf
sudo sysctl -p /etc/sysctl.d/99-wireguard.conf</pre></div>
      <div class="card guide"><h3>3. 放行防火墙端口</h3>
        <pre class="pre-box">sudo ufw allow ${port}/udp
sudo ufw allow 51821/tcp
sudo ufw reload</pre></div>
      <div class="card guide"><h3>4. 在本面板完成配置</h3>
        <ol>
          <li>一键填入公网 IP 作为 Endpoint</li>
          <li>填入 NAT 模板（自动识别出口网卡）</li>
          <li>添加客户端并扫码</li>
          <li>应用预检 → 应用到服务器</li>
        </ol>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn btn-ghost" id="dep-preflight">应用预检</button>
          <button class="btn btn-primary" id="dep-dl">下载服务端配置</button>
          <button class="btn btn-success" id="dep-apply">尝试应用到服务器</button>
        </div></div>
      <div class="card guide"><h3>5. 手动应用（可选）</h3>
        <pre class="pre-box">sudo cp ${esc(s.confPath || `/etc/wireguard/${iface}.conf`)} /etc/wireguard/${iface}.conf
sudo chmod 600 /etc/wireguard/${iface}.conf
sudo wg-quick up ${iface}
sudo systemctl enable wg-quick@${iface}</pre></div>
    </div>`;
}

function bindDeploy() {
  document.getElementById('dep-dl').onclick = () => { window.location.href = '/api/server/config?format=download'; };
  document.getElementById('dep-apply').onclick = applyConfig;
  document.getElementById('dep-preflight').onclick = showPreflight;
}

function renderSettings() {
  return `
    <div class="page-header"><div><h2>设置</h2><p>密码、备份与主题 · 面板 ${esc(state.status?.version ? 'v' + state.status.version : '')}</p></div></div>
    <div class="grid grid-2">
      <div class="card">
        <h3>修改登录账号</h3>
        ${state.status?.forcePasswordChange ? '<div class="tip warn">检测到初始密码，请尽快修改</div>' : ''}
        <div class="form-row"><label>当前用户名</label><input class="field" id="pw-user" value="${esc(state.status?.username || 'admin')}" /></div>
        <div class="form-row"><label>当前密码</label><input class="field" type="password" id="pw-old" /></div>
        <div class="form-row"><label>新密码</label><input class="field" type="password" id="pw-new" minlength="6" /></div>
        <button class="btn btn-primary" id="pw-save">更新账号</button>
      </div>
      <div class="card">
        <h3>数据备份</h3>
        <p class="muted small">导出包含服务器密钥和所有客户端私钥，请妥善保管。</p>
        <div class="btn-row">
          <button class="btn btn-ghost" id="exp-btn">导出备份 JSON</button>
          <label class="btn btn-ghost" style="cursor:pointer">导入备份
            <input type="file" id="imp-file" accept="application/json,.json" hidden />
          </label>
          <button class="btn btn-ghost" id="bak-list">配置备份列表</button>
        </div>
        <div class="tip warn" style="margin-top:12px">导入会覆盖当前服务器与客户端数据，但不会改登录密码。</div>
      </div>
      <div class="card">
        <h3>界面主题</h3>
        <div class="btn-row">
          <button class="btn btn-ghost" data-theme-set="auto">跟随系统</button>
          <button class="btn btn-ghost" data-theme-set="dark">深色</button>
          <button class="btn btn-ghost" data-theme-set="light">浅色</button>
        </div>
      </div>
      <div class="card">
        <h3>关于</h3>
        <p class="muted small">WG Panel v${esc(state.status?.version || '1.1.0')} — 面向新手的 WireGuard 服务端配置面板。</p>
        <p class="muted small">会话持久化、登录防爆破、应用预检、在线状态、配置备份回滚。</p>
        <p class="muted small"><a href="https://github.com/cheesydui-cloud/wg" target="_blank" rel="noreferrer">GitHub 仓库</a></p>
      </div>
    </div>`;
}

function bindSettings() {
  document.getElementById('pw-save').onclick = async () => {
    try {
      const res = await api('/api/password', {
        method: 'POST',
        body: {
          currentPassword: val('pw-old'),
          newPassword: val('pw-new'),
          newUsername: val('pw-user') || 'admin',
        },
      });
      toast(res.message || '账号已更新');
      document.getElementById('pw-old').value = '';
      document.getElementById('pw-new').value = '';
      if (state.status) {
        state.status.username = res.username || val('pw-user') || 'admin';
        state.status.forcePasswordChange = false;
      }
      render();
    } catch (ex) { toast(ex.message, 'err'); }
  };
  document.getElementById('exp-btn').onclick = () => { window.location.href = '/api/export'; };
  document.getElementById('bak-list').onclick = showBackups;
  document.getElementById('imp-file').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!confirm('确定导入并覆盖当前配置？')) return;
    try {
      const json = JSON.parse(await file.text());
      const res = await api('/api/import', { method: 'POST', body: json });
      toast(res.message || '导入成功');
      await refreshAndRender();
    } catch (ex) { toast(ex.message || '导入失败', 'err'); }
  };
  document.querySelectorAll('[data-theme-set]').forEach((b) => {
    b.onclick = () => {
      const t = b.dataset.themeSet;
      if (t === 'auto') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem('wg-theme', t);
      toast('主题已切换');
    };
  });
}

function renderWizard() {
  const step = state.wizardStep;
  const s = state.server || {};
  return shell(`
    <div class="page-header"><div><h2>新手引导</h2><p>4 步完成基础配置</p></div></div>
    <div class="steps">
      ${[1,2,3,4].map(n => `<span class="step-pill ${step===n?'active':''} ${step>n?'done':''}">${n}. ${['公网信息','密钥','网段','首个客户端'][n-1]}</span>`).join('')}
    </div>
    <div class="card" style="max-width:640px">
      ${step===1?`<h3>你的服务器公网地址</h3>
        <div class="form-row"><label>公网 IP 或域名</label>
          <div style="display:flex;gap:8px">
            <input class="field mono" id="w-host" placeholder="203.0.113.10" value="${esc((s.endpoint||'').split(':')[0]||'')}" style="flex:1" />
            <button class="btn btn-ghost" type="button" id="w-detect-ip">探测</button>
          </div></div>
        <div class="form-row"><label>WireGuard 端口</label>
          <input class="field" type="number" id="w-port" value="${esc(s.listenPort||51820)}" /></div>`:''}
      ${step===2?`<h3>服务器密钥</h3>
        <div class="form-row"><label>公钥</label>
          <input class="field mono" readonly value="${esc(s.publicKey||'（保存后生成）')}" /></div>
        <div class="tip ok">密钥保存在服务器 data 目录，面板不会外传。</div>`:''}
      ${step===3?`<h3>VPN 内网网段</h3>
        <div class="form-row"><label>服务器地址</label>
          <input class="field mono" id="w-address" value="${esc(s.address||'10.8.0.1/24')}" /></div>
        <div class="form-row"><label>DNS</label>
          <input class="field mono" id="w-dns" value="${esc(s.dns||'1.1.1.1')}" /></div>
        <div class="form-row"><label style="display:flex;align-items:center;gap:10px;font-weight:500">
          <label class="switch"><input type="checkbox" id="w-nat" checked /><span></span></label>
          启用 NAT（自动识别出口网卡）</label></div>`:''}
      ${step===4?`<h3>创建第一个客户端</h3>
        <div class="form-row"><label>名称</label><input class="field" id="w-cname" value="我的手机" /></div>
        <div class="form-row"><label>流量模式</label>
          <select class="select" id="w-allowed">
            <option value="0.0.0.0/0, ::/0">全局代理（推荐）</option>
            <option value="NET_ONLY">仅访问 VPN 内网</option>
          </select></div>
        <div class="tip">创建后可扫码，并建议立刻「应用预检 → 应用到服务器」。</div>`:''}
      <div class="actions-end">
        ${step>1?'<button class="btn btn-ghost" id="w-prev">上一步</button>':''}
        ${step<4?'<button class="btn btn-primary" id="w-next">下一步</button>':'<button class="btn btn-success" id="w-finish">完成并创建</button>'}
        <button class="btn btn-ghost" id="w-skip">跳过引导</button>
      </div>
    </div>`);
}

function bindWizard() {
  bindShell();
  document.getElementById('w-detect-ip')?.addEventListener('click', async () => {
    try {
      const res = await api('/api/system/public-ip');
      if (res.ip) {
        document.getElementById('w-host').value = res.ip;
        toast('已填入公网 IP: ' + res.ip);
      }
    } catch (ex) { toast(ex.message, 'err'); }
  });
  document.getElementById('w-prev')?.addEventListener('click', () => {
    state.wizardStep = Math.max(1, state.wizardStep - 1);
    render();
  });
  document.getElementById('w-skip')?.addEventListener('click', async () => {
    await api('/api/server', { method: 'PUT', body: { wizardDone: true } });
    state.wizardDone = true;
    state._skipWizardOnce = true;
    state.page = 'dashboard';
    await refreshAndRender();
  });
  document.getElementById('w-next')?.addEventListener('click', async () => {
    try {
      if (state.wizardStep === 1) {
        const host = val('w-host');
        const port = Number(val('w-port')) || 51820;
        if (!host) return toast('请填写公网 IP 或域名', 'warn');
        const res = await api('/api/server', { method: 'PUT', body: { endpoint: `${host}:${port}`, listenPort: port } });
        state.server = res.server;
      }
      if (state.wizardStep === 2) {
        const res = await api('/api/server', { method: 'PUT', body: {} });
        state.server = res.server;
      }
      if (state.wizardStep === 3) {
        const address = val('w-address') || '10.8.0.1/24';
        const dns = val('w-dns') || '1.1.1.1';
        let res = await api('/api/server', { method: 'PUT', body: { address, dns } });
        if (document.getElementById('w-nat')?.checked) {
          const nat = await api('/api/server/nat-template', { method: 'POST' });
          res = await api('/api/server', { method: 'PUT', body: { postUp: nat.postUp, postDown: nat.postDown } });
        }
        state.server = res.server;
      }
      state.wizardStep += 1;
      render();
    } catch (ex) { toast(ex.message, 'err'); }
  });
  document.getElementById('w-finish')?.addEventListener('click', async () => {
    try {
      const name = val('w-cname') || '我的手机';
      let allowedIPs = document.getElementById('w-allowed')?.value || '0.0.0.0/0, ::/0';
      if (allowedIPs === 'NET_ONLY') allowedIPs = networkFromAddress(state.server?.address || '10.8.0.1/24');
      const created = await api('/api/clients', { method: 'POST', body: { name, allowedIPs, usePresharedKey: true } });
      await api('/api/server', { method: 'PUT', body: { wizardDone: true } });
      state.wizardDone = true;
      state._skipWizardOnce = true;
      state.page = 'clients';
      await refreshAndRender();
      toast('引导完成，已创建客户端');
      if (created.client?.id) showClientQr(created.client.id);
    } catch (ex) { toast(ex.message, 'err'); }
  });
}

function openClientModal(client = null) {
  const isEdit = Boolean(client);
  const net = networkFromAddress(state.server?.address || '10.8.0.1/24');
  state.modal = {
    title: isEdit ? `编辑：${client.name}` : '添加客户端',
    body: `
      <div class="form-row"><label>名称</label>
        <input class="field" id="c-name" value="${esc(client?.name || '')}" placeholder="我的手机" /></div>
      <div class="form-row"><label>内网 IP ${help('留空则自动分配')}</label>
        <input class="field mono" id="c-address" value="${esc(client?.address || '')}" placeholder="自动分配" /></div>
      <div class="form-row"><label>AllowedIPs</label>
        <select class="select" id="c-allowed-preset">
          <option value="0.0.0.0/0, ::/0">全局代理 0.0.0.0/0</option>
          <option value="${esc(net)}">仅内网 ${esc(net)}</option>
          <option value="custom">自定义</option>
        </select></div>
      <div class="form-row" id="c-allowed-wrap" style="display:none">
        <label>自定义 AllowedIPs</label>
        <input class="field mono" id="c-allowed" value="${esc(client?.allowedIPs || '')}" />
      </div>
      <div class="inline-fields">
        <div class="form-row"><label>Keepalive</label>
          <input class="field" type="number" id="c-ka" value="${esc(client?.persistentKeepalive ?? 25)}" /></div>
        <div class="form-row"><label>备注</label>
          <input class="field" id="c-note" value="${esc(client?.note || '')}" /></div>
      </div>
      ${isEdit ? `<div class="btn-row">
          <button class="btn btn-ghost btn-sm" id="c-regen">重新生成客户端密钥</button>
          <button class="btn btn-ghost btn-sm" id="c-psk">重新生成 PSK</button>
        </div>` : `<div class="form-row"><label style="display:flex;align-items:center;gap:10px;font-weight:500">
          <label class="switch"><input type="checkbox" id="c-psk-on" checked /><span></span></label>
          使用预共享密钥 PSK（推荐）</label></div>`}
      <div class="actions-end">
        <button class="btn btn-ghost" id="c-cancel">取消</button>
        <button class="btn btn-primary" id="c-save">${isEdit ? '保存' : '创建'}</button>
      </div>`,
    after() {
      const preset = document.getElementById('c-allowed-preset');
      const wrap = document.getElementById('c-allowed-wrap');
      const allowed = document.getElementById('c-allowed');
      const applyPreset = () => {
        if (preset.value === 'custom') wrap.style.display = '';
        else { wrap.style.display = 'none'; allowed.value = preset.value; }
      };
      if (client?.allowedIPs) {
        if (client.allowedIPs === '0.0.0.0/0, ::/0' || client.allowedIPs === '0.0.0.0/0') preset.value = '0.0.0.0/0, ::/0';
        else if (client.allowedIPs === net) preset.value = net;
        else { preset.value = 'custom'; allowed.value = client.allowedIPs; }
      }
      applyPreset();
      preset.onchange = applyPreset;
      document.getElementById('c-cancel').onclick = closeModal;
      document.getElementById('c-save').onclick = async () => {
        const name = val('c-name') || (isEdit ? client.name : '客户端');
        let allowedIPs = preset.value === 'custom' ? val('c-allowed') : preset.value;
        const body = { name, address: val('c-address'), allowedIPs, persistentKeepalive: Number(val('c-ka')) || 0, note: val('c-note') };
        try {
          if (isEdit) {
            await api(`/api/clients/${client.id}`, { method: 'PUT', body });
            toast('已保存');
            closeModal();
            await refreshAndRender();
          } else {
            body.usePresharedKey = document.getElementById('c-psk-on')?.checked !== false;
            const res = await api('/api/clients', { method: 'POST', body });
            toast('客户端已创建');
            closeModal();
            await refreshAndRender();
            if (res.client?.id) showClientQr(res.client.id);
          }
        } catch (ex) { toast(ex.message, 'err'); }
      };
      document.getElementById('c-regen')?.addEventListener('click', async () => {
        if (!confirm('重新生成密钥后需重新导入配置，继续？')) return;
        await api(`/api/clients/${client.id}`, { method: 'PUT', body: { regenerateKeys: true } });
        toast('密钥已更新', 'warn');
        await refreshAndRender();
        openClientModal(state.clients.find((x) => x.id === client.id));
      });
      document.getElementById('c-psk')?.addEventListener('click', async () => {
        await api(`/api/clients/${client.id}`, { method: 'PUT', body: { regeneratePsk: true } });
        toast('PSK 已更新', 'warn');
      });
    },
  };
  renderModal(state.modal);
}

function closeModal() {
  state.modal = null;
  const root = document.getElementById('modal-root');
  if (root) root.innerHTML = '';
}

function renderModal(modal) {
  const root = document.getElementById('modal-root');
  if (!root || !modal) return;
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-bg">
      <div class="modal">
        <div class="modal-header">
          <h3>${esc(modal.title)}</h3>
          <button class="btn btn-ghost btn-sm" id="modal-x">关闭</button>
        </div>
        ${modal.body}
      </div>
    </div>`;
  document.getElementById('modal-x').onclick = closeModal;
  document.getElementById('modal-bg').onclick = (e) => { if (e.target.id === 'modal-bg') closeModal(); };
  modal.after?.();
}

async function showClientQr(id) {
  try {
    const data = await api(`/api/clients/${id}/config?format=qr`);
    state.modal = {
      title: `二维码 — ${data.name}`,
      body: `
        <div class="qr-wrap"><img src="${data.qr}" alt="WireGuard QR" />
          <p class="muted small">打开手机 WireGuard → 扫码添加隧道</p></div>
        <div class="btn-row" style="justify-content:center">
          <button class="btn btn-ghost" id="qr-copy">复制配置</button>
          <a class="btn btn-primary" href="/api/clients/${id}/config?format=download">下载 .conf</a>
        </div>
        <pre class="pre-box" style="margin-top:12px">${esc(data.config)}</pre>`,
      after() {
        document.getElementById('qr-copy').onclick = async () => {
          await navigator.clipboard.writeText(data.config);
          toast('配置已复制');
        };
      },
    };
    renderModal(state.modal);
  } catch (ex) { toast(ex.message, 'err'); }
}

async function showClientConfig(id) {
  try {
    const data = await api(`/api/clients/${id}/config`);
    state.modal = {
      title: `配置 — ${data.name}`,
      body: `
        <pre class="pre-box">${esc(data.config)}</pre>
        <div class="btn-row">
          <button class="btn btn-ghost" id="cfg-copy">复制</button>
          <a class="btn btn-primary" href="/api/clients/${id}/config?format=download">下载</a>
          <button class="btn btn-primary" id="cfg-qr">显示二维码</button>
        </div>`,
      after() {
        document.getElementById('cfg-copy').onclick = async () => {
          await navigator.clipboard.writeText(data.config);
          toast('已复制');
        };
        document.getElementById('cfg-qr').onclick = () => showClientQr(id);
      },
    };
    renderModal(state.modal);
  } catch (ex) { toast(ex.message, 'err'); }
}

async function showServerConfig() {
  try {
    const data = await api('/api/server/config');
    state.modal = {
      title: '服务端配置预览',
      body: `
        <p class="muted small">路径：${esc(data.path || '')}${data.dirty ? ' · 有未应用变更' : ''}</p>
        <pre class="pre-box">${esc(data.config)}</pre>
        <div class="btn-row">
          <button class="btn btn-ghost" id="sc-copy">复制</button>
          <a class="btn btn-primary" href="/api/server/config?format=download">下载</a>
        </div>`,
      after() {
        document.getElementById('sc-copy').onclick = async () => {
          await navigator.clipboard.writeText(data.config);
          toast('已复制');
        };
      },
    };
    renderModal(state.modal);
  } catch (ex) { toast(ex.message, 'err'); }
}

async function showPreflight() {
  try {
    const pf = await api('/api/preflight');
    state.preflight = pf;
    state.modal = {
      title: '应用预检',
      body: `
        <div class="tip ${pf.canApply ? 'ok' : 'warn'}">${pf.canApply ? '可以尝试应用到服务器' : '存在阻塞项，请先处理后再应用'}</div>
        <div class="table-wrap"><table>
          <thead><tr><th>检查项</th><th>结果</th><th>说明</th></tr></thead>
          <tbody>
            ${(pf.checks || []).map(c => `<tr>
              <td>${esc(c.title)}</td>
              <td><span class="badge ${c.ok ? 'ok' : (c.warn ? 'warn' : 'err')}">${c.ok ? '通过' : (c.warn ? '警告' : '失败')}</span></td>
              <td class="small muted">${esc(c.detail)}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
        <p class="small muted" style="margin-top:10px">出口网卡：${esc(pf.egressIface || '-')} · 配置路径：${esc(pf.confPath || '-')}</p>
        <div class="actions-end">
          <button class="btn btn-ghost" id="pf-close">关闭</button>
          <button class="btn btn-success" id="pf-apply" ${pf.canApply ? '' : 'disabled'}>仍然应用</button>
        </div>`,
      after() {
        document.getElementById('pf-close').onclick = closeModal;
        document.getElementById('pf-apply').onclick = () => { closeModal(); applyConfig(true); };
      },
    };
    renderModal(state.modal);
  } catch (ex) { toast(ex.message, 'err'); }
}

async function showBackups() {
  try {
    const data = await api('/api/backups');
    const list = data.backups || [];
    state.modal = {
      title: '配置备份列表',
      body: list.length ? `<div class="table-wrap"><table>
        <thead><tr><th>文件</th><th>时间</th><th>大小</th></tr></thead>
        <tbody>${list.map(b => `<tr>
          <td class="mono small">${esc(b.name)}</td>
          <td class="small">${esc(fmtTime(b.mtime))}</td>
          <td class="small">${esc(b.size)} B</td>
        </tr>`).join('')}</tbody></table></div>
        <p class="muted small">备份目录在服务器 data/backups，应用配置前会自动备份。</p>`
        : '<div class="empty">暂无备份（应用配置后会自动生成）</div>',
    };
    renderModal(state.modal);
  } catch (ex) { toast(ex.message, 'err'); }
}

async function fillPublicIp(intoServerField = false) {
  try {
    toast('正在探测公网 IP…', 'warn');
    const res = await api('/api/system/fill-endpoint', { method: 'POST', body: {} });
    if (intoServerField && document.getElementById('s-endpoint')) {
      document.getElementById('s-endpoint').value = res.endpoint;
    }
    state.server = res.server || state.server;
    state.dirty = Boolean(res.dirty);
    toast('Endpoint 已设为 ' + res.endpoint);
    if (!intoServerField) render();
  } catch (ex) { toast(ex.message || '探测失败', 'err'); }
}

async function exportAllClients() {
  try {
    const data = await api('/api/clients/export/zip-json');
    if (!data.files?.length) return toast('没有可导出的客户端', 'warn');
    // 逐个触发下载（纯前端，无 zip 依赖）
    for (const f of data.files) {
      const blob = new Blob([f.content], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = f.name;
      a.click();
      URL.revokeObjectURL(a.href);
      await new Promise((r) => setTimeout(r, 150));
    }
    toast(`已开始下载 ${data.files.length} 个配置文件`);
  } catch (ex) { toast(ex.message, 'err'); }
}

async function applyConfig(skipConfirm = false) {
  if (!skipConfirm && !confirm('将配置写入服务器并启动/重载 WireGuard 接口，继续？\n（应用前会自动备份旧配置）')) return;
  try {
    const res = await api('/api/apply', { method: 'POST' });
    toast(res.message || '已应用', res.ok === false ? 'err' : 'ok');
    await refreshAndRender();
  } catch (ex) {
    const msg = ex.data?.message || ex.message;
    toast(msg, 'err');
    const pf = ex.data?.preflight;
    if (pf?.checks) {
      state.modal = {
        title: '应用失败',
        body: `
          <div class="tip warn">${esc(msg)}</div>
          <div class="table-wrap"><table>
            <thead><tr><th>检查项</th><th>结果</th><th>说明</th></tr></thead>
            <tbody>${pf.checks.map(c => `<tr>
              <td>${esc(c.title)}</td>
              <td><span class="badge ${c.ok ? 'ok' : (c.warn ? 'warn' : 'err')}">${c.ok ? '通过' : (c.warn ? '警告' : '失败')}</span></td>
              <td class="small muted">${esc(c.detail)}</td>
            </tr>`).join('')}</tbody>
          </table></div>
          ${ex.data?.config ? `<p class="muted small">也可手动下载配置安装：</p><a class="btn btn-primary" href="/api/server/config?format=download">下载配置文件</a>` : ''}`,
      };
      renderModal(state.modal);
    } else if (ex.data?.config) {
      state.modal = {
        title: '应用失败 — 可手动安装',
        body: `
          <div class="tip warn">${esc(msg)}</div>
          <pre class="pre-box">${esc(ex.data.config)}</pre>
          <a class="btn btn-primary" href="/api/server/config?format=download">下载配置文件</a>`,
      };
      renderModal(state.modal);
    }
  }
}

async function refreshAndRender() {
  await loadMainData();
  render();
}

function render() {
  if (!state.wizardDone && !state._skipWizardOnce) {
    app.innerHTML = renderWizard();
    bindWizard();
    return;
  }
  let content = '';
  if (state.page === 'dashboard') content = renderDashboard();
  else if (state.page === 'clients') content = renderClients();
  else if (state.page === 'server') content = renderServer();
  else if (state.page === 'deploy') content = renderDeploy();
  else if (state.page === 'settings') content = renderSettings();
  else content = renderDashboard();
  app.innerHTML = shell(content);
  bindShell();
  if (state.page === 'dashboard') bindDashboard();
  if (state.page === 'clients') bindClients();
  if (state.page === 'server') bindServer();
  if (state.page === 'deploy') bindDeploy();
  if (state.page === 'settings') bindSettings();
}

async function boot() {
  const theme = localStorage.getItem('wg-theme');
  if (theme && theme !== 'auto') document.documentElement.setAttribute('data-theme', theme);
  renderBoot();
  try {
    const status = await api('/api/status');
    state.status = status;
    if (status.needSetup) { renderSetup(); return; }
    if (!status.loggedIn) { renderLogin(); return; }
    await loadMainData();
    if (!state.wizardDone) {
      state.wizardStep = 1;
      state._skipWizardOnce = false;
    } else {
      state._skipWizardOnce = true;
    }
    state.page = 'dashboard';
    render();
  } catch (ex) {
    renderBoot('无法连接面板服务：' + ex.message);
  }
}

boot();
