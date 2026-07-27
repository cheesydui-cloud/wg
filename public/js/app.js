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
  setTimeout(() => t.remove(), 3200);
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

function topAlerts() {
  const parts = [];
  if (state.status?.forcePasswordChange) {
    parts.push(`<div class="alert warn">
      <div><strong>请修改初始密码</strong> · 当前仍在使用安装时的随机密码</div>
      <button class="btn btn-sm btn-primary" data-nav-jump="settings">去修改</button>
    </div>`);
  }
  if (state.dirty) {
    parts.push(`<div class="alert warn">
      <div><strong>有未应用的更改</strong> · 已保存在面板，尚未写入服务器</div>
      <div class="btn-row">
        <button class="btn btn-sm btn-ghost" id="banner-preflight">预检</button>
        <button class="btn btn-sm btn-success" id="banner-apply">应用</button>
      </div>
    </div>`);
  }
  return parts.join('');
}

function bindTopAlerts() {
  document.getElementById('banner-apply')?.addEventListener('click', applyConfig);
  document.getElementById('banner-preflight')?.addEventListener('click', showPreflight);
  document.querySelectorAll('[data-nav-jump]').forEach((b) => {
    b.onclick = () => { state.page = b.dataset.navJump; render(); };
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
        <h1>创建管理员账号</h1>
        <p class="sub">首次使用需要设置登录账号，默认用户名 admin</p>
        <form id="setup-form">
          <div class="form-row">
            <label>用户名</label>
            <input class="field" type="text" name="username" value="admin" required autocomplete="username" />
          </div>
          <div class="form-row">
            <label>密码</label>
            <input class="field" type="password" name="password" minlength="6" required placeholder="至少 6 位" autocomplete="new-password" />
          </div>
          <div class="form-row">
            <label>确认密码</label>
            <input class="field" type="password" name="password2" minlength="6" required placeholder="再输入一次" autocomplete="new-password" />
          </div>
          <button class="btn btn-primary" style="width:100%;margin-top:4px" type="submit">开始使用</button>
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
        <h1>登录</h1>
        <p class="sub">WireGuard 配置面板</p>
        <form id="login-form">
          <div class="form-row">
            <label>用户名</label>
            <input class="field" type="text" name="username" value="${esc(defaultUser)}" required autocomplete="username" />
          </div>
          <div class="form-row">
            <label>密码</label>
            <input class="field" type="password" name="password" required placeholder="登录密码" autocomplete="current-password" />
          </div>
          <button class="btn btn-primary" style="width:100%;margin-top:4px" type="submit">登录</button>
          <p class="field-hint" id="login-err" style="color:var(--danger)"></p>
        </form>
      </div>
    </div>`;
  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/login', {
        method: 'POST',
        body: { username: fd.get('username') || 'admin', password: fd.get('password') },
      });
      await boot();
    } catch (ex) {
      document.getElementById('login-err').textContent = ex.message;
    }
  };
}

function shell(content) {
  const page = state.page;
  const nav = [
    ['dashboard', '概览', '◉'],
    ['clients', '客户端', '◎'],
    ['server', '服务器', '▣'],
    ['deploy', '部署', '➜'],
    ['settings', '设置', '⚙'],
  ];
  const ver = state.status?.version ? `v${state.status.version}` : '';
  return `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand">
          <div class="logo">WG</div>
          <div>
            <strong>WG Panel</strong>
            <span>${esc(ver)}</span>
          </div>
        </div>
        ${nav.map(([id, label, icon]) => `
          <button class="nav-btn ${page === id ? 'active' : ''}" data-nav="${id}">
            <span class="nav-ico">${icon}</span>
            <span class="nav-label">${label}</span>
            ${id === 'clients' && state.dirty ? '<span class="nav-dot" title="有未应用更改"></span>' : ''}
          </button>`).join('')}
        <div class="sidebar-footer">
          <button class="nav-btn" id="btn-logout">
            <span class="nav-ico">⎋</span>
            <span class="nav-label">退出</span>
          </button>
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
  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.onclick = () => { state.page = btn.dataset.nav; render(); };
  });
  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    await boot();
  });
  bindTopAlerts();
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

function statusBadge(up) {
  return `<span class="badge ${up ? 'ok' : 'warn'}">${up ? '运行中' : '未启动'}</span>`;
}

function clientStatusBadge(c) {
  if (!c.enabled) return '<span class="badge muted">停用</span>';
  if (c.online) return '<span class="badge ok">在线</span>';
  return '<span class="badge warn">离线</span>';
}

function renderDashboard() {
  const s = state.server || {};
  const st = state.status || {};
  const iface = st.interface || {};
  const tools = st.tools || {};
  return `
    <div class="page-header">
      <div>
        <h2>概览</h2>
        <p>上次应用：${esc(fmtTime(state.lastAppliedAt))}</p>
      </div>
      <div class="header-actions">
        <button class="btn btn-ghost" id="dash-add">添加客户端</button>
        <button class="btn btn-success" id="dash-apply">应用到服务器</button>
      </div>
    </div>

    <div class="grid grid-4" style="margin-bottom:12px">
      <div class="stat">
        <div class="stat-label">接口</div>
        <div class="stat-value">${statusBadge(iface.up)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">客户端</div>
        <div class="stat-value">${state.clients.length} <span class="sub">/ ${onlineCount()} 在线</span></div>
      </div>
      <div class="stat">
        <div class="stat-label">端口</div>
        <div class="stat-value">UDP ${esc(s.listenPort || 51820)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">配置</div>
        <div class="stat-value"><span class="badge ${state.dirty ? 'warn' : 'ok'}">${state.dirty ? '待应用' : '已同步'}</span></div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <h3>服务器</h3>
        <div class="kvs">
          <div class="kv"><span>接口</span><span class="mono">${esc(s.interfaceName || 'wg0')}</span></div>
          <div class="kv"><span>内网</span><span class="mono">${esc(s.address || '-')}</span></div>
          <div class="kv"><span>Endpoint</span><span class="mono">${esc(s.endpoint || '未设置')}</span></div>
          <div class="kv"><span>工具</span><span>
            <span class="badge ${tools.wg ? 'ok' : 'err'}">wg</span>
            <span class="badge ${tools.wgQuick ? 'ok' : 'err'}">wg-quick</span>
          </span></div>
        </div>
        <div class="btn-row" style="margin-top:14px">
          <button class="btn btn-sm btn-ghost" id="dash-fill-ip">填公网 IP</button>
          <button class="btn btn-sm btn-ghost" id="dash-preflight">预检</button>
          <button class="btn btn-sm btn-ghost" data-nav-jump="server">设置</button>
        </div>
      </div>
      <div class="card">
        <h3>快速开始</h3>
        <div class="guide">
          <ol>
            <li>确认 Endpoint（可用「填公网 IP」）</li>
            <li>添加客户端并扫码导入</li>
            <li>预检通过后点「应用到服务器」</li>
            <li>防火墙放行 UDP ${esc(s.listenPort || 51820)}</li>
          </ol>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:12px;padding:0;overflow:hidden">
      <div class="card-head" style="padding:14px 16px 0">
        <h3>客户端</h3>
        <button class="btn btn-sm btn-ghost" data-nav-jump="clients">全部</button>
      </div>
      ${state.clients.length ? `
        <div class="table-wrap" style="border:0;border-radius:0">
          <table>
            <thead>
              <tr><th>名称</th><th>IP</th><th>状态</th><th>握手</th><th></th></tr>
            </thead>
            <tbody>
              ${state.clients.slice(0, 6).map((c) => `
                <tr>
                  <td><span class="cell-name">${esc(c.name)}</span></td>
                  <td class="mono">${esc(c.address)}</td>
                  <td>${clientStatusBadge(c)}</td>
                  <td class="small muted">${esc(c.latestHandshake || '-')}</td>
                  <td><button class="btn btn-sm btn-ghost" data-qr="${c.id}">二维码</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : `
        <div class="empty">
          <div class="empty-title">还没有客户端</div>
          <p class="small muted">添加后可扫码导入手机</p>
          <button class="btn btn-primary" style="margin-top:12px" id="dash-add-2">添加客户端</button>
        </div>`}
    </div>`;
}

function bindDashboard() {
  const add = () => openClientModal();
  document.getElementById('dash-add')?.addEventListener('click', add);
  document.getElementById('dash-add-2')?.addEventListener('click', add);
  document.getElementById('dash-apply')?.addEventListener('click', applyConfig);
  document.getElementById('dash-preflight')?.addEventListener('click', showPreflight);
  document.getElementById('dash-fill-ip')?.addEventListener('click', () => fillPublicIp(false));
  document.querySelectorAll('[data-qr]').forEach((b) => {
    b.onclick = () => showClientQr(b.dataset.qr);
  });
}

function renderClients() {
  return `
    <div class="page-header">
      <div>
        <h2>客户端</h2>
        <p>${state.clients.length} 个 · ${onlineCount()} 在线</p>
      </div>
      <div class="header-actions">
        <button class="btn btn-ghost" id="client-export-all">导出全部</button>
        <button class="btn btn-primary" id="client-add">添加</button>
        <button class="btn btn-success" id="client-apply">应用</button>
      </div>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      ${state.clients.length ? `
        <div class="table-wrap" style="border:0;border-radius:0">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>IP</th>
                <th>状态</th>
                <th>握手</th>
                <th>流量</th>
                <th>启用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${state.clients.map((c) => `
                <tr>
                  <td>
                    <span class="cell-name">${esc(c.name)}</span>
                    ${c.note ? `<span class="cell-note">${esc(c.note)}</span>` : ''}
                  </td>
                  <td class="mono">${esc(c.address)}</td>
                  <td>${clientStatusBadge(c)}</td>
                  <td class="small muted">${esc(c.latestHandshake || '-')}</td>
                  <td class="small muted">${esc(c.transfer || '-')}</td>
                  <td>
                    <label class="switch">
                      <input type="checkbox" data-toggle="${c.id}" ${c.enabled ? 'checked' : ''} />
                      <span></span>
                    </label>
                  </td>
                  <td>
                    <div class="ops">
                      <button class="btn btn-sm btn-ghost" data-qr="${c.id}">二维码</button>
                      <button class="btn btn-sm btn-ghost" data-dl="${c.id}">下载</button>
                      <button class="btn btn-sm btn-ghost" data-edit="${c.id}">编辑</button>
                      <button class="btn btn-sm btn-danger" data-del="${c.id}">删除</button>
                    </div>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : `
        <div class="empty">
          <div class="empty-title">还没有客户端</div>
          <p class="small muted">创建后生成二维码，用 WireGuard App 扫码导入</p>
          <button class="btn btn-primary" style="margin-top:12px" id="client-add-2">添加客户端</button>
        </div>`}
    </div>`;
}

function bindClients() {
  document.getElementById('client-add')?.addEventListener('click', () => openClientModal());
  document.getElementById('client-add-2')?.addEventListener('click', () => openClientModal());
  document.getElementById('client-apply')?.addEventListener('click', applyConfig);
  document.getElementById('client-export-all')?.addEventListener('click', exportAllClients);
  document.querySelectorAll('[data-qr]').forEach((b) => (b.onclick = () => showClientQr(b.dataset.qr)));
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
      if (!confirm(`删除客户端「${c?.name || ''}」？`)) return;
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
      <div>
        <h2>服务器</h2>
        <p>接口与网络参数</p>
      </div>
      <div class="header-actions">
        <button class="btn btn-ghost" id="srv-preflight">预检</button>
        <button class="btn btn-primary" id="srv-save">保存</button>
      </div>
    </div>
    <div class="grid grid-2">
      <div class="card">
        <h3>基本信息</h3>
        <div class="form-row">
          <label>接口名</label>
          <input class="field" id="s-interfaceName" value="${esc(s.interfaceName || 'wg0')}" />
        </div>
        <div class="inline-fields">
          <div class="form-row">
            <label>监听端口 ${help('UDP，默认 51820')}</label>
            <input class="field" type="number" id="s-listenPort" value="${esc(s.listenPort || 51820)}" />
          </div>
          <div class="form-row">
            <label>MTU</label>
            <input class="field" type="number" id="s-mtu" value="${esc(s.mtu ?? 1420)}" />
          </div>
        </div>
        <div class="form-row">
          <label>内网地址</label>
          <input class="field mono" id="s-address" value="${esc(s.address || '10.8.0.1/24')}" />
        </div>
        <div class="form-row">
          <label>Endpoint ${help('客户端连接地址：公网IP:端口')}</label>
          <div class="field-with-btn">
            <input class="field mono" id="s-endpoint" value="${esc(s.endpoint || '')}" placeholder="203.0.113.10:51820" />
            <button class="btn btn-ghost" type="button" id="srv-fill-ip">探测</button>
          </div>
        </div>
        <div class="form-row">
          <label>DNS</label>
          <input class="field mono" id="s-dns" value="${esc(s.dns || '')}" placeholder="1.1.1.1" />
        </div>
        <div class="form-row">
          <label>配置路径</label>
          <input class="field mono" id="s-confPath" value="${esc(s.confPath || '/etc/wireguard/wg0.conf')}" />
        </div>
        <label class="small muted" style="display:flex;align-items:center;gap:8px;font-weight:500">
          <input type="checkbox" id="s-sync-port" checked /> 保存时同步 Endpoint 端口
        </label>
      </div>
      <div class="card">
        <h3>密钥与 NAT</h3>
        <div class="form-row">
          <label>服务器公钥</label>
          <input class="field mono" readonly value="${esc(s.publicKey || '')}" />
        </div>
        <div class="btn-row" style="margin-bottom:12px">
          <button class="btn btn-sm btn-ghost" id="srv-regen">重置密钥</button>
          <button class="btn btn-sm btn-ghost" id="srv-view-conf">预览配置</button>
          <button class="btn btn-sm btn-ghost" id="srv-nat">NAT 模板</button>
        </div>
        <div class="form-row">
          <label>PostUp</label>
          <textarea class="textarea mono" id="s-postUp">${esc(s.postUp || '')}</textarea>
        </div>
        <div class="form-row">
          <label>PostDown</label>
          <textarea class="textarea mono" id="s-postDown">${esc(s.postDown || '')}</textarea>
          <div class="field-hint">NAT 模板会自动识别出口网卡</div>
        </div>
      </div>
    </div>`;
}

function bindServer() {
  document.getElementById('srv-fill-ip').onclick = () => fillPublicIp(true);
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
      toast('已保存');
      render();
    } catch (ex) { toast(ex.message, 'err'); }
  };
  document.getElementById('srv-nat').onclick = async () => {
    try {
      const res = await api('/api/server/nat-template', { method: 'POST' });
      document.getElementById('s-postUp').value = res.postUp;
      document.getElementById('s-postDown').value = res.postDown;
      toast(res.tip || '已填入 NAT 模板');
    } catch (ex) { toast(ex.message, 'err'); }
  };
  document.getElementById('srv-regen').onclick = async () => {
    if (!confirm('重置服务器密钥后，所有客户端都需要重新导入。继续？')) return;
    try {
      const res = await api('/api/server', { method: 'PUT', body: { regenerateKeys: true } });
      state.server = res.server;
      state.dirty = true;
      toast('密钥已更新', 'warn');
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
    <div class="page-header">
      <div>
        <h2>部署</h2>
        <p>常用命令与检查</p>
      </div>
      <div class="header-actions">
        <button class="btn btn-ghost" id="dep-preflight">预检</button>
        <button class="btn btn-success" id="dep-apply">应用</button>
      </div>
    </div>
    <div class="grid">
      <div class="card guide">
        <h3>更新面板</h3>
        <pre class="pre-box">cd ~/wg && git pull && sudo bash install.sh</pre>
      </div>
      <div class="card guide">
        <h3>防火墙</h3>
        <pre class="pre-box">sudo ufw allow ${port}/udp
sudo ufw allow 51821/tcp
sudo ufw reload</pre>
      </div>
      <div class="card guide">
        <h3>手动启动接口</h3>
        <pre class="pre-box">sudo wg-quick up ${iface}
sudo systemctl enable wg-quick@${iface}
sudo wg show</pre>
      </div>
      <div class="card guide">
        <h3>建议流程</h3>
        <ol>
          <li>填好 Endpoint 与 NAT</li>
          <li>添加客户端并扫码</li>
          <li>预检 → 应用到服务器</li>
        </ol>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn btn-sm btn-ghost" id="dep-dl">下载服务端配置</button>
        </div>
      </div>
    </div>`;
}

function bindDeploy() {
  document.getElementById('dep-dl').onclick = () => {
    window.location.href = '/api/server/config?format=download';
  };
  document.getElementById('dep-apply').onclick = applyConfig;
  document.getElementById('dep-preflight').onclick = showPreflight;
}

function renderSettings() {
  return `
    <div class="page-header">
      <div>
        <h2>设置</h2>
        <p>账号、备份与外观</p>
      </div>
    </div>
    <div class="grid grid-2">
      <div class="card">
        <h3>登录账号</h3>
        ${state.status?.forcePasswordChange ? '<div class="alert warn" style="margin-bottom:12px"><div>建议尽快修改初始密码</div></div>' : ''}
        <div class="form-row">
          <label>用户名</label>
          <input class="field" id="pw-user" value="${esc(state.status?.username || 'admin')}" />
        </div>
        <div class="form-row">
          <label>当前密码</label>
          <input class="field" type="password" id="pw-old" />
        </div>
        <div class="form-row">
          <label>新密码</label>
          <input class="field" type="password" id="pw-new" minlength="6" />
        </div>
        <button class="btn btn-primary" id="pw-save">更新</button>
      </div>
      <div class="card">
        <h3>备份</h3>
        <p class="muted small" style="margin-top:0">导出含密钥，请妥善保管。</p>
        <div class="btn-row">
          <button class="btn btn-ghost" id="exp-btn">导出 JSON</button>
          <label class="btn btn-ghost" style="cursor:pointer">
            导入
            <input type="file" id="imp-file" accept="application/json,.json" hidden />
          </label>
          <button class="btn btn-ghost" id="bak-list">备份列表</button>
        </div>
      </div>
      <div class="card">
        <h3>主题</h3>
        <div class="btn-row">
          <button class="btn btn-ghost" data-theme-set="auto">跟随系统</button>
          <button class="btn btn-ghost" data-theme-set="dark">深色</button>
          <button class="btn btn-ghost" data-theme-set="light">浅色</button>
        </div>
      </div>
      <div class="card">
        <h3>关于</h3>
        <p class="muted small" style="margin:0">WG Panel ${esc(state.status?.version ? 'v' + state.status.version : '')}</p>
        <p class="muted small"><a href="https://github.com/cheesydui-cloud/wg" target="_blank" rel="noreferrer">GitHub</a></p>
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
      toast(res.message || '已更新');
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
    if (!confirm('导入将覆盖当前配置，继续？')) return;
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
    <div class="page-header">
      <div>
        <h2>新手引导</h2>
        <p>4 步完成基础配置</p>
      </div>
    </div>
    <div class="steps">
      ${[1, 2, 3, 4].map((n) => `
        <span class="step-pill ${step === n ? 'active' : ''} ${step > n ? 'done' : ''}">
          ${n}. ${['公网', '密钥', '网段', '客户端'][n - 1]}
        </span>`).join('')}
    </div>
    <div class="card" style="max-width:520px">
      ${step === 1 ? `
        <h3>公网地址</h3>
        <div class="form-row">
          <label>IP 或域名</label>
          <div class="field-with-btn">
            <input class="field mono" id="w-host" placeholder="203.0.113.10" value="${esc((s.endpoint || '').split(':')[0] || '')}" />
            <button class="btn btn-ghost" type="button" id="w-detect-ip">探测</button>
          </div>
        </div>
        <div class="form-row">
          <label>端口</label>
          <input class="field" type="number" id="w-port" value="${esc(s.listenPort || 51820)}" />
        </div>` : ''}
      ${step === 2 ? `
        <h3>服务器密钥</h3>
        <div class="form-row">
          <label>公钥</label>
          <input class="field mono" readonly value="${esc(s.publicKey || '保存后生成')}" />
        </div>
        <p class="muted small">密钥仅保存在服务器 data 目录</p>` : ''}
      ${step === 3 ? `
        <h3>内网网段</h3>
        <div class="form-row">
          <label>服务器地址</label>
          <input class="field mono" id="w-address" value="${esc(s.address || '10.8.0.1/24')}" />
        </div>
        <div class="form-row">
          <label>DNS</label>
          <input class="field mono" id="w-dns" value="${esc(s.dns || '1.1.1.1')}" />
        </div>
        <label class="small" style="display:flex;align-items:center;gap:10px;font-weight:500">
          <label class="switch"><input type="checkbox" id="w-nat" checked /><span></span></label>
          启用 NAT
        </label>` : ''}
      ${step === 4 ? `
        <h3>第一个客户端</h3>
        <div class="form-row">
          <label>名称</label>
          <input class="field" id="w-cname" value="我的手机" />
        </div>
        <div class="form-row">
          <label>流量模式</label>
          <select class="select" id="w-allowed">
            <option value="0.0.0.0/0, ::/0">全局代理</option>
            <option value="NET_ONLY">仅内网</option>
          </select>
        </div>` : ''}
      <div class="actions-end">
        ${step > 1 ? '<button class="btn btn-ghost" id="w-prev">上一步</button>' : ''}
        ${step < 4
          ? '<button class="btn btn-primary" id="w-next">下一步</button>'
          : '<button class="btn btn-success" id="w-finish">完成</button>'}
        <button class="btn btn-ghost" id="w-skip">跳过</button>
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
        toast('已填入 ' + res.ip);
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
        const res = await api('/api/server', {
          method: 'PUT',
          body: { endpoint: `${host}:${port}`, listenPort: port },
        });
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
          res = await api('/api/server', {
            method: 'PUT',
            body: { postUp: nat.postUp, postDown: nat.postDown },
          });
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
      if (allowedIPs === 'NET_ONLY') {
        allowedIPs = networkFromAddress(state.server?.address || '10.8.0.1/24');
      }
      const created = await api('/api/clients', {
        method: 'POST',
        body: { name, allowedIPs, usePresharedKey: true },
      });
      await api('/api/server', { method: 'PUT', body: { wizardDone: true } });
      state.wizardDone = true;
      state._skipWizardOnce = true;
      state.page = 'clients';
      await refreshAndRender();
      toast('已创建客户端');
      if (created.client?.id) showClientQr(created.client.id);
    } catch (ex) { toast(ex.message, 'err'); }
  });
}

function openClientModal(client = null) {
  const isEdit = Boolean(client);
  const net = networkFromAddress(state.server?.address || '10.8.0.1/24');
  state.modal = {
    title: isEdit ? `编辑 ${client.name}` : '添加客户端',
    body: `
      <div class="form-row">
        <label>名称</label>
        <input class="field" id="c-name" value="${esc(client?.name || '')}" placeholder="我的手机" />
      </div>
      <div class="form-row">
        <label>内网 IP ${help('留空自动分配')}</label>
        <input class="field mono" id="c-address" value="${esc(client?.address || '')}" placeholder="自动分配" />
      </div>
      <div class="form-row">
        <label>AllowedIPs</label>
        <select class="select" id="c-allowed-preset">
          <option value="0.0.0.0/0, ::/0">全局代理</option>
          <option value="${esc(net)}">仅内网 ${esc(net)}</option>
          <option value="custom">自定义</option>
        </select>
      </div>
      <div class="form-row" id="c-allowed-wrap" style="display:none">
        <label>自定义</label>
        <input class="field mono" id="c-allowed" value="${esc(client?.allowedIPs || '')}" />
      </div>
      <div class="inline-fields">
        <div class="form-row">
          <label>Keepalive</label>
          <input class="field" type="number" id="c-ka" value="${esc(client?.persistentKeepalive ?? 25)}" />
        </div>
        <div class="form-row">
          <label>备注</label>
          <input class="field" id="c-note" value="${esc(client?.note || '')}" />
        </div>
      </div>
      ${isEdit ? `
        <div class="btn-row" style="margin-bottom:8px">
          <button class="btn btn-sm btn-ghost" id="c-regen">重置密钥</button>
          <button class="btn btn-sm btn-ghost" id="c-psk">重置 PSK</button>
        </div>` : `
        <label class="small" style="display:flex;align-items:center;gap:10px;font-weight:500;margin-bottom:8px">
          <label class="switch"><input type="checkbox" id="c-psk-on" checked /><span></span></label>
          使用 PSK
        </label>`}
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
        else {
          wrap.style.display = 'none';
          allowed.value = preset.value;
        }
      };
      if (client?.allowedIPs) {
        if (client.allowedIPs === '0.0.0.0/0, ::/0' || client.allowedIPs === '0.0.0.0/0') {
          preset.value = '0.0.0.0/0, ::/0';
        } else if (client.allowedIPs === net) {
          preset.value = net;
        } else {
          preset.value = 'custom';
          allowed.value = client.allowedIPs;
        }
      }
      applyPreset();
      preset.onchange = applyPreset;
      document.getElementById('c-cancel').onclick = closeModal;
      document.getElementById('c-save').onclick = async () => {
        const name = val('c-name') || (isEdit ? client.name : '客户端');
        const allowedIPs = preset.value === 'custom' ? val('c-allowed') : preset.value;
        const body = {
          name,
          address: val('c-address'),
          allowedIPs,
          persistentKeepalive: Number(val('c-ka')) || 0,
          note: val('c-note'),
        };
        try {
          if (isEdit) {
            await api(`/api/clients/${client.id}`, { method: 'PUT', body });
            toast('已保存');
            closeModal();
            await refreshAndRender();
          } else {
            body.usePresharedKey = document.getElementById('c-psk-on')?.checked !== false;
            const res = await api('/api/clients', { method: 'POST', body });
            toast('已创建');
            closeModal();
            await refreshAndRender();
            if (res.client?.id) showClientQr(res.client.id);
          }
        } catch (ex) { toast(ex.message, 'err'); }
      };
      document.getElementById('c-regen')?.addEventListener('click', async () => {
        if (!confirm('重置密钥后需重新导入配置，继续？')) return;
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
          <button class="btn btn-sm btn-ghost" id="modal-x">关闭</button>
        </div>
        ${modal.body}
      </div>
    </div>`;
  document.getElementById('modal-x').onclick = closeModal;
  document.getElementById('modal-bg').onclick = (e) => {
    if (e.target.id === 'modal-bg') closeModal();
  };
  modal.after?.();
}

async function showClientQr(id) {
  try {
    const data = await api(`/api/clients/${id}/config?format=qr`);
    state.modal = {
      title: data.name,
      body: `
        <div class="qr-wrap">
          <img src="${data.qr}" alt="QR" />
          <p class="muted small">WireGuard App 扫码添加</p>
        </div>
        <div class="btn-row" style="justify-content:center">
          <button class="btn btn-ghost" id="qr-copy">复制配置</button>
          <a class="btn btn-primary" href="/api/clients/${id}/config?format=download">下载</a>
        </div>
        <pre class="pre-box" style="margin-top:12px">${esc(data.config)}</pre>`,
      after() {
        document.getElementById('qr-copy').onclick = async () => {
          await navigator.clipboard.writeText(data.config);
          toast('已复制');
        };
      },
    };
    renderModal(state.modal);
  } catch (ex) { toast(ex.message, 'err'); }
}

async function showServerConfig() {
  try {
    const data = await api('/api/server/config');
    state.modal = {
      title: '服务端配置',
      body: `
        <p class="muted small" style="margin-top:0">${esc(data.path || '')}</p>
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
        <div class="alert ${pf.canApply ? 'ok' : 'warn'}" style="margin-bottom:12px">
          <div>${pf.canApply ? '可以应用到服务器' : '存在需要处理的问题'}</div>
        </div>
        <div class="table-wrap">
          <table style="min-width:0">
            <thead><tr><th>项目</th><th>结果</th><th>说明</th></tr></thead>
            <tbody>
              ${(pf.checks || []).map((c) => `
                <tr>
                  <td>${esc(c.title)}</td>
                  <td><span class="badge ${c.ok ? 'ok' : c.warn ? 'warn' : 'err'}">${c.ok ? '通过' : c.warn ? '警告' : '失败'}</span></td>
                  <td class="small muted">${esc(c.detail)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="actions-end">
          <button class="btn btn-ghost" id="pf-close">关闭</button>
          <button class="btn btn-success" id="pf-apply" ${pf.canApply ? '' : 'disabled'}>应用</button>
        </div>`,
      after() {
        document.getElementById('pf-close').onclick = closeModal;
        document.getElementById('pf-apply').onclick = () => {
          closeModal();
          applyConfig(true);
        };
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
      title: '配置备份',
      body: list.length
        ? `<div class="table-wrap"><table style="min-width:0">
            <thead><tr><th>文件</th><th>时间</th></tr></thead>
            <tbody>${list.map((b) => `
              <tr>
                <td class="mono small">${esc(b.name)}</td>
                <td class="small muted">${esc(fmtTime(b.mtime))}</td>
              </tr>`).join('')}</tbody>
          </table></div>
          <p class="muted small">应用配置前会自动备份到 data/backups</p>`
        : '<div class="empty"><div class="empty-title">暂无备份</div></div>',
    };
    renderModal(state.modal);
  } catch (ex) { toast(ex.message, 'err'); }
}

async function fillPublicIp(intoServerField = false) {
  try {
    toast('正在探测…', 'warn');
    const res = await api('/api/system/fill-endpoint', { method: 'POST', body: {} });
    if (intoServerField && document.getElementById('s-endpoint')) {
      document.getElementById('s-endpoint').value = res.endpoint;
    }
    state.server = res.server || state.server;
    state.dirty = Boolean(res.dirty);
    toast('Endpoint：' + res.endpoint);
    if (!intoServerField) render();
  } catch (ex) {
    toast(ex.message || '探测失败', 'err');
  }
}

async function exportAllClients() {
  try {
    const data = await api('/api/clients/export/zip-json');
    if (!data.files?.length) return toast('没有可导出的客户端', 'warn');
    for (const f of data.files) {
      const blob = new Blob([f.content], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = f.name;
      a.click();
      URL.revokeObjectURL(a.href);
      await new Promise((r) => setTimeout(r, 120));
    }
    toast(`已下载 ${data.files.length} 个配置`);
  } catch (ex) { toast(ex.message, 'err'); }
}

async function applyConfig(skipConfirm = false) {
  if (!skipConfirm && !confirm('写入服务器并启动/重载 WireGuard？')) return;
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
          <div class="alert warn"><div>${esc(msg)}</div></div>
          <div class="table-wrap"><table style="min-width:0">
            <thead><tr><th>项目</th><th>结果</th><th>说明</th></tr></thead>
            <tbody>${pf.checks.map((c) => `
              <tr>
                <td>${esc(c.title)}</td>
                <td><span class="badge ${c.ok ? 'ok' : c.warn ? 'warn' : 'err'}">${c.ok ? '通过' : c.warn ? '警告' : '失败'}</span></td>
                <td class="small muted">${esc(c.detail)}</td>
              </tr>`).join('')}</tbody>
          </table></div>
          ${ex.data?.config ? '<div class="btn-row" style="margin-top:12px"><a class="btn btn-primary" href="/api/server/config?format=download">下载配置</a></div>' : ''}`,
      };
      renderModal(state.modal);
    } else if (ex.data?.config) {
      state.modal = {
        title: '应用失败',
        body: `
          <div class="alert warn"><div>${esc(msg)}</div></div>
          <pre class="pre-box">${esc(ex.data.config)}</pre>
          <a class="btn btn-primary" href="/api/server/config?format=download">下载配置</a>`,
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
    renderBoot('无法连接面板：' + ex.message);
  }
}

boot();
