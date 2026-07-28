/**
 * 商家 IX 前置场景拓扑（v4）
 *
 * 电脑/客户端 → 商家 IX 前置入口(211 移动宽带 / 114 外部)
 *             → 指定 IX（可多台）
 *             → TCP 转发 → 指定落地家宽 mita
 *             → 出网 家宽 IP
 *
 * 面板只管理，不在业务链上。
 * 「移动入口」= 商家提供的移动宽带前置，不是手机。
 */

const crypto = require('crypto');

const CM_DEFAULTS = {
  mobileIngress: '211.136.162.184',
  externalIngress: '114.111.176.37',
  ixLanIp: '172.16.2.79',
  ixSshPort: 7900,
  portMin: 7900,
  portMax: 7999,
  defaultPort: 7901,
  provinceHint: '商家白名单省份（如有）',
};

function newId(prefix = 'id') {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

function defaultIxIngress(overrides = {}, globalIngress = null) {
  const g = globalIngress || {};
  return {
    active: ['mobile', 'external', 'custom'].includes(overrides.active)
      ? overrides.active
      : g.active || 'external',
    mobileHost: String(
      overrides.mobileHost != null ? overrides.mobileHost : g.mobileHost || CM_DEFAULTS.mobileIngress
    ).trim(),
    externalHost: String(
      overrides.externalHost != null
        ? overrides.externalHost
        : g.externalHost || CM_DEFAULTS.externalIngress
    ).trim(),
    customHost: String(
      overrides.customHost != null ? overrides.customHost : g.customHost || ''
    ).trim(),
    provinceWhitelist: String(
      overrides.provinceWhitelist != null
        ? overrides.provinceWhitelist
        : g.provinceWhitelist || CM_DEFAULTS.provinceHint
    ),
  };
}

function defaultIx(overrides = {}, globalIngress = null) {
  const ingSrc = overrides.ingress && typeof overrides.ingress === 'object' ? overrides.ingress : overrides;
  return {
    id: overrides.id || 'ix-default',
    name: overrides.name || '沪日IX',
    lanIp: overrides.lanIp || CM_DEFAULTS.ixLanIp,
    sshPort: clampPort(overrides.sshPort, CM_DEFAULTS.ixSshPort),
    portMin: Number(overrides.portMin) || CM_DEFAULTS.portMin,
    portMax: Number(overrides.portMax) || CM_DEFAULTS.portMax,
    homeReachableHost: String(overrides.homeReachableHost || '').trim(),
    homeReachablePort: clampPort(overrides.homeReachablePort, CM_DEFAULTS.defaultPort),
    forwardConfigured: Boolean(overrides.forwardConfigured),
    note: overrides.note || '商家前置流量先到本机内网，再 TCP 转发到落地家宽 mita',
    ingress: defaultIxIngress(ingSrc, globalIngress),
  };
}

function defaultLanding(overrides = {}) {
  return {
    id: overrides.id || 'landing-default',
    nodeId: overrides.nodeId || null,
    ixId: overrides.ixId || null,
    name: overrides.name || '落地家宽',
    role: overrides.role || 'us-home',
    homeReachableHost: String(overrides.homeReachableHost || '').trim(),
    homeReachablePort: clampPort(overrides.homeReachablePort, CM_DEFAULTS.defaultPort),
    listenPort: clampPort(overrides.listenPort, CM_DEFAULTS.defaultPort),
    note: overrides.note || 'Agent + mita 装在这里；出网 IP 应为家宽',
  };
}

function defaultTopology() {
  return {
    profile: 'cm-ix-home',
    ingress: {
      active: 'external',
      mobileHost: CM_DEFAULTS.mobileIngress,
      externalHost: CM_DEFAULTS.externalIngress,
      customHost: '',
      port: CM_DEFAULTS.defaultPort,
      protocol: 'TCP',
      provinceWhitelist: CM_DEFAULTS.provinceHint,
      note: '商家 IX 前置入口；电脑连这里。美国无关 VPS nc 超时可能因白名单，不算落地失败',
    },
    // v4 multi
    ixes: [defaultIx()],
    landings: [defaultLanding()],
    // v3 compat mirrors (kept in sync by ensureTopology)
    ix: defaultIx(),
    landing: defaultLanding({ id: undefined }),
    panel: {
      role: 'control-only',
      note: '面板装独立 VPS，不跑业务流量',
    },
  };
}

function clampPort(p, fallback = 7901) {
  const n = Number(p);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return fallback;
  return n;
}

function ingressHostFrom(ingOrTopo, activeOverride) {
  // accept either ingress object or full topology
  const ing = ingOrTopo?.ingress && !ingOrTopo.mobileHost ? ingOrTopo.ingress : ingOrTopo || {};
  const active = activeOverride || ing.active;
  if (active === 'external') return String(ing.externalHost || CM_DEFAULTS.externalIngress).trim();
  if (active === 'custom') return String(ing.customHost || '').trim();
  return String(ing.mobileHost || CM_DEFAULTS.mobileIngress).trim();
}

function getIxIngress(ix, globalIngress = null) {
  if (ix?.ingress && typeof ix.ingress === 'object') {
    return defaultIxIngress(ix.ingress, globalIngress);
  }
  return defaultIxIngress({}, globalIngress);
}

/** Resolve IX for client/landing/opts */
function resolveIx(state, opts = {}) {
  ensureTopology(state);
  if (opts.ixId) {
    const found = state.topology.ixes.find((x) => x.id === opts.ixId);
    if (found) return found;
  }
  if (opts.landingId) {
    const L = state.topology.landings.find((x) => x.id === opts.landingId);
    if (L?.ixId) {
      const found = state.topology.ixes.find((x) => x.id === L.ixId);
      if (found) return found;
    }
  }
  if (opts.landingNodeId) {
    const L = state.topology.landings.find((x) => x.nodeId === opts.landingNodeId);
    if (L?.ixId) {
      const found = state.topology.ixes.find((x) => x.id === L.ixId);
      if (found) return found;
    }
  }
  return state.topology.ixes[0] || null;
}

function resolveIngress(state, opts = {}) {
  ensureTopology(state);
  const ix = resolveIx(state, opts);
  const g = state.topology.ingress;
  if (ix) return getIxIngress(ix, g);
  return {
    active: g.active || 'external',
    mobileHost: g.mobileHost || CM_DEFAULTS.mobileIngress,
    externalHost: g.externalHost || CM_DEFAULTS.externalIngress,
    customHost: g.customHost || '',
    provinceWhitelist: g.provinceWhitelist || CM_DEFAULTS.provinceHint,
  };
}

function mirrorGlobalFromIx(state, ix) {
  if (!state.topology || !ix) return;
  const ing = getIxIngress(ix, state.topology.ingress);
  state.topology.ingress = {
    ...state.topology.ingress,
    active: ing.active,
    mobileHost: ing.mobileHost,
    externalHost: ing.externalHost,
    customHost: ing.customHost,
    provinceWhitelist: ing.provinceWhitelist,
  };
}

function migrateLegacyTopology(t) {
  if (!t || typeof t !== 'object') return defaultTopology();
  const base = defaultTopology();
  const out = {
    ...base,
    ...t,
    ingress: { ...base.ingress, ...(t.ingress || {}) },
    panel: { ...base.panel, ...(t.panel || {}) },
  };

  // ixes — each gets own ingress (copy from global if missing)
  const gIng = out.ingress;
  if (Array.isArray(t.ixes) && t.ixes.length) {
    out.ixes = t.ixes.map((x, i) =>
      defaultIx(
        {
          id: x.id || (i === 0 ? 'ix-default' : newId('ix')),
          ...x,
        },
        gIng
      )
    );
  } else if (t.ix && typeof t.ix === 'object') {
    out.ixes = [
      defaultIx(
        {
          id: 'ix-default',
          ...t.ix,
          ingress: t.ix.ingress || gIng,
        },
        gIng
      ),
    ];
  } else {
    out.ixes = [defaultIx({}, gIng)];
  }

  // landings
  const defIxId = out.ixes[0]?.id || null;
  if (Array.isArray(t.landings) && t.landings.length) {
    out.landings = t.landings.map((L, i) =>
      defaultLanding({
        id: L.id || (i === 0 ? 'landing-default' : newId('landing')),
        ...L,
        ixId: L.ixId || defIxId,
      })
    );
  } else if (t.landing && typeof t.landing === 'object') {
    out.landings = [
      defaultLanding({
        id: 'landing-default',
        name: t.landing.name,
        role: t.landing.role,
        note: t.landing.note,
        homeReachableHost: t.ix?.homeReachableHost || '',
        homeReachablePort: t.ix?.homeReachablePort || out.ingress.port,
        listenPort: out.ingress.port,
        ixId: defIxId,
      }),
    ];
  } else {
    out.landings = [defaultLanding({ ixId: defIxId })];
  }

  return out;
}

function ensureTopology(state) {
  if (!state.topology || typeof state.topology !== 'object') {
    state.topology = defaultTopology();
  } else {
    // ensure multi arrays exist (v3 → v4)
    const t = state.topology;
    if (!Array.isArray(t.ixes) || !t.ixes.length || !Array.isArray(t.landings) || !t.landings.length) {
      state.topology = migrateLegacyTopology(t);
    }
  }

  const base = defaultTopology();
  const t = state.topology;
  t.profile = t.profile || base.profile;
  t.ingress = { ...base.ingress, ...(t.ingress || {}) };
  t.panel = { ...base.panel, ...(t.panel || {}) };

  t.ingress.port = clampPort(t.ingress.port, CM_DEFAULTS.defaultPort);
  t.ingress.protocol = String(t.ingress.protocol || 'TCP').toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
  if (!['mobile', 'external', 'custom'].includes(t.ingress.active)) t.ingress.active = 'external';

  t.ixes = (Array.isArray(t.ixes) ? t.ixes : []).map((x, i) =>
    defaultIx(
      {
        id: x.id || (i === 0 ? 'ix-default' : newId('ix')),
        ...x,
        homeReachablePort: clampPort(x.homeReachablePort, t.ingress.port),
        sshPort: clampPort(x.sshPort, 7900),
      },
      t.ingress
    )
  );
  if (!t.ixes.length) t.ixes = [defaultIx({}, t.ingress)];

  // mirror global ingress from first IX (compat + default path)
  if (t.ixes[0]) {
    const fi = getIxIngress(t.ixes[0], t.ingress);
    t.ingress = {
      ...t.ingress,
      active: fi.active,
      mobileHost: fi.mobileHost,
      externalHost: fi.externalHost,
      customHost: fi.customHost,
      provinceWhitelist: fi.provinceWhitelist,
    };
  }

  const defIxId = t.ixes[0]?.id || null;
  t.landings = (Array.isArray(t.landings) ? t.landings : []).map((L, i) =>
    defaultLanding({
      id: L.id || (i === 0 ? 'landing-default' : newId('landing')),
      ...L,
      homeReachablePort: clampPort(L.homeReachablePort, t.ingress.port),
      listenPort: clampPort(L.listenPort, t.ingress.port),
      nodeId: L.nodeId || (i === 0 ? state.primaryNodeId || null : L.nodeId) || null,
      ixId: L.ixId || defIxId,
    })
  );
  if (!t.landings.length) {
    t.landings = [
      defaultLanding({
        nodeId: state.primaryNodeId || null,
        listenPort: t.ingress.port,
        ixId: defIxId,
      }),
    ];
  }

  // bind default landing to primary if empty
  if (state.primaryNodeId) {
    const def = t.landings[0];
    if (def && !def.nodeId) def.nodeId = state.primaryNodeId;
  }

  // v3 compat mirrors = first ix / first landing
  t.ix = { ...t.ixes[0] };
  t.landing = {
    role: t.landings[0].role,
    name: t.landings[0].name,
    note: t.landings[0].note,
  };

  // sync global server endpoint (default path = first IX)
  if (!state.server) state.server = {};
  state.server.listenPort = clampPort(t.ingress.port, CM_DEFAULTS.defaultPort);
  state.server.protocol = t.ingress.protocol || state.server.protocol || 'TCP';
  const host = ingressHostFrom(t.ingress);
  state.server.endpoint = host ? `${host}:${t.ingress.port}` : '';

  return state.topology;
}

function getIx(state, ixId) {
  ensureTopology(state);
  if (ixId) {
    const found = state.topology.ixes.find((x) => x.id === ixId);
    if (found) return found;
  }
  return state.topology.ixes[0] || null;
}

function getLanding(state, landingId) {
  ensureTopology(state);
  if (landingId) {
    const found = state.topology.landings.find((L) => L.id === landingId);
    if (found) return found;
  }
  return state.topology.landings[0] || null;
}

function getLandingByNodeId(state, nodeId) {
  ensureTopology(state);
  if (!nodeId) return null;
  return state.topology.landings.find((L) => L.nodeId === nodeId) || null;
}

function activeIngressHost(state, activeOverride, opts = {}) {
  if (!state.topology) ensureTopology(state);
  const resolveOpts = typeof activeOverride === 'object' && activeOverride !== null
    ? activeOverride
    : opts;
  const active =
    typeof activeOverride === 'string' ? activeOverride : resolveOpts.ingressActive;
  const ing = resolveIngress(state, resolveOpts);
  return ingressHostFrom(ing, active);
}

function activeEndpoint(state, opts = {}) {
  if (!state.topology) ensureTopology(state);
  const ing = resolveIngress(state, opts);
  const host = ingressHostFrom(ing, opts.ingressActive);
  const port = clampPort(opts.port || state.topology.ingress.port, CM_DEFAULTS.defaultPort);
  if (!host) return '';
  return `${host}:${port}`;
}

/** opts: { port, ixId, landingId, landingNodeId, ingressActive } */
function altEndpoint(state, portOverride, opts = {}) {
  if (!state.topology) ensureTopology(state);
  const o = typeof portOverride === 'object' && portOverride !== null ? portOverride : opts;
  const port = clampPort(
    (typeof portOverride === 'number' || typeof portOverride === 'string'
      ? portOverride
      : o.port) || state.topology.ingress.port,
    CM_DEFAULTS.defaultPort
  );
  const ing = resolveIngress(state, o);
  const mobile = `${ing.mobileHost || CM_DEFAULTS.mobileIngress}:${port}`;
  const external = `${ing.externalHost || CM_DEFAULTS.externalIngress}:${port}`;
  const host = ingressHostFrom(ing, o.ingressActive);
  return {
    mobile,
    external,
    active: host ? `${host}:${port}` : '',
    ingress: { ...ing },
    ixId: resolveIx(state, o)?.id || null,
  };
}

function portInMerchantRange(port, ixOrMin = null, max = null) {
  const p = Number(port);
  let min = CM_DEFAULTS.portMin;
  let mx = CM_DEFAULTS.portMax;
  if (ixOrMin && typeof ixOrMin === 'object') {
    min = Number(ixOrMin.portMin) || min;
    mx = Number(ixOrMin.portMax) || mx;
  } else if (ixOrMin != null) {
    min = Number(ixOrMin) || min;
    if (max != null) mx = Number(max) || mx;
  }
  return p >= min && p <= mx;
}

/**
 * 在 IX 上执行的 TCP 转发脚本
 * opts: { ixId, landingId, port }
 */
function buildIxForwardScript(state, opts = {}) {
  ensureTopology(state);
  const ix = getIx(state, opts.ixId);
  const landing = getLanding(state, opts.landingId);
  const listenPort = clampPort(opts.port || state.topology.ingress.port || landing?.listenPort, 7901);
  const homeHost = String(
    opts.homeHost || landing?.homeReachableHost || ix?.homeReachableHost || ''
  ).trim();
  const homePort = clampPort(
    opts.homePort || landing?.homeReachablePort || landing?.listenPort || ix?.homeReachablePort,
    listenPort
  );
  const lanIp = ix?.lanIp || CM_DEFAULTS.ixLanIp;
  const ixName = ix?.name || 'IX';

  if (!homeHost) {
    return {
      ok: false,
      error: '请先填写「家宽对 IX 可达地址」（落地页或 IX 配置）',
      script: '',
      ixId: ix?.id,
      landingId: landing?.id,
    };
  }

  const script = [
    '#!/usr/bin/env bash',
    `# ${ixName} → 落地家宽 TCP 转发（商家 IX 前置 · v4）`,
    `# 在 IX 本机 root 执行（内网 ${lanIp}）`,
    `# 电脑 → 商家前置 114/211:${listenPort} → 本机 DNAT → ${homeHost}:${homePort} mita`,
    '#',
    '# 推荐整段执行（不要一行行粘贴到交互 shell）：',
    "#   cat > /tmp/ix-forward.sh << 'SCRIPT_EOF'",
    '#   ...粘贴本文件全文...',
    '#   SCRIPT_EOF',
    '#   chmod +x /tmp/ix-forward.sh && bash /tmp/ix-forward.sh',
    '#',
    '# 成功后在 IX 上应能：',
    `#   timeout 5 bash -c 'echo >/dev/tcp/${homeHost}/${homePort}' && echo OK`,
    '# 家宽须 mita RUNNING 且监听端口；客户端仍连商家前置，勿连家宽公网 IP。',
    'set -euo pipefail',
    `HOME_HOST=${JSON.stringify(homeHost)}`,
    `HOME_PORT=${homePort}`,
    `LISTEN_PORT=${listenPort}`,
    '',
    'if [[ "$(id -u)" -ne 0 ]]; then echo "请使用 root"; exit 1; fi',
    '',
    'echo "==> 开启转发"',
    'sysctl -w net.ipv4.ip_forward=1 >/dev/null',
    'mkdir -p /etc/sysctl.d',
    "echo 'net.ipv4.ip_forward=1' >/etc/sysctl.d/99-mieru-ix-forward.conf",
    '',
    'echo "==> 检测本机 ${LISTEN_PORT} 是否被占用"',
    'if ss -lntp 2>/dev/null | grep -q ":${LISTEN_PORT} "; then',
    '  echo "!! 警告: 本机 ${LISTEN_PORT} 已有进程在听（mita 请先 stop）"',
    '  ss -lntp | grep ":${LISTEN_PORT} " || true',
    'fi',
    '',
    'echo "==> 配置 DNAT 转发"',
    'if command -v nft >/dev/null 2>&1; then',
    '  nft delete table ip mieru_ix_forward 2>/dev/null || true',
    '  nft add table ip mieru_ix_forward',
    '  nft add chain ip mieru_ix_forward prerouting { type nat hook prerouting priority dstnat \\; policy accept \\; }',
    '  nft add chain ip mieru_ix_forward postrouting { type nat hook postrouting priority srcnat \\; policy accept \\; }',
    '  nft add chain ip mieru_ix_forward forward { type filter hook forward priority filter \\; policy accept \\; }',
    '  nft add rule ip mieru_ix_forward prerouting tcp dport ${LISTEN_PORT} dnat to ${HOME_HOST}:${HOME_PORT}',
    '  nft add rule ip mieru_ix_forward postrouting ip daddr ${HOME_HOST} tcp dport ${HOME_PORT} masquerade',
    '  nft add rule ip mieru_ix_forward forward tcp dport ${HOME_PORT} ip daddr ${HOME_HOST} accept',
    '  nft add rule ip mieru_ix_forward forward tcp sport ${HOME_PORT} ip saddr ${HOME_HOST} accept',
    '  echo "    nft 规则已加载"',
    'else',
    '  iptables -t nat -C PREROUTING -p tcp --dport "${LISTEN_PORT}" -j DNAT --to-destination "${HOME_HOST}:${HOME_PORT}" 2>/dev/null \\',
    '    || iptables -t nat -A PREROUTING -p tcp --dport "${LISTEN_PORT}" -j DNAT --to-destination "${HOME_HOST}:${HOME_PORT}"',
    '  iptables -t nat -C POSTROUTING -p tcp -d "${HOME_HOST}" --dport "${HOME_PORT}" -j MASQUERADE 2>/dev/null \\',
    '    || iptables -t nat -A POSTROUTING -p tcp -d "${HOME_HOST}" --dport "${HOME_PORT}" -j MASQUERADE',
    '  iptables -C FORWARD -p tcp -d "${HOME_HOST}" --dport "${HOME_PORT}" -j ACCEPT 2>/dev/null \\',
    '    || iptables -A FORWARD -p tcp -d "${HOME_HOST}" --dport "${HOME_PORT}" -j ACCEPT',
    '  iptables -C FORWARD -p tcp -s "${HOME_HOST}" --sport "${HOME_PORT}" -j ACCEPT 2>/dev/null \\',
    '    || iptables -A FORWARD -p tcp -s "${HOME_HOST}" --sport "${HOME_PORT}" -j ACCEPT',
    '  echo "    iptables 规则已加载"',
    'fi',
    '',
    'echo "==> 探测 IX → 家宽 ${HOME_HOST}:${HOME_PORT}"',
    'if timeout 5 bash -c "echo >/dev/tcp/${HOME_HOST}/${HOME_PORT}" 2>/dev/null; then',
    '  echo "    TCP 可达"',
    'else',
    '  echo "    !! 探测失败：IX 访问不到家宽，请检查家宽公网/防火墙/mita"',
    'fi',
    '',
    'echo "============================================"',
    'echo " 转发: :${LISTEN_PORT} → ${HOME_HOST}:${HOME_PORT}"',
    `echo " 客户端连本 IX 商家前置: ${JSON.stringify(
      (ix && getIxIngress(ix, state.topology.ingress).externalHost) || CM_DEFAULTS.externalIngress
    )}:\${LISTEN_PORT} 或 ${JSON.stringify(
      (ix && getIxIngress(ix, state.topology.ingress).mobileHost) || CM_DEFAULTS.mobileIngress
    )}:\${LISTEN_PORT}"`,
    'echo " 路径: 电脑 → 商家IX前置 → 本IX → 落地家宽 mita"',
    'echo "============================================"',
    '',
  ].join('\n');

  return {
    ok: true,
    script,
    listenPort,
    homeHost,
    homePort,
    lanIp,
    ixId: ix?.id,
    landingId: landing?.id,
    tip: '在 IX root 整段执行；IX→家宽探测 OK 后面板勾选已配置',
  };
}

function publicTopology(state) {
  ensureTopology(state);
  const t = state.topology;
  const endpoints = altEndpoint(state);
  const fwd = buildIxForwardScript(state);
  const anyForward = t.ixes.some((x) => x.forwardConfigured);
  const firstIx = t.ixes[0];
  return {
    profile: t.profile,
    pathLabel: '电脑/客户端 → 商家IX前置 → IX → 落地家宽 mita',
    ingress: { ...t.ingress },
    ixes: t.ixes.map((x) => ({
      ...x,
      ingress: getIxIngress(x, t.ingress),
      endpoints: altEndpoint(state, t.ingress.port, { ixId: x.id }),
      merchantPortRange: `${x.portMin || CM_DEFAULTS.portMin}-${x.portMax || CM_DEFAULTS.portMax}`,
    })),
    landings: t.landings.map((L) => ({ ...L })),
    // v3 compat
    ix: { ...t.ixes[0] },
    landing: {
      role: t.landings[0]?.role,
      name: t.landings[0]?.name,
      note: t.landings[0]?.note,
    },
    panel: { ...t.panel },
    activeEndpoint: endpoints.active,
    endpoints,
    portInRange: portInMerchantRange(t.ingress.port, firstIx),
    merchantPortRange: firstIx
      ? `${firstIx.portMin}-${firstIx.portMax}`
      : `${CM_DEFAULTS.portMin}-${CM_DEFAULTS.portMax}`,
    defaults: { ...CM_DEFAULTS },
    forward: {
      ok: fwd.ok,
      error: fwd.error || '',
      hasScript: Boolean(fwd.script),
      homeHost: t.landings[0]?.homeReachableHost || t.ixes[0]?.homeReachableHost || '',
      configured: anyForward || Boolean(t.ixes[0]?.forwardConfigured),
    },
  };
}

function applyTopologyPatch(state, body = {}) {
  ensureTopology(state);
  const t = state.topology;
  const prevEndpoint = activeEndpoint(state);

  if (body.ingress && typeof body.ingress === 'object') {
    const i = body.ingress;
    if (i.active !== undefined) t.ingress.active = i.active;
    if (i.mobileHost !== undefined) t.ingress.mobileHost = String(i.mobileHost || '').trim();
    if (i.externalHost !== undefined) t.ingress.externalHost = String(i.externalHost || '').trim();
    if (i.customHost !== undefined) t.ingress.customHost = String(i.customHost || '').trim();
    if (i.port !== undefined) t.ingress.port = clampPort(i.port, t.ingress.port);
    if (i.protocol !== undefined) {
      t.ingress.protocol = String(i.protocol).toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
    }
    if (i.provinceWhitelist !== undefined) {
      t.ingress.provinceWhitelist = String(i.provinceWhitelist || '');
    }
  }

  // full replace lists if provided
  if (Array.isArray(body.ixes)) {
    t.ixes = body.ixes.map((x, i) =>
      defaultIx(
        {
          id: x.id || (i === 0 ? 'ix-default' : newId('ix')),
          ...x,
        },
        t.ingress
      )
    );
    if (!t.ixes.length) t.ixes = [defaultIx({}, t.ingress)];
  } else if (body.ix && typeof body.ix === 'object') {
    // v3 single ix patch → first (or body.ixId target)
    const x = body.ix;
    let target = t.ixes[0] || defaultIx({}, t.ingress);
    if (body.ixId) {
      target = t.ixes.find((i) => i.id === body.ixId) || target;
    }
    if (x.name !== undefined) target.name = String(x.name || target.name);
    if (x.lanIp !== undefined) target.lanIp = String(x.lanIp || '').trim();
    if (x.sshPort !== undefined) target.sshPort = clampPort(x.sshPort, 7900);
    if (x.portMin !== undefined) target.portMin = Number(x.portMin) || target.portMin;
    if (x.portMax !== undefined) target.portMax = Number(x.portMax) || target.portMax;
    if (x.homeReachableHost !== undefined) {
      target.homeReachableHost = String(x.homeReachableHost || '').trim();
    }
    if (x.homeReachablePort !== undefined) {
      target.homeReachablePort = clampPort(x.homeReachablePort, t.ingress.port);
    }
    if (x.forwardConfigured !== undefined) {
      target.forwardConfigured = Boolean(x.forwardConfigured);
    }
    if (x.note !== undefined) target.note = String(x.note || '');
    if (x.ingress && typeof x.ingress === 'object') {
      target.ingress = defaultIxIngress(x.ingress, target.ingress || t.ingress);
    }
    const idx = t.ixes.findIndex((i) => i.id === target.id);
    const normalized = defaultIx(target, t.ingress);
    if (idx >= 0) t.ixes[idx] = normalized;
    else t.ixes[0] = normalized;
    // mirror home to default landing if landing empty
    if (target.homeReachableHost && t.landings[0] && !t.landings[0].homeReachableHost) {
      t.landings[0].homeReachableHost = target.homeReachableHost;
      t.landings[0].homeReachablePort = target.homeReachablePort;
    }
  }

  // body.ingress alone: also write onto first IX (or body.ixId) so per-IX stays source of truth
  if (body.ingress && typeof body.ingress === 'object' && !Array.isArray(body.ixes) && !body.ix) {
    const targetId = body.ixId || t.ixes[0]?.id;
    const target = t.ixes.find((i) => i.id === targetId) || t.ixes[0];
    if (target) {
      target.ingress = defaultIxIngress(
        {
          ...(target.ingress || {}),
          active: body.ingress.active !== undefined ? body.ingress.active : target.ingress?.active,
          mobileHost:
            body.ingress.mobileHost !== undefined
              ? body.ingress.mobileHost
              : target.ingress?.mobileHost,
          externalHost:
            body.ingress.externalHost !== undefined
              ? body.ingress.externalHost
              : target.ingress?.externalHost,
          customHost:
            body.ingress.customHost !== undefined
              ? body.ingress.customHost
              : target.ingress?.customHost,
          provinceWhitelist:
            body.ingress.provinceWhitelist !== undefined
              ? body.ingress.provinceWhitelist
              : target.ingress?.provinceWhitelist,
        },
        t.ingress
      );
    }
  }

  if (Array.isArray(body.landings)) {
    t.landings = body.landings.map((L, i) =>
      defaultLanding({
        id: L.id || (i === 0 ? 'landing-default' : newId('landing')),
        ...L,
      })
    );
    if (!t.landings.length) t.landings = [defaultLanding({ nodeId: state.primaryNodeId })];
  } else if (body.landing && typeof body.landing === 'object') {
    const L = body.landing;
    const target = t.landings[0] || defaultLanding();
    if (L.name !== undefined) target.name = String(L.name || '');
    if (L.role !== undefined) target.role = String(L.role || 'us-home');
    if (L.note !== undefined) target.note = String(L.note || '');
    if (L.nodeId !== undefined) target.nodeId = L.nodeId || null;
    if (L.ixId !== undefined) target.ixId = L.ixId || null;
    if (L.homeReachableHost !== undefined) {
      target.homeReachableHost = String(L.homeReachableHost || '').trim();
    }
    if (L.homeReachablePort !== undefined) {
      target.homeReachablePort = clampPort(L.homeReachablePort, t.ingress.port);
    }
    if (L.listenPort !== undefined) target.listenPort = clampPort(L.listenPort, t.ingress.port);
    t.landings[0] = defaultLanding(target);
  }

  // single ix mark forward
  if (body.ixId && body.forwardConfigured !== undefined) {
    const ix = t.ixes.find((x) => x.id === body.ixId);
    if (ix) ix.forwardConfigured = Boolean(body.forwardConfigured);
  }

  ensureTopology(state);

  state.server.listenPort = t.ingress.port;
  state.server.protocol = t.ingress.protocol;
  state.server.endpoint = activeEndpoint(state);

  const endpointChanged = prevEndpoint !== state.server.endpoint;
  return { endpointChanged, topology: publicTopology(state) };
}

function diagnoseTopology(state, opts = {}) {
  ensureTopology(state);
  const items = [];
  const push = (item) => items.push(item);
  const t = state.topology;
  const mode = opts.mode || state.mode || 'local';
  const port = t.ingress.port;
  const ep = activeEndpoint(state);
  const nodesList = opts.nodes || [];

  push({
    id: 'topo_path',
    level: 'info',
    title: '拓扑路径',
    detail: '电脑/客户端 → 商家IX前置(211/114) → IX → 落地家宽 mita → 出网',
  });

  push({
    id: 'panel_role',
    level: 'ok',
    title: '面板位置',
    detail: '独立 VPS 只管理，不在业务链上',
  });

  const inRange = portInMerchantRange(port);
  push({
    id: 'ingress',
    level: ep && inRange ? 'ok' : 'error',
    title: '商家 IX 前置入口（客户端连接地址）',
    detail: ep
      ? `${ep} · 当前=${t.ingress.active} · ${t.ingress.provinceWhitelist || '—'}`
      : '未配置前置入口',
    fix: !ep
      ? '在拓扑页选择外部 114 或移动宽带前置 211'
      : !inRange
        ? `端口须在商家段 ${CM_DEFAULTS.portMin}-${CM_DEFAULTS.portMax}`
        : '用你本机经商家前置测；无关 VPS nc 超时可忽略',
  });

  for (const ix of t.ixes) {
    const ing = getIxIngress(ix, t.ingress);
    const home =
      t.landings.find((L) => L.ixId === ix.id && L.homeReachableHost)?.homeReachableHost ||
      t.landings.find((L) => L.homeReachableHost)?.homeReachableHost ||
      ix.homeReachableHost ||
      '';
    const rangeOk = portInMerchantRange(port, ix);
    push({
      id: `ix_${ix.id}`,
      level: home || ix.forwardConfigured ? 'ok' : 'warn',
      title: `IX · ${ix.name}`,
      detail: `内网 ${ix.lanIp} · 端口段 ${ix.portMin}-${ix.portMax} · 前置 114=${ing.externalHost} / 211=${ing.mobileHost}${
        ing.customHost ? ` / 自定义=${ing.customHost}` : ''
      } · 转发${ix.forwardConfigured ? '已标记' : '未标记'} · 可达 ${home || '未填'}`,
      fix: ix.forwardConfigured
        ? rangeOk
          ? ''
          : `默认端口 ${port} 不在本 IX 段 ${ix.portMin}-${ix.portMax}`
        : '在 IX 执行转发脚本后勾选「已配置」',
    });
  }

  const anyFwd = t.ixes.some((x) => x.forwardConfigured);
  const anyHome = t.landings.some((L) => L.homeReachableHost) || t.ixes.some((x) => x.homeReachableHost);
  push({
    id: 'ix_forward',
    level: anyFwd && anyHome ? 'ok' : 'error',
    title: 'IX → 落地家宽 TCP 转发',
    detail: anyFwd
      ? `至少一台 IX 已标记转发 · 默认 :${port}`
      : '未配置：商家前置流量到不了落地家宽 mita',
    fix: anyFwd ? '' : '拓扑页复制「IX 转发脚本」在对应 IX root 整文件执行',
  });

  if (mode === 'agent') {
    for (const L of t.landings) {
      const node = nodesList.find((n) => n.id === L.nodeId) || null;
      const online = Boolean(node?.online);
      const report = node?.lastReport || null;
      const mita = report?.mita || {};
      const running = Boolean(mita.running) || /RUNNING/i.test(String(mita.status || ''));
      push({
        id: `landing_${L.id}`,
        level: online && running ? 'ok' : online ? 'warn' : 'error',
        title: `落地 · ${L.name}`,
        detail: online
          ? `Agent 在线${node?.hostname ? ' · ' + node.hostname : ''} · mita ${mita.status || '未知'} · 端口 ${L.listenPort}`
          : L.nodeId
            ? 'Agent 离线'
            : '未绑定 Agent 节点',
        fix: online ? (running ? '' : '点「一键落地」') : '在落地页安装 Agent',
      });
      if (report?.exitPublicIp) {
        push({
          id: `egress_${L.id}`,
          level: 'ok',
          title: `出网 IP · ${L.name}`,
          detail: String(report.exitPublicIp),
        });
      }
    }

    // legacy single primary fallback if landings empty of nodes
    if (!t.landings.some((L) => L.nodeId) && opts.agentOnline !== undefined) {
      push({
        id: 'landing_agent',
        level: opts.agentOnline ? 'ok' : 'error',
        title: '落地家宽 Agent',
        detail: opts.agentOnline
          ? `在线${opts.hostname ? ' · ' + opts.hostname : ''}`
          : '离线：无法安装/更新 mita',
        fix: opts.agentOnline ? '' : '在落地家宽执行面板安装命令',
      });
      const mita = opts.report?.mita || {};
      const running = Boolean(mita.running) || /RUNNING/i.test(String(mita.status || ''));
      push({
        id: 'landing_mita',
        level: running ? 'ok' : 'error',
        title: '落地家宽 mita',
        detail: running
          ? `RUNNING${mita.listening ? ' · 端口在听' : ''}`
          : opts.report
            ? `未运行（${mita.status || 'unknown'}）`
            : '尚无上报',
        fix: running ? '' : '点「一键落地」',
      });
    }
  }

  push({
    id: 'test_hint',
    level: 'info',
    title: '如何测通',
    detail: `本机客户端连商家前置 ${ep || '114.x:7901'}；IX/家宽 tcpdump -ni any tcp port ${port}`,
  });

  const errors = items.filter((i) => i.level === 'error').length;
  const warns = items.filter((i) => i.level === 'warn').length;
  let summary = '拓扑检查通过';
  if (errors) summary = `拓扑有 ${errors} 项必须处理（常见：IX 未转发 / 落地离线）`;
  else if (warns) summary = `拓扑有 ${warns} 个警告`;
  if (anyFwd && ep) summary = '链路配置齐全；用本机客户端连商家 IX 前置测 mierus';

  return {
    ok: errors === 0,
    summary,
    items,
    activeEndpoint: ep,
    profile: t.profile,
  };
}

module.exports = {
  CM_DEFAULTS,
  defaultTopology,
  defaultIx,
  defaultIxIngress,
  defaultLanding,
  ensureTopology,
  migrateLegacyTopology,
  activeEndpoint,
  activeIngressHost,
  altEndpoint,
  portInMerchantRange,
  buildIxForwardScript,
  publicTopology,
  applyTopologyPatch,
  diagnoseTopology,
  getIx,
  getLanding,
  getLandingByNodeId,
  getIxIngress,
  resolveIx,
  resolveIngress,
  mirrorGlobalFromIx,
  clampPort,
  newId,
};
