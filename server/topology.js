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
    name: String(overrides.name || '沪日IX').trim().slice(0, 40) || '沪日IX',
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


/** 保证 landings[].id 唯一（旧数据可能全是 landing-default） */
function uniquifyLandingIds(t) {
  if (!t || !Array.isArray(t.landings)) return t;
  const seen = new Set();
  for (let i = 0; i < t.landings.length; i++) {
    const L = t.landings[i];
    if (!L) continue;
    let id = L.id || '';
    if (!id || seen.has(id)) {
      L.id = newId('landing');
    }
    seen.add(L.id);
  }
  return t;
}

function defaultLanding(overrides = {}) {
  const listenPort = clampPort(overrides.listenPort, CM_DEFAULTS.defaultPort);
  // 家宽 mita 端口默认跟本落地 listenPort（pro3=7902），不要写死 7901
  let homePort = overrides.homeReachablePort;
  if (homePort == null || homePort === '') homePort = listenPort;
  else if (Number(homePort) === 7901 && Number(listenPort) !== 7901) homePort = listenPort;
  return {
    // 多落地时禁止共用 landing-default，否则按 landing.id 解析会命中第一台
    id: overrides.id || newId('landing'),
    nodeId: overrides.nodeId || null,
    ixId: overrides.ixId || null,
    name: String(overrides.name || '落地家宽').trim().slice(0, 40) || '落地家宽',
    role: overrides.role || 'us-home',
    homeReachableHost: String(overrides.homeReachableHost || '').trim(),
    homeReachablePort: clampPort(homePort, listenPort),
    listenPort,
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

/** 同 IX 下为新落地分配未占用端口 */
function allocateListenPort(state, { ixId = null, preferred = null, excludeLandingId = null } = {}) {
  ensureTopology(state);
  const ix = getIx(state, ixId);
  const min = Number(ix?.portMin) || CM_DEFAULTS.portMin;
  const max = Number(ix?.portMax) || CM_DEFAULTS.portMax;
  const used = new Set();
  for (const L of state.topology.landings || []) {
    if (excludeLandingId && L.id === excludeLandingId) continue;
    if (ixId && L.ixId && L.ixId !== ixId) continue;
    const p = Number(L.listenPort);
    if (p) used.add(p);
  }
  for (const n of state.nodes || []) {
    const p = Number(n?.server?.listenPort);
    if (p) used.add(p);
  }
  const pref = Number(preferred);
  if (pref && pref >= min && pref <= max && !used.has(pref)) return pref;
  for (let p = min; p <= max; p++) {
    if (!used.has(p)) return p;
  }
  return clampPort(preferred, CM_DEFAULTS.defaultPort);
}

function landingsForIx(state, ixId) {
  ensureTopology(state);
  const list = state.topology.landings || [];
  if (!ixId) return list.slice();
  const bound = list.filter((L) => L.ixId === ixId);
  if (state.topology.ixes[0]?.id === ixId) {
    const unbound = list.filter((L) => !L.ixId);
    const ids = new Set(bound.map((L) => L.id));
    for (const L of unbound) if (!ids.has(L.id)) bound.push(L);
  }
  return bound;
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
  t.landings = (Array.isArray(t.landings) ? t.landings : []).map((L, i) => {
    const lp = clampPort(L.listenPort, t.ingress.port);
    let hp = L.homeReachablePort;
    if (hp == null || hp === '' || (Number(hp) === 7901 && Number(lp) !== 7901)) hp = lp;
    return defaultLanding({
      id: L.id || (i === 0 ? 'landing-default' : newId('landing')),
      ...L,
      listenPort: lp,
      homeReachablePort: hp,
      nodeId: L.nodeId || (i === 0 ? state.primaryNodeId || null : L.nodeId) || null,
      ixId: L.ixId || defIxId,
    });
  });
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

  uniquifyLandingIds(t);
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
  const lanIp = ix?.lanIp || CM_DEFAULTS.ixLanIp;
  const ixName = ix?.name || 'IX';
  const focusLanding = opts.landingId ? getLanding(state, opts.landingId) : null;

  // 同 IX 全部落地一起写规则，避免 nft 整表删除后只剩一条
  let targets = landingsForIx(state, ix?.id).map((L) => {
    const isFocus = focusLanding && L.id === focusLanding.id;
    const listenPort = clampPort(
      isFocus && opts.port ? opts.port : L.listenPort || state.topology.ingress.port,
      7901
    );
    const homeHost = String(
      (isFocus && opts.homeHost) || L.homeReachableHost || ix?.homeReachableHost || ''
    ).trim();
    let rawHomePort =
      (isFocus && opts.homePort) || L.homeReachablePort || L.listenPort || ix?.homeReachablePort;
    // 旧数据常把 homeReachablePort 留在 7901，而 pro3 listenPort=7902 → 会 DNAT 到错误端口
    if (
      !(isFocus && opts.homePort) &&
      Number(L.homeReachablePort) === 7901 &&
      Number(L.listenPort) &&
      Number(L.listenPort) !== 7901
    ) {
      rawHomePort = L.listenPort;
    }
    const homePort = clampPort(rawHomePort, listenPort);
    return {
      id: L.id,
      name: L.name || L.id,
      nodeId: L.nodeId,
      listenPort,
      homeHost,
      homePort,
    };
  });

  if (!targets.length && focusLanding) {
    const listenPort = clampPort(
      opts.port || focusLanding.listenPort || state.topology.ingress.port,
      7901
    );
    targets = [
      {
        id: focusLanding.id,
        name: focusLanding.name,
        nodeId: focusLanding.nodeId,
        listenPort,
        homeHost: String(
          opts.homeHost || focusLanding.homeReachableHost || ix?.homeReachableHost || ''
        ).trim(),
        homePort: clampPort(
          opts.homePort || focusLanding.homeReachablePort || focusLanding.listenPort,
          listenPort
        ),
      },
    ];
  }

  const ready = targets.filter((x) => x.homeHost);
  if (!ready.length) {
    return {
      ok: false,
      error: '请先填写各落地的「家宽对 IX 可达地址」（落地页展开保存）',
      script: '',
      ixId: ix?.id,
      landingId: focusLanding?.id,
      routes: targets,
    };
  }

  const portMap = new Map();
  const conflicts = [];
  for (const r of ready) {
    if (portMap.has(r.listenPort)) {
      conflicts.push(`端口 ${r.listenPort}: ${portMap.get(r.listenPort)} 与 ${r.name}`);
    } else {
      portMap.set(r.listenPort, r.name);
    }
  }

  const ext =
    (ix && getIxIngress(ix, state.topology.ingress).externalHost) || CM_DEFAULTS.externalIngress;
  const mob =
    (ix && getIxIngress(ix, state.topology.ingress).mobileHost) || CM_DEFAULTS.mobileIngress;

  const lines = [
    '#!/usr/bin/env bash',
    `# ${ixName} → 多落地 TCP 转发（商家 IX 前置 · v4.1）`,
    `# 在 IX 本机 root 执行（内网 ${lanIp}）`,
    '# 一次性写入本 IX 下全部已填可达地址的落地，避免只配一台时清掉其它端口',
    '#',
    '# 推荐整段执行：',
    "#   cat > /tmp/ix-forward.sh << 'SCRIPT_EOF'",
    '#   ...全文...',
    '#   SCRIPT_EOF',
    '#   chmod +x /tmp/ix-forward.sh && bash /tmp/ix-forward.sh',
    '#',
    'set -euo pipefail',
    '',
    'if [[ "$(id -u)" -ne 0 ]]; then echo "请使用 root"; exit 1; fi',
    '',
    'echo "==> 开启转发"',
    'sysctl -w net.ipv4.ip_forward=1 >/dev/null',
    'mkdir -p /etc/sysctl.d',
    "echo 'net.ipv4.ip_forward=1' >/etc/sysctl.d/99-mieru-ix-forward.conf",
    '',
  ];

  if (conflicts.length) {
    lines.push(`echo "!! 警告: 同 IX 落地端口冲突: ${conflicts.join('; ')}"`);
    lines.push('echo "   请在落地页把各落地改成不同端口（如 7901 / 7902）"');
    lines.push('');
  }

  lines.push('echo "==> 重建本 IX 转发表（含全部落地）"');
  lines.push('if command -v nft >/dev/null 2>&1; then');
  lines.push('  nft delete table ip mieru_ix_forward 2>/dev/null || true');
  lines.push('  nft add table ip mieru_ix_forward');
  lines.push(
    '  nft add chain ip mieru_ix_forward prerouting { type nat hook prerouting priority dstnat \\; policy accept \\; }'
  );
  lines.push(
    '  nft add chain ip mieru_ix_forward postrouting { type nat hook postrouting priority srcnat \\; policy accept \\; }'
  );
  lines.push(
    '  nft add chain ip mieru_ix_forward forward { type filter hook forward priority filter \\; policy accept \\; }'
  );

  for (const r of ready) {
    lines.push(`  # ${r.name}: :${r.listenPort} → ${r.homeHost}:${r.homePort}`);
    lines.push(
      `  nft add rule ip mieru_ix_forward prerouting tcp dport ${r.listenPort} dnat to ${r.homeHost}:${r.homePort}`
    );
    lines.push(
      `  nft add rule ip mieru_ix_forward postrouting ip daddr ${r.homeHost} tcp dport ${r.homePort} masquerade`
    );
    lines.push(
      `  nft add rule ip mieru_ix_forward forward tcp dport ${r.homePort} ip daddr ${r.homeHost} accept`
    );
    lines.push(
      `  nft add rule ip mieru_ix_forward forward tcp sport ${r.homePort} ip saddr ${r.homeHost} accept`
    );
  }
  lines.push(`  echo "    nft 已加载 ${ready.length} 条落地"`);
  lines.push('else');
  lines.push('  echo "    使用 iptables（按端口幂等添加）"');
  for (const r of ready) {
    lines.push(`  # ${r.name}`);
    lines.push(
      `  iptables -t nat -C PREROUTING -p tcp --dport ${r.listenPort} -j DNAT --to-destination ${r.homeHost}:${r.homePort} 2>/dev/null || iptables -t nat -A PREROUTING -p tcp --dport ${r.listenPort} -j DNAT --to-destination ${r.homeHost}:${r.homePort}`
    );
    lines.push(
      `  iptables -t nat -C POSTROUTING -p tcp -d ${r.homeHost} --dport ${r.homePort} -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -p tcp -d ${r.homeHost} --dport ${r.homePort} -j MASQUERADE`
    );
    lines.push(
      `  iptables -C FORWARD -p tcp -d ${r.homeHost} --dport ${r.homePort} -j ACCEPT 2>/dev/null || iptables -A FORWARD -p tcp -d ${r.homeHost} --dport ${r.homePort} -j ACCEPT`
    );
    lines.push(
      `  iptables -C FORWARD -p tcp -s ${r.homeHost} --sport ${r.homePort} -j ACCEPT 2>/dev/null || iptables -A FORWARD -p tcp -s ${r.homeHost} --sport ${r.homePort} -j ACCEPT`
    );
  }
  lines.push('fi');
  lines.push('');
  lines.push('echo "==> 探测 IX → 各落地"');
  for (const r of ready) {
    lines.push(`echo -n "  ${r.name} ${r.homeHost}:${r.homePort} ... "`);
    lines.push(
      `if timeout 5 bash -c "echo >/dev/tcp/${r.homeHost}/${r.homePort}" 2>/dev/null; then echo OK; else echo FAIL; fi`
    );
  }
  lines.push('');
  lines.push('echo "============================================"');
  for (const r of ready) {
    lines.push(
      `echo "  ${r.name}: 商家前置 :${r.listenPort} → ${r.homeHost}:${r.homePort}"`
    );
    lines.push(`echo "    客户端: ${ext}:${r.listenPort} 或 ${mob}:${r.listenPort}"`);
  }
  if (targets.some((x) => !x.homeHost)) {
    const miss = targets.filter((x) => !x.homeHost).map((x) => x.name).join(', ');
    lines.push(`echo "  未纳入（缺可达地址）: ${miss}"`);
  }
  lines.push('echo " 路径: 电脑 → 商家IX前置 → 本IX → 落地家宽 mita"');
  lines.push('echo "============================================"');
  lines.push('');

  const focus = focusLanding
    ? ready.find((r) => r.id === focusLanding.id) || ready[0]
    : ready[0];

  return {
    ok: true,
    script: lines.join('\n'),
    listenPort: focus?.listenPort,
    homeHost: focus?.homeHost,
    homePort: focus?.homePort,
    lanIp,
    ixId: ix?.id,
    landingId: focusLanding?.id || focus?.id,
    routes: ready,
    conflicts,
    tip:
      ready.length > 1
        ? `在 IX root 整段执行；将写入 ${ready.length} 条落地转发`
        : '在 IX root 整段执行；IX→家宽探测 OK 后面板勾选已配置',
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
    t.ixes = body.ixes.map((x, i) => {
      const nm = String(x.name != null ? x.name : '').trim();
      return defaultIx(
        {
          id: x.id || (i === 0 ? 'ix-default' : newId('ix')),
          ...x,
          name: nm || (i === 0 ? '沪日IX' : `IX-${i + 1}`),
        },
        t.ingress
      );
    });
    if (!t.ixes.length) t.ixes = [defaultIx({}, t.ingress)];
  } else if (body.ix && typeof body.ix === 'object') {
    // v3 single ix patch → first (or body.ixId target)
    const x = body.ix;
    let target = t.ixes[0] || defaultIx({}, t.ingress);
    if (body.ixId) {
      target = t.ixes.find((i) => i.id === body.ixId) || target;
    }
    if (x.name !== undefined) {
      const nm = String(x.name || '').trim();
      if (nm) target.name = nm.slice(0, 40);
    }
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
  // 多落地：逐条检查端口与可达地址，避免「默认 7901 绿了」掩盖 pro3:7902
  const routeHints = [];
  const hostByLanding = new Map();
  for (const L of t.landings) {
    const lp = Number(L.listenPort) || port;
    const hh = String(L.homeReachableHost || '').trim();
    hostByLanding.set(L.id, hh);
    routeHints.push(`${L.name || L.id}:商家前置:${lp}→${hh || '未填可达'}:${L.homeReachablePort || lp}`);
  }
  const missingHome = t.landings.filter((L) => !String(L.homeReachableHost || '').trim());
  const hosts = t.landings.map((L) => String(L.homeReachableHost || '').trim()).filter(Boolean);
  const sameHostAll =
    t.landings.length >= 2 && hosts.length >= 2 && new Set(hosts).size === 1;
  let fwdLevel = anyFwd && anyHome ? 'ok' : 'error';
  let fwdFix = anyFwd ? '' : '拓扑页复制「IX 转发脚本」在对应 IX root 整文件执行';
  let fwdDetail = anyFwd
    ? `已标记转发的 IX · 路由：${routeHints.join('；') || '无落地'}`
    : '未配置：商家前置流量到不了落地家宽 mita';
  if (anyFwd && missingHome.length) {
    fwdLevel = 'warn';
    fwdDetail += ` · 缺可达地址：${missingHome.map((L) => L.name).join('、')}`;
    fwdFix =
      '落地页展开每台落地填写「家宽可达地址」（pro3 必须是 pro3 自己的公网 IP，不要填成 NB.JP 的）→ 拓扑重新生成脚本并在 IX 执行';
  } else if (anyFwd && sameHostAll) {
    fwdLevel = 'warn';
    fwdDetail += ` · 多落地共用同一可达 IP ${hosts[0]}（若两台是不同家宽，pro3 会指错机）`;
    fwdFix =
      '确认 pro3 的「家宽可达地址」是 pro3 公网 IP；两台落地 IP 不同时不要都填 82.x。改完后重新生成并在 IX 执行转发脚本（须含 7901 与 7902）';
  }
  push({
    id: 'ix_forward',
    level: fwdLevel,
    title: 'IX → 落地家宽 TCP 转发（多端口）',
    detail: fwdDetail,
    fix: fwdFix,
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
          ? `Agent 在线${node?.hostname ? ' · ' + node.hostname : ''} · mita ${mita.status || '未知'} · 端口 ${L.listenPort} · IX可达 ${L.homeReachableHost || '未填'}`
          : L.nodeId
            ? 'Agent 离线'
            : '未绑定 Agent 节点',
        fix: online
          ? running
            ? L.homeReachableHost
              ? ''
              : '填写本落地「家宽可达地址」并重新生成 IX 转发'
            : '点「一键落地」'
          : '在落地页安装 Agent',
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

  const portList = [...new Set(t.landings.map((L) => Number(L.listenPort) || port))].join('/');
  push({
    id: 'test_hint',
    level: 'info',
    title: '如何测通',
    detail: `本机客户端：NB.JP 用 ${ep || '前置'}:${port}；其它落地用各自端口（当前 ${portList || port}）。IX: nft list table ip mieru_ix_forward；家宽: ss -lntp | grep -E '7901|7902'`,
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
  uniquifyLandingIds,
  ensureTopology,
  migrateLegacyTopology,
  activeEndpoint,
  activeIngressHost,
  altEndpoint,
  portInMerchantRange,
  buildIxForwardScript,
  allocateListenPort,
  landingsForIx,
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
