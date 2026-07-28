/**
 * 商家移动入口场景拓扑（v3）
 *
 * 手机 → 移动入口(211) / 外部(114)
 *      → 沪日 IX 172.16.2.79
 *      → TCP 转发 → 美国家宽 mita
 *      → 出网 家宽 IP
 *
 * 面板只管理，不在业务链上。
 */

const CM_DEFAULTS = {
  mobileIngress: '211.136.162.184',
  externalIngress: '114.111.176.37',
  ixLanIp: '172.16.2.79',
  ixSshPort: 7900,
  portMin: 7900,
  portMax: 7999,
  defaultPort: 7901,
  provinceHint: '河南省',
};

function defaultTopology() {
  return {
    profile: 'cm-ix-home', // 商家移动入口 → 沪日IX → 美国家宽
    ingress: {
      // 手机连接地址：优先移动入口（河南白名单友好）
      active: 'mobile', // mobile | external | custom
      mobileHost: CM_DEFAULTS.mobileIngress,
      externalHost: CM_DEFAULTS.externalIngress,
      customHost: '',
      port: CM_DEFAULTS.defaultPort,
      protocol: 'TCP',
      provinceWhitelist: CM_DEFAULTS.provinceHint,
      note: '商家移动入口有省份白名单；请用河南移动测，美国 VPS nc 超时不算失败',
    },
    ix: {
      name: '沪日IX',
      lanIp: CM_DEFAULTS.ixLanIp,
      sshPort: CM_DEFAULTS.ixSshPort,
      portMin: CM_DEFAULTS.portMin,
      portMax: CM_DEFAULTS.portMax,
      // 家宽对 IX 可达的地址（公网或隧道），用于生成转发命令
      homeReachableHost: '',
      homeReachablePort: CM_DEFAULTS.defaultPort,
      forwardConfigured: false,
      note: '商家入口流量先到本机内网，再转发到家宽 mita',
    },
    landing: {
      role: 'us-home', // us-home | ix-local
      name: '美国家宽',
      note: 'Agent + mita 装在这里；出网 IP 应为家宽',
    },
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

function ingressHostFrom(t) {
  const ing = t?.ingress || {};
  if (ing.active === 'external') return String(ing.externalHost || CM_DEFAULTS.externalIngress).trim();
  if (ing.active === 'custom') return String(ing.customHost || '').trim();
  return String(ing.mobileHost || CM_DEFAULTS.mobileIngress).trim();
}

function ensureTopology(state) {
  if (!state.topology || typeof state.topology !== 'object') {
    state.topology = defaultTopology();
  }
  const base = defaultTopology();
  const t = state.topology;
  t.profile = t.profile || base.profile;
  t.ingress = { ...base.ingress, ...(t.ingress || {}) };
  t.ix = { ...base.ix, ...(t.ix || {}) };
  t.landing = { ...base.landing, ...(t.landing || {}) };
  t.panel = { ...base.panel, ...(t.panel || {}) };

  t.ingress.port = clampPort(t.ingress.port, CM_DEFAULTS.defaultPort);
  t.ingress.protocol = String(t.ingress.protocol || 'TCP').toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
  if (!['mobile', 'external', 'custom'].includes(t.ingress.active)) t.ingress.active = 'mobile';
  t.ix.homeReachablePort = clampPort(t.ix.homeReachablePort, t.ingress.port);
  t.ix.sshPort = clampPort(t.ix.sshPort, 7900);

  // 同步到 server（兼容旧字段）；勿回调 activeEndpoint 以免递归
  if (!state.server) state.server = {};
  state.server.listenPort = clampPort(t.ingress.port, CM_DEFAULTS.defaultPort);
  state.server.protocol = t.ingress.protocol || state.server.protocol || 'TCP';
  const host = ingressHostFrom(t);
  state.server.endpoint = host ? `${host}:${t.ingress.port}` : '';

  return state.topology;
}

function activeIngressHost(state) {
  if (!state.topology) ensureTopology(state);
  return ingressHostFrom(state.topology);
}

function activeEndpoint(state) {
  if (!state.topology) ensureTopology(state);
  const host = ingressHostFrom(state.topology);
  const port = clampPort(state.topology.ingress.port, CM_DEFAULTS.defaultPort);
  if (!host) return '';
  return `${host}:${port}`;
}

function altEndpoint(state) {
  if (!state.topology) ensureTopology(state);
  const ing = state.topology.ingress;
  const port = clampPort(ing.port, CM_DEFAULTS.defaultPort);
  const mobile = `${ing.mobileHost || CM_DEFAULTS.mobileIngress}:${port}`;
  const external = `${ing.externalHost || CM_DEFAULTS.externalIngress}:${port}`;
  const host = ingressHostFrom(state.topology);
  return { mobile, external, active: host ? `${host}:${port}` : '' };
}

function portInMerchantRange(port) {
  const p = Number(port);
  return p >= CM_DEFAULTS.portMin && p <= CM_DEFAULTS.portMax;
}

/**
 * 在沪日 IX 上执行的 TCP 转发脚本（用户复制到 IX root 执行）
 * homeHost 必须是 IX 能访问到的家宽地址
 */
function buildIxForwardScript(state) {
  ensureTopology(state);
  const t = state.topology;
  const listenPort = clampPort(t.ingress.port, 7901);
  const homeHost = String(t.ix.homeReachableHost || '').trim();
  const homePort = clampPort(t.ix.homeReachablePort, listenPort);
  const lanIp = t.ix.lanIp || CM_DEFAULTS.ixLanIp;

  if (!homeHost) {
    return {
      ok: false,
      error: '请先填写「家宽对 IX 可达地址」（家宽公网 IP 或隧道地址）',
      script: '',
    };
  }

  const script = [
    '#!/usr/bin/env bash',
    '# 沪日 IX → 美国家宽 TCP 转发（商家移动入口场景）',
    `# 在 IX 本机 root 执行（内网 ${lanIp}）`,
    `# 手机连 211/114:${listenPort} → 本机 → ${homeHost}:${homePort}`,
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
    'echo " 手机连: 211.136.162.184:${LISTEN_PORT} （河南移动优先）"',
    'echo " 或: 114.111.176.37:${LISTEN_PORT}"',
    'echo " 美国 VPS nc 超时可忽略（省份白名单）"',
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
    tip: '在沪日 IX root 执行；成功后面板勾选「IX 转发已配置」',
  };
}

function publicTopology(state) {
  ensureTopology(state);
  const t = state.topology;
  const endpoints = altEndpoint(state);
  const fwd = buildIxForwardScript(state);
  return {
    profile: t.profile,
    pathLabel: '商家移动入口 → 沪日IX → 美国家宽 mita',
    ingress: { ...t.ingress },
    ix: { ...t.ix },
    landing: { ...t.landing },
    panel: { ...t.panel },
    activeEndpoint: endpoints.active,
    endpoints,
    portInRange: portInMerchantRange(t.ingress.port),
    merchantPortRange: `${CM_DEFAULTS.portMin}-${CM_DEFAULTS.portMax}`,
    defaults: { ...CM_DEFAULTS },
    forward: {
      ok: fwd.ok,
      error: fwd.error || '',
      hasScript: Boolean(fwd.script),
      homeHost: t.ix.homeReachableHost || '',
      configured: Boolean(t.ix.forwardConfigured),
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
  if (body.ix && typeof body.ix === 'object') {
    const x = body.ix;
    if (x.name !== undefined) t.ix.name = String(x.name || t.ix.name);
    if (x.lanIp !== undefined) t.ix.lanIp = String(x.lanIp || '').trim();
    if (x.sshPort !== undefined) t.ix.sshPort = clampPort(x.sshPort, 7900);
    if (x.homeReachableHost !== undefined) {
      t.ix.homeReachableHost = String(x.homeReachableHost || '').trim();
    }
    if (x.homeReachablePort !== undefined) {
      t.ix.homeReachablePort = clampPort(x.homeReachablePort, t.ingress.port);
    }
    if (x.forwardConfigured !== undefined) {
      t.ix.forwardConfigured = Boolean(x.forwardConfigured);
    }
  }
  if (body.landing && typeof body.landing === 'object') {
    if (body.landing.name !== undefined) t.landing.name = String(body.landing.name || '');
    if (body.landing.role !== undefined) t.landing.role = String(body.landing.role || 'us-home');
  }

  // 同步 server 字段
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
  const agentOnline = Boolean(opts.agentOnline);
  const report = opts.report || null;
  const port = t.ingress.port;
  const ep = activeEndpoint(state);

  push({
    id: 'topo_path',
    level: 'info',
    title: '拓扑路径',
    detail: '手机 → 商家移动入口(211/114) → 沪日IX → 美国家宽 mita → 出网',
  });

  push({
    id: 'panel_role',
    level: 'ok',
    title: '面板位置',
    detail: '独立 VPS 只管理，不在业务链上',
  });

  // 入站
  const inRange = portInMerchantRange(port);
  push({
    id: 'ingress',
    level: ep && inRange ? 'ok' : 'error',
    title: '商家入站（手机连接地址）',
    detail: ep
      ? `${ep} · 当前=${t.ingress.active} · 白名单=${t.ingress.provinceWhitelist || '—'}`
      : '未配置入站',
    fix: !ep
      ? '在拓扑页选择移动入口 211 或外部 114'
      : !inRange
        ? `端口须在商家段 ${CM_DEFAULTS.portMin}-${CM_DEFAULTS.portMax}（勿用 51820 等）`
        : '用河南移动测；美国 VPS nc 超时可忽略',
  });

  // IX
  const home = String(t.ix.homeReachableHost || '').trim();
  push({
    id: 'ix_role',
    level: home ? 'ok' : 'warn',
    title: '沪日 IX',
    detail: `内网 ${t.ix.lanIp} · SSH ${t.ix.sshPort} · 转发目标 ${home || '未填'}:${t.ix.homeReachablePort || port}`,
    fix: home
      ? t.ix.forwardConfigured
        ? ''
        : '在 IX 执行转发脚本后勾选「IX 转发已配置」'
      : '填写家宽对 IX 可达地址，并在 IX 上执行转发脚本',
  });

  push({
    id: 'ix_forward',
    level: t.ix.forwardConfigured && home ? 'ok' : 'error',
    title: 'IX → 家宽 TCP 转发',
    detail: t.ix.forwardConfigured
      ? `已标记配置 · :${port} → ${home}:${t.ix.homeReachablePort || port}`
      : '未配置：商家入口流量到不了家宽 mita',
    fix: t.ix.forwardConfigured
      ? ''
      : '拓扑页复制「IX 转发脚本」在沪日机 root 执行，再勾选已配置',
  });

  // 落地
  if (mode === 'agent') {
    push({
      id: 'landing_agent',
      level: agentOnline ? 'ok' : 'error',
      title: '美国家宽 Agent',
      detail: agentOnline
        ? `在线${opts.hostname ? ' · ' + opts.hostname : ''}`
        : '离线：无法安装/更新 mita',
      fix: agentOnline ? '' : '在家宽执行面板安装命令',
    });
  }

  const mita = report?.mita || {};
  const running = Boolean(mita.running) || /RUNNING/i.test(String(mita.status || ''));
  push({
    id: 'landing_mita',
    level: running ? 'ok' : 'error',
    title: '家宽 mita',
    detail: running
      ? `RUNNING${mita.listening ? ' · 端口在听' : ''}`
      : report
        ? `未运行（${mita.status || 'unknown'}）`
        : '尚无上报',
    fix: running ? '' : '点「一键落地」',
  });

  if (report?.exitPublicIp) {
    const egress = String(report.exitPublicIp).trim();
    const sameAsIngress =
      egress === t.ingress.mobileHost ||
      egress === t.ingress.externalHost ||
      (ep && egress === ep.split(':')[0]);
    push({
      id: 'egress',
      level: sameAsIngress ? 'warn' : 'ok',
      title: '出网 IP（只读）',
      detail: egress,
      fix: sameAsIngress
        ? '出网 IP 不应等于入站 IP；检查是否指错机器'
        : '手机连上后 ifconfig.me 应接近此 IP（家宽）',
    });
  }

  push({
    id: 'test_hint',
    level: 'info',
    title: '如何测通',
    detail: `河南移动手机连 ${ep || '211.x:7901'}；IX/家宽 tcpdump -ni any tcp port ${port}`,
  });

  const errors = items.filter((i) => i.level === 'error').length;
  const warns = items.filter((i) => i.level === 'warn').length;
  let summary = '拓扑检查通过';
  if (errors) summary = `拓扑有 ${errors} 项必须处理（常见：IX 未转发）`;
  else if (warns) summary = `拓扑有 ${warns} 个警告`;
  if (running && t.ix.forwardConfigured && ep) {
    summary = '链路配置齐全；请用河南移动手机测 mierus 连接';
  }

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
  ensureTopology,
  activeEndpoint,
  activeIngressHost,
  altEndpoint,
  portInMerchantRange,
  buildIxForwardScript,
  publicTopology,
  applyTopologyPatch,
  diagnoseTopology,
};
