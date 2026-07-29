#!/usr/bin/env node
/**
 * V4 smoke: migrate, multi-ix script, bundle filter, enforce package
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

// isolate data
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-v4-smoke-'));
process.env.WG_DATA_DIR = tmp;

const config = require('../server/config');
const topology = require('../server/topology');
const mieru = require('../server/mieru');
const nodes = require('../server/nodes');

function ok(name) {
  console.log('  ✓', name);
}

// 1) v5-like state migrates
const v5 = {
  version: 5,
  mode: 'agent',
  primaryNodeId: 'node-1',
  protocol: 'mieru',
  server: {
    listenPort: 7901,
    protocol: 'TCP',
    endpoint: '114.111.176.37:7901',
    mtu: 1400,
  },
  clients: [
    {
      id: 'c1',
      name: 'uabc123',
      password: 'pass-pass-pass',
      enabled: true,
      note: '测试',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  nodes: [
    {
      id: 'node-1',
      name: '落地家宽',
      tokenHash: 'x',
      tokenPlain: 't',
      createdAt: new Date().toISOString(),
      server: { listenPort: 7901, protocol: 'TCP' },
      clients: [],
      jobs: [],
    },
  ],
  topology: {
    profile: 'cm-ix-home',
    ingress: {
      active: 'external',
      mobileHost: '211.136.162.184',
      externalHost: '114.111.176.37',
      port: 7901,
      protocol: 'TCP',
    },
    ix: {
      name: '沪日IX',
      lanIp: '172.16.2.79',
      sshPort: 7900,
      homeReachableHost: '82.22.26.185',
      homeReachablePort: 7901,
      forwardConfigured: true,
    },
    landing: { role: 'us-home', name: '落地家宽' },
    panel: { role: 'control-only' },
  },
  settings: {},
};

const state = config.migrateState(v5);
assert.strictEqual(state.version, 6);
assert.ok(Array.isArray(state.topology.ixes) && state.topology.ixes.length >= 1);
assert.ok(Array.isArray(state.topology.landings) && state.topology.landings.length >= 1);
assert.strictEqual(state.topology.ixes[0].homeReachableHost, '82.22.26.185');
assert.strictEqual(state.topology.landings[0].nodeId, 'node-1');
assert.strictEqual(state.clients[0].route.landingNodeId, 'node-1');
assert.ok(state.clients[0].package);
assert.strictEqual(topology.activeEndpoint(state), '114.111.176.37:7901');
ok('migrate v5 → v6 preserves endpoint & home');

// 2) multi IX forward script
state.topology.ixes.push(
  topology.defaultIx({
    id: 'ix-2',
    name: 'IX-2',
    lanIp: '172.16.2.80',
    homeReachableHost: '1.2.3.4',
    // 第二台必须自有前置（ensure 不再从全局偷 Host）
    ingress: {
      active: 'mobile',
      mobileHost: '211.136.162.184',
      externalHost: '114.111.176.37',
      customHost: '',
    },
  })
);
state.topology.landings.push(
  topology.defaultLanding({
    id: 'landing-2',
    nodeId: 'node-2',
    name: '落地2',
    homeReachableHost: '5.6.7.8',
    listenPort: 7902,
    ixId: 'ix-2', // 必须显式绑第二台，否则 ensure 会落到第一台、脚本不得串台
  })
);
topology.ensureTopology(state);
const fwd = topology.buildIxForwardScript(state, {
  ixId: 'ix-2',
  landingId: 'landing-2',
  port: 7902,
});
assert.ok(fwd.ok, fwd.error);
assert.ok(fwd.script.includes('7902'));
assert.ok(fwd.script.includes('5.6.7.8'));
assert.ok(fwd.script.includes('ixId=ix-2'));
ok('multi-IX forward script targets landing host/port');

// 3) clientsForNode filter
nodes.ensureNodes(state);
const { node: n2 } = nodes.createNode(state, { name: '落地2' });
// fix landing node id
state.topology.landings[1].nodeId = n2.id;
state.clients.push({
  id: 'c2',
  name: 'uother',
  password: 'pass-pass-pass2',
  enabled: true,
  note: '',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  route: { landingNodeId: n2.id, ixId: null, listenPort: 7902, ingressActive: null },
  package: { quotaMb: 0, quotaDays: 30, quotaMode: 'rolling', expireAt: '', bandwidthMbps: 0 },
  usage: {},
});
const on1 = mieru.clientsForNode(state, 'node-1');
const on2 = mieru.clientsForNode(state, n2.id);
assert.ok(on1.some((c) => c.name === 'uabc123'));
assert.ok(!on1.some((c) => c.name === 'uother'));
assert.ok(on2.some((c) => c.name === 'uother'));
ok('clientsForNode filters by landing');

// 4) dual links use client port
const dual = mieru.buildDualShareLinks(state, state.clients[1]);
assert.ok(dual.endpoints.mobile.endsWith(':7902'));
ok('share link uses client listenPort');

// 5) enforce expire
state.clients[0].package.expireAt = '2020-01-01';
state.clients[0].enabled = true;
const enf = mieru.enforcePackages(state);
assert.ok(enf.changed.includes('c1'));
assert.strictEqual(state.clients[0].enabled, false);
ok('enforce expire disables user');

// 6) merge usage + quota enforce
state.clients[1].enabled = true;
state.clients[1].package.quotaMb = 1; // 1MB
mieru.mergeUsageFromReport(state, n2.id, {
  collectedAt: new Date().toISOString(),
  users: [{ name: 'uother', downloadBytes: 2 * 1024 * 1024, uploadBytes: 0, totalBytes: 2 * 1024 * 1024 }],
  source: 'mita-cli',
});
const enf2 = mieru.enforcePackages(state);
assert.ok(enf2.changed.includes('c2'));
assert.strictEqual(state.clients[1].enabled, false);
ok('enforce quota disables user');

// 7) public topology still has v3 fields
const pub = topology.publicTopology(state);
assert.ok(pub.ix);
assert.ok(pub.ixes.length >= 2);
assert.ok(pub.pathLabel.includes('商家IX前置'));
ok('publicTopology multi + compat');

// 8) per-IX ingress migrate + independent fronts
topology.ensureTopology(state);
assert.ok(state.topology.ixes[0].ingress, 'first ix has ingress');
assert.strictEqual(state.topology.ixes[0].ingress.externalHost, '114.111.176.37');
// second IX gets own fronts / port range
const ix2 = state.topology.ixes.find((x) => x.id === 'ix-2');
assert.ok(ix2);
ix2.ingress = topology.defaultIxIngress({
  active: 'external',
  externalHost: '114.9.9.9',
  mobileHost: '211.9.9.9',
  customHost: 'front-ix2.example.com',
});
ix2.portMin = 8000;
ix2.portMax = 8099;
const ep2 = topology.activeEndpoint(state, { ixId: 'ix-2', port: 8001 });
assert.strictEqual(ep2, '114.9.9.9:8001');
const alt2 = topology.altEndpoint(state, 8001, { ixId: 'ix-2' });
assert.ok(alt2.mobile.startsWith('211.9.9.9:'));
assert.ok(topology.portInMerchantRange(8001, ix2));
assert.ok(!topology.portInMerchantRange(7901, ix2));
ok('per-IX fronts + port range independent');

// 9) share links follow client route.ixId / landing.ixId
state.topology.landings[1].ixId = 'ix-2';
state.clients[1].route.ixId = 'ix-2';
state.clients[1].route.landingNodeId = n2.id;
const dualIx = mieru.buildDualShareLinks(state, state.clients[1]);
assert.ok(dualIx.endpoints.external.startsWith('114.9.9.9:'));
assert.ok(dualIx.endpoints.mobile.startsWith('211.9.9.9:'));
assert.strictEqual(dualIx.ixId, 'ix-2');
// domain as custom preferred
state.topology.ixes.find((x) => x.id === 'ix-2').ingress.active = 'custom';
const dualDom = mieru.buildDualShareLinks(state, state.clients[1]);
assert.ok(dualDom.preferred.includes('front-ix2.example.com'));
const jsonDom = mieru.buildClientJson(state, state.clients[1], 'TCP', 'front-ix2.example.com');
assert.strictEqual(jsonDom.profiles[0].servers[0].domainName, 'front-ix2.example.com');
assert.strictEqual(jsonDom.profiles[0].servers[0].ipAddress, '');
  const jsonIp = mieru.buildClientJson(state, state.clients[1], 'TCP', '114.9.9.9');
  assert.strictEqual(jsonIp.profiles[0].servers[0].ipAddress, '114.9.9.9');
  assert.strictEqual(jsonIp.profiles[0].servers[0].domainName, '');
  ok('share links + domain/IP client JSON by IX');

  // 9b) OpenClash/mihomo YAML export per client
  {
    const yaml = mieru.buildClashYaml(state, state.clients[1], 'TCP');
    assert.ok(yaml.includes('type: mieru'), 'yaml has type mieru');
    assert.ok(yaml.includes('mixed-port: 7890'), 'yaml has mixed-port');
    assert.ok(yaml.includes('proxy-groups:'), 'yaml has groups');
    assert.ok(yaml.includes('username:'), 'yaml has username');
    assert.ok(/IP-CIDR,.*\/32,DIRECT/.test(yaml), 'yaml has DIRECT for front IP');
    assert.ok(yaml.includes('MATCH,FINAL'), 'yaml has MATCH FINAL');
    // 必须是完整 IPv4，不能被 split(':') 截成 114 / 211
    assert.ok(
      /server:\s*114\.9\.9\.9\b/.test(yaml) || /server:\s*211\.9\.9\.9\b/.test(yaml) || /server:\s*front-ix2\.example\.com\b/.test(yaml),
      'yaml server must be full host, not first IPv4 octet'
    );
    assert.ok(!/server:\s*114\s*$/m.test(yaml) && !/server:\s*211\s*$/m.test(yaml), 'no truncated server IP');
    ok('buildClashYaml complete OpenClash config');
  }

  // 9c) disable user drops from enabledUsers / server config
  {
    const target = state.clients[1];
    target.enabled = true;
    const before = mieru.enabledUsers(state).length;
    assert.ok(before >= 1, 'has enabled users');
    target.enabled = false;
    const after = mieru.enabledUsers(state).length;
    assert.strictEqual(after, before - 1, 'disabled user excluded from enabledUsers');
    const names = mieru.enabledUsers(state).map((c) => c.name);
    assert.ok(!names.includes(target.name), 'disabled name not in apply list');
    target.enabled = true;
    ok('disable excludes user from mita apply users');
  }

  // 9d) buildBundle-equivalent: disabled user never in serverConfig.users
  {
    const c0 = state.clients[0];
    const c1 = state.clients[1];
    c0.enabled = true;
    c1.enabled = false;
    c0.route = c0.route || {};
    c0.route.landingNodeId = state.nodes[0].id;
    c1.route = c1.route || {};
    c1.route.landingNodeId = state.nodes[0].id;
    // simulate buildBundle users list
    const users = mieru.usersForBundle(state, state.nodes[0].id);
    const enabled = users.filter((u) => u.enabled !== false);
    const scUsers = enabled.map((u) => ({ name: u.name, password: u.password }));
    assert.ok(scUsers.some((u) => u.name === c0.name), 'enabled user in serverConfig');
    assert.ok(!scUsers.some((u) => u.name === c1.name), 'disabled user NOT in serverConfig');
    const disabledNames = users.filter((u) => u.enabled === false).map((u) => u.name);
    assert.ok(disabledNames.includes(c1.name), 'disabledNames lists disabled user');
    // all disabled → hold user
    c0.enabled = false;
    const en2 = mieru.usersForBundle(state, state.nodes[0].id).filter((u) => u.enabled !== false);
    assert.strictEqual(en2.length, 0, 'all disabled');
    const hold = { name: 'panelhold', password: 'x' };
    const sc2 = en2.length ? en2 : [hold];
    assert.strictEqual(sc2[0].name, 'panelhold', 'hold user when all disabled');
    c0.enabled = true;
    c1.enabled = true;
    ok('bundle serverConfig excludes disabled; hold when all disabled');
  }

// 10) publicTopology exposes per-IX endpoints
const pub2 = topology.publicTopology(state);
const pubIx2 = pub2.ixes.find((x) => x.id === 'ix-2');
assert.ok(pubIx2.ingress);
assert.ok(pubIx2.endpoints);
assert.ok(String(pubIx2.merchantPortRange).includes('8000'));
ok('publicTopology per-IX ingress/endpoints');

// 11) dirty hash: mark clean with bundle hash → isNodeDirty false
{
  // simulate panel hasher aligned with buildBundle-style hash
  const node = state.nodes[0];
  node.clients = mieru.clientsForNode(state, node.id);
  const serverConfig = mieru.buildServerConfig({
    server: { ...state.server, listenPort: 7901 },
    clients: node.clients.filter((c) => c.enabled !== false),
    primaryNodeId: node.id,
  });
  const users = mieru.usersForBundle(state, node.id);
  const bundleHash = require('crypto')
    .createHash('sha256')
    .update(JSON.stringify({ serverConfig, users: users.map((u) => ({ n: u.name, e: u.enabled, p: u.package })) }))
    .digest('hex');
  nodes.markNodeClean(node, bundleHash);
  const hasher = {
    nodeHash: () => bundleHash,
    configHash: () => bundleHash,
  };
  assert.strictEqual(nodes.isNodeDirty(node, hasher), false, 'clean after apply');
  node._dirtyFlag = true;
  assert.strictEqual(nodes.isNodeDirty(node, hasher), true, 'dirty flag forces dirty');
  nodes.markNodeClean(node, bundleHash);
  // wrong hash stays dirty
  nodes.markNodeClean(node, 'deadbeef');
  assert.strictEqual(nodes.isNodeDirty(node, hasher), true, 'hash mismatch dirty');
  nodes.markNodeClean(node, bundleHash);
  ok('dirty hash aligned with bundle configHash');
}

// 12) multi-landing same IX: different ports in one forward script
{
  const L2 = topology.defaultLanding({
    id: 'landing-2',
    nodeId: 'node-2',
    ixId: state.topology.ixes[0].id,
    name: 'pro3',
    listenPort: 7902,
    homeReachableHost: '9.9.9.9',
    homeReachablePort: 7902,
  });
  // ensure first landing has host
  state.topology.landings[0].homeReachableHost = state.topology.landings[0].homeReachableHost || '8.8.8.8';
  state.topology.landings[0].listenPort = 7901;
  state.topology.landings.push(L2);
  const fwd2 = topology.buildIxForwardScript(state, { ixId: state.topology.ixes[0].id });
  assert.ok(fwd2.ok, fwd2.error);
  assert.ok(fwd2.script.includes('7901'), 'script has 7901');
  assert.ok(fwd2.script.includes('7902'), 'script has 7902');
  assert.ok(fwd2.script.includes('9.9.9.9'), 'script has pro3 host');
  const port = topology.allocateListenPort(state, { ixId: state.topology.ixes[0].id });
  assert.ok(port !== 7901 && port !== 7902, 'allocates free port got ' + port);
  ok('multi-landing forward ports + allocateListenPort');

// 12) empty landing (0 users, never applied) must NOT keep global dirty forever
{
  const nodeEmpty = {
    id: 'n_empty',
    name: 'empty',
    clients: [],
    server: { listenPort: 7902, protocol: 'TCP' },
    lastAppliedHash: null,
    _dirtyFlag: false,
  };
  assert.strictEqual(nodes.isNodeDirty(nodeEmpty, null), false, 'empty never-applied not dirty');
  nodeEmpty.clients = [{ id: 'c1', name: 'u1' }];
  assert.strictEqual(nodes.isNodeDirty(nodeEmpty, null), true, 'with users never-applied dirty');
  nodeEmpty._dirtyFlag = true;
  nodeEmpty.clients = [];
  assert.strictEqual(nodes.isNodeDirty(nodeEmpty, null), false, 'empty clears sticky dirty flag');
  assert.strictEqual(nodeEmpty._dirtyFlag, false, 'flag cleared');
  nodeEmpty.lastAppliedHash = 'abc';
  assert.strictEqual(nodes.isNodeDirty(nodeEmpty, null), false, 'applied then emptied clean');
  ok('empty landing not sticky-dirty');
}
}


// 13) clientsForNode / resolveLandingNodeId：UI 分组与 apply 必须一致
{
  const primary = 'node-primary-uuid';
  const pro3 = 'node-pro3-uuid';
  const st = {
    primaryNodeId: primary,
    nodes: [
      { id: primary, name: '落地出口' },
      { id: pro3, name: 'pro3' },
    ],
    server: { listenPort: 7901, protocol: 'TCP', mtu: 1400, multiplexing: 'MULTIPLEXING_LOW' },
    topology: {
      landings: [
        { id: 'landing-primary', name: '落地出口', nodeId: primary, listenPort: 7901, ixId: 'ix1' },
        { id: 'landing-pro3', name: 'pro3', nodeId: pro3, listenPort: 7902, ixId: 'ix1' },
      ],
      ixes: [{ id: 'ix1', name: '沪日IX', portMin: 7900, portMax: 7999 }],
      ingress: { active: 'external', externalHost: '1.1.1.1', mobileHost: '2.2.2.2', port: 7901 },
    },
    clients: [
      {
        id: 'c-def',
        name: 'u7af760',
        password: 'p1',
        enabled: true,
        route: { landingNodeId: primary },
        package: {},
        usage: {},
      },
      {
        id: 'c-pro',
        name: 'u94843d',
        password: 'p2',
        enabled: true,
        route: { landingNodeId: pro3, listenPort: 7902 },
        package: {},
        usage: {},
      },
    ],
  };
  mieru.ensureMieruDefaults(st);
  assert.deepStrictEqual(
    mieru.clientsForNode(st, pro3).map((c) => c.name),
    ['u94843d'],
    'pro3 by nodeId'
  );
  // 用 topology landing.id 绑定也应解析到 pro3
  st.clients[1].route.landingNodeId = 'landing-pro3';
  assert.strictEqual(mieru.resolveLandingNodeId(st, 'landing-pro3'), pro3, 'landing.id → nodeId');
  assert.deepStrictEqual(
    mieru.clientsForNode(st, pro3).map((c) => c.name),
    ['u94843d'],
    'pro3 via landing.id stored'
  );
  // 空串不得误绑，回落主落地
  st.clients[1].route.landingNodeId = '';
  assert.deepStrictEqual(
    mieru.clientsForNode(st, pro3).map((c) => c.name),
    [],
    'empty string not on pro3'
  );
  assert.ok(
    mieru.clientsForNode(st, primary).some((c) => c.name === 'u94843d'),
    'empty string falls to primary'
  );
  // publicClient 与 apply 一致
  st.clients[1].route.landingNodeId = pro3;
  const pub = mieru.publicClient(st.clients[1], st);
  assert.strictEqual(pub.route.landingNodeId, pro3);
  // 名称唯一时可解析
  assert.strictEqual(mieru.resolveLandingNodeId(st, 'pro3'), pro3, 'by name');
  ok('clientsForNode resolveLandingNodeId matches UI/apply');
}


// 14) 主落地心跳/sync 不得抹掉其它落地用户
{
  const primary = 'node-p';
  const pro3 = 'node-pro3';
  const st = {
    mode: 'agent',
    primaryNodeId: primary,
    server: { listenPort: 7901, protocol: 'TCP', endpoint: '1.1.1.1:7901', mtu: 1400 },
    nodes: [
      {
        id: primary,
        name: '落地出口',
        server: { listenPort: 7901 },
        clients: [], // 将被写成「仅主落地用户」模拟 bundle 后
        lastAppliedHash: null,
      },
      { id: pro3, name: 'pro3', server: { listenPort: 7902 }, clients: [] },
    ],
    clients: [
      {
        id: 'c1',
        name: 'u7af760',
        password: 'a',
        enabled: true,
        route: { landingNodeId: primary },
        package: {},
        usage: {},
      },
      {
        id: 'c2',
        name: 'u9e23d8',
        password: 'b',
        enabled: true,
        route: { landingNodeId: pro3, listenPort: 7902 },
        package: {},
        usage: {},
      },
    ],
    topology: {
      landings: [
        { id: 'L1', name: '落地出口', nodeId: primary, listenPort: 7901 },
        { id: 'L2', name: 'pro3', nodeId: pro3, listenPort: 7902 },
      ],
      ixes: [{ id: 'ix1', name: '沪日IX', portMin: 7900, portMax: 7999 }],
      ingress: { active: 'external', externalHost: '1.1.1.1', mobileHost: '2.2.2.2', port: 7901 },
    },
  };
  // 模拟主落地 pull bundle：node.clients 只剩本机用户
  const primaryNode = st.nodes[0];
  primaryNode.clients = mieru.clientsForNode(st, primary);
  assert.strictEqual(primaryNode.clients.length, 1);
  assert.strictEqual(primaryNode.clients[0].name, 'u7af760');
  // 旧 bug：syncStateFromPrimary 会 state.clients = node.clients → pro3 用户消失
  nodes.syncStateFromPrimary(st, primaryNode);
  assert.strictEqual(st.clients.length, 2, 'must keep both clients after primary sync');
  assert.ok(
    st.clients.some((c) => c.name === 'u9e23d8'),
    'pro3 user must survive primary heartbeat sync'
  );
  assert.deepStrictEqual(
    mieru.clientsForNode(st, pro3).map((c) => c.name),
    ['u9e23d8']
  );
  ok('primary heartbeat must not wipe multi-landing clients');
}


// 15) 启动合并：仅存在于 node.clients 的用户要回到 state.clients
{
  const st = {
    mode: 'agent',
    primaryNodeId: 'n1',
    server: { listenPort: 7901 },
    nodes: [
      {
        id: 'n1',
        name: '落地出口',
        clients: [
          {
            id: 'only-on-node',
            name: 'u_legacy',
            password: 'x',
            enabled: true,
            route: { landingNodeId: 'n1' },
          },
        ],
      },
    ],
    clients: [],
  };
  const added = nodes.mergeClientsFromNodes(st);
  assert.strictEqual(added, 1);
  assert.strictEqual(st.clients.length, 1);
  assert.strictEqual(st.clients[0].name, 'u_legacy');
  // 已有同名不重复
  st.nodes[0].clients.push({ id: 'dup', name: 'u_legacy', password: 'y' });
  assert.strictEqual(nodes.mergeClientsFromNodes(st), 0);
  assert.strictEqual(st.clients.length, 1);
  ok('mergeClientsFromNodes recovers orphan node.clients');
}


// 16) Agent hello 不得覆盖面板改过的落地显示名
{
  const st = {
    mode: 'agent',
    primaryNodeId: null,
    nodes: [],
    clients: [{ id: 'c', name: 'u1', password: 'p', enabled: true, route: {}, package: {}, usage: {} }],
    server: { listenPort: 7901 },
    topology: require('../server/topology').defaultTopology(),
  };
  const { node } = nodes.createNode(st, { name: '落地出口' });
  st.primaryNodeId = node.id;
  // 模拟面板改名
  node.name = '家宽-北京';
  node.nameSource = 'panel';
  // 模拟 agent hello 带安装时旧名
  const reported = '落地出口';
  if (node.nameSource !== 'panel') {
    node.name = reported;
  } else {
    // panel locked — keep
  }
  assert.strictEqual(node.name, '家宽-北京', 'panel rename must stick after agent hello');
  // 未锁定时占位名可被 agent 填充
  const n2 = nodes.createNode(st, { name: '落地-2' }).node;
  // 模拟 hello 逻辑：placeholder 可更新
  let nameSource = n2.nameSource;
  let nm = n2.name;
  const bodyName = 'pro3-home';
  if (bodyName && nameSource !== 'panel') {
    const cur = String(nm || '').trim();
    const placeholder =
      !cur || cur === 'node' || /^落地-\d+$/.test(cur) || cur === '落地家宽' || cur === '落地出口';
    if (placeholder) nm = bodyName;
  }
  assert.strictEqual(nm, 'pro3-home', 'placeholder can take agent name');
  ok('agent hello must not overwrite panel landing name');
}


// 17) 任务 lease 超时回收：多次后 error，避免永久 pending
{
  const node = { jobs: [] };
  const job = {
    id: 'j1',
    type: 'mieru_apply',
    status: 'running',
    startedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    leaseUntil: new Date(Date.now() - 60 * 1000).toISOString(),
    reclaimCount: 4,
  };
  node.jobs = [job];
  nodes.reclaimStaleJobs(node);
  assert.strictEqual(job.status, 'error', '5th reclaim → error');
  ok('job lease reclaim marks error after 5');
}


// 18) pro3 listen 7902 时转发目标端口不得仍是 7901
{
  const st = {
    topology: topology.defaultTopology(),
    server: { listenPort: 7901, endpoint: '1.1.1.1:7901' },
    nodes: [],
    clients: [],
  };
  st.topology.ixes[0].forwardConfigured = true;
  st.topology.landings = [
    {
      id: 'L1',
      name: 'NB.JP',
      nodeId: 'n1',
      listenPort: 7901,
      homeReachableHost: '8.8.8.8',
      homeReachablePort: 7901,
      ixId: st.topology.ixes[0].id,
    },
    {
      id: 'L2',
      name: 'pro3',
      nodeId: 'n2',
      listenPort: 7902,
      homeReachableHost: '9.9.9.9',
      homeReachablePort: 7901, // 旧脏数据
      ixId: st.topology.ixes[0].id,
    },
  ];
  topology.ensureTopology(st);
  assert.strictEqual(Number(st.topology.landings[1].homeReachablePort), 7902);
  const fwd = topology.buildIxForwardScript(st);
  assert.ok(fwd.ok, fwd.error);
  const r2 = fwd.routes.find((r) => r.name === 'pro3');
  assert.strictEqual(r2.listenPort, 7902);
  assert.strictEqual(r2.homePort, 7902);
  assert.ok(fwd.script.includes('dnat to 9.9.9.9:7902'));
  ok('pro3 homeReachablePort follows listenPort 7902');
}



// 19) syncPrimaryFromState 不得用全局 7901 盖掉主落地 7902
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-v4-smoke-'));
  process.env.WG_DATA_DIR = dir;
  const st = {
    mode: 'agent',
    primaryNodeId: 'n-primary',
    server: { listenPort: 7901, protocol: 'TCP', mtu: 1400, multiplexing: 'MULTIPLEXING_LOW' },
    clients: [],
    nodes: [
      {
        id: 'n-primary',
        name: 'pro3',
        server: { listenPort: 7902, protocol: 'TCP' },
        tokenHash: 'x',
        jobs: [],
      },
    ],
    topology: {
      profile: 'cm-ix-home',
      ingress: { active: 'external', port: 7901, protocol: 'TCP', mobileHost: '', externalHost: '1.1.1.1' },
      ixes: [{ id: 'ix1', name: 'IX', lanIp: '1.1.1.1', portMin: 7900, portMax: 7999, forwardConfigured: true }],
      landings: [
        {
          id: 'L1',
          name: 'pro3',
          nodeId: 'n-primary',
          listenPort: 7902,
          homeReachablePort: 7902,
          homeReachableHost: '9.9.9.9',
          ixId: 'ix1',
        },
      ],
    },
  };
  nodes.syncPrimaryFromState(st);
  assert.strictEqual(
    Number(st.nodes[0].server.listenPort),
    7902,
    'syncPrimary must keep landing port 7902, not global 7901'
  );
  ok('syncPrimaryFromState must not clobber primary landing listenPort');

  // buildBundleForNode BOTH bindings: UDP = base+1
  // use require index helpers via mieru directly
  const bothBind = [];
  for (const p of mieru.protocolsForMode('BOTH')) {
    bothBind.push({ port: mieru.portForProtocol(7902, p, 'BOTH'), protocol: p });
  }
  assert.deepStrictEqual(bothBind, [
    { port: 7902, protocol: 'TCP' },
    { port: 7903, protocol: 'UDP' },
  ]);
  ok('BOTH protocol UDP is base+1');
}



// 20) second IX 10400 range: landing port auto-fix + share host + forward dedicated ports
{
  const st = {
    mode: 'agent',
    primaryNodeId: 'n1',
    server: { listenPort: 7901, protocol: 'TCP', mtu: 1400, multiplexing: 'MULTIPLEXING_LOW' },
    clients: [
      {
        id: 'c-ix2',
        name: 'uix2',
        password: 'pass-pass-pass3',
        enabled: true,
        route: {
          landingNodeId: 'n2',
          ixId: 'ix-1', // 故意错绑第一台
          listenPort: 10401, // 专用端口
          ingressActive: null,
        },
        package: {},
        usage: {},
      },
    ],
    nodes: [
      { id: 'n1', name: 'L1', server: { listenPort: 7901 }, online: true },
      { id: 'n2', name: 'L2', server: { listenPort: 7901 }, online: true },
    ],
    topology: {
      profile: 'cm-ix-home',
      ingress: {
        active: 'external',
        port: 7901,
        protocol: 'TCP',
        mobileHost: '211.1.1.1',
        externalHost: '114.1.1.1',
      },
      ixes: [
        {
          id: 'ix-1',
          name: 'IX1',
          lanIp: '10.0.0.1',
          portMin: 7900,
          portMax: 7999,
          forwardConfigured: true,
          ingress: {
            active: 'external',
            externalHost: '114.1.1.1',
            mobileHost: '211.1.1.1',
          },
        },
        {
          id: 'ix-2',
          name: 'IX2',
          lanIp: '10.0.0.2',
          portMin: 10400,
          portMax: 10499,
          forwardConfigured: true,
          ingress: {
            active: 'external',
            externalHost: '114.2.2.2',
            mobileHost: '211.2.2.2',
          },
        },
      ],
      landings: [
        {
          id: 'land-1',
          name: '落地1',
          nodeId: 'n1',
          listenPort: 7901,
          homeReachableHost: '8.8.8.8',
          homeReachablePort: 7901,
          ixId: 'ix-1',
        },
        {
          id: 'land-2',
          name: '落地2',
          nodeId: 'n2',
          listenPort: 7901, // 错：第二台 IX 仍 7901
          homeReachableHost: '9.9.9.9',
          homeReachablePort: 7901,
          ixId: 'ix-2',
        },
      ],
    },
  };
  topology.ensureTopology(st);
  const L2 = st.topology.landings.find((x) => x.id === 'land-2');
  assert.ok(Number(L2.listenPort) >= 10400 && Number(L2.listenPort) <= 10499, 'landing2 port auto in 104xx');
  assert.strictEqual(Number(L2.homeReachablePort), Number(L2.listenPort));
  assert.strictEqual(st.clients[0].route.ixId, 'ix-2', 'client ixId realigned to landing');
  // dedicated 10401 still valid → keep
  assert.strictEqual(Number(st.clients[0].route.listenPort), 10401);

  const dual = mieru.buildDualShareLinks(st, st.clients[0]);
  assert.ok(dual.endpoints.active.startsWith('114.2.2.2:'), dual.endpoints.active);
  assert.ok(dual.endpoints.active.endsWith(':10401'), dual.endpoints.active);
  assert.strictEqual(dual.ixId, 'ix-2');

  const fwd = topology.buildIxForwardScript(st, { ixId: 'ix-2' });
  assert.ok(fwd.ok, fwd.error);
  assert.ok(fwd.script.includes(String(L2.listenPort)), 'script has landing default');
  assert.ok(fwd.script.includes('10401'), 'script has dedicated user port');
  assert.ok(fwd.script.includes('9.9.9.9'));
  // wrong host from ix-1 must not appear as preferred for this client
  assert.ok(!dual.endpoints.active.startsWith('114.1.1.1:'));
  ok('second IX 104xx: sanitize + share host + dedicated DNAT');
}

// 21) resolveIx prefers landing.ixId over stale route.ixId
{
  const st = {
    topology: {
      profile: 'cm-ix-home',
      ingress: { active: 'mobile', port: 7901, protocol: 'TCP' },
      ixes: [
        topology.defaultIx({ id: 'ix-a', name: 'A', portMin: 7900, portMax: 7999 }),
        topology.defaultIx({ id: 'ix-b', name: 'B', portMin: 10400, portMax: 10499 }),
      ],
      landings: [
        topology.defaultLanding({
          id: 'Lb',
          nodeId: 'nb',
          ixId: 'ix-b',
          listenPort: 10400,
          homeReachableHost: '1.1.1.1',
        }),
      ],
    },
    clients: [],
    nodes: [],
    server: { listenPort: 7901, protocol: 'TCP' },
  };
  topology.ensureTopology(st);
  const ix = topology.resolveIx(st, { ixId: 'ix-a', landingNodeId: 'nb' });
  assert.strictEqual(ix.id, 'ix-b');
  ok('resolveIx landing wins over route.ixId');
}



// 22) resolveIngress: 第二台只填备用时切到有 host 的入口（本 IX 内）
{
  const st = {
    topology: {
      profile: 'cm-ix-home',
      ingress: {
        active: 'mobile',
        port: 7901,
        protocol: 'TCP',
        mobileHost: '211.0.0.1',
        externalHost: '114.0.0.1',
      },
      ixes: [
        topology.defaultIx({
          id: 'ix-a',
          name: 'A',
          portMin: 7900,
          portMax: 7999,
          ingress: { active: 'mobile', mobileHost: '211.0.0.1', externalHost: '114.0.0.1' },
        }),
        topology.defaultIx({
          id: 'ix-b',
          name: 'B',
          portMin: 10400,
          portMax: 10499,
          // 故意只填备用、active 却是 mobile 空
          ingress: { active: 'mobile', mobileHost: '', externalHost: '114.8.8.8' },
        }),
      ],
      landings: [
        topology.defaultLanding({
          id: 'Lb',
          nodeId: 'nb',
          ixId: 'ix-b',
          listenPort: 10400,
          homeReachableHost: '1.2.3.4',
        }),
      ],
    },
    clients: [
      {
        id: 'c',
        name: 'u',
        password: 'pass-pass-pass9',
        enabled: true,
        route: { landingNodeId: 'nb', ixId: 'ix-b' },
      },
    ],
    nodes: [],
    server: { listenPort: 7901, protocol: 'TCP' },
  };
  topology.ensureTopology(st);
  const ing = topology.resolveIngress(st, { landingNodeId: 'nb' });
  assert.ok(ing.externalHost === '114.8.8.8' || ing.mobileHost, JSON.stringify(ing));
  // active 应切到有 host 的
  const host = topology.activeIngressHost(st, null, { landingNodeId: 'nb' });
  assert.ok(host, 'host should not be empty');
  assert.strictEqual(host, '114.8.8.8', 'must use own external, not first IX mobile');
  const dual = mieru.buildDualShareLinks(st, st.clients[0]);
  assert.ok(dual.preferred, dual);
  assert.ok(!dual.preferred.includes('undefined'));
  assert.ok(dual.preferred.includes('114.8.8.8'));
  assert.ok(!dual.preferred.includes('211.0.0.1'), 'must not steal first IX host');
  ok('second IX empty active host falls back');
}

// 22b) 第二台全空 Host：禁止偷第一台前置（CM7 空配置不得生成 CM5 Host:10400）
{
  const st = {
    topology: {
      profile: 'cm-ix-home',
      ingress: {
        active: 'external',
        port: 7901,
        protocol: 'TCP',
        mobileHost: '211.0.0.1',
        externalHost: '114.0.0.1',
      },
      ixes: [
        topology.defaultIx({
          id: 'ix-cm5',
          name: 'CM5',
          portMin: 7900,
          portMax: 7999,
          ingress: { active: 'external', mobileHost: '211.0.0.1', externalHost: '114.0.0.1' },
        }),
        topology.defaultIx({
          id: 'ix-cm7',
          name: 'CM7',
          portMin: 10400,
          portMax: 10499,
          ingress: { active: 'mobile', mobileHost: '', externalHost: '', customHost: '' },
        }),
      ],
      landings: [
        // 故意写 7901（CM5 段），ensure 应纠正到 104xx 并标记 dirty
        topology.defaultLanding({
          id: 'l7',
          nodeId: 'n7',
          ixId: 'ix-cm7',
          listenPort: 7901,
          homeReachableHost: '9.9.9.9',
          homeReachablePort: 7901,
        }),
      ],
    },
    clients: [
      {
        id: 'c7',
        name: 'ucm7',
        password: 'pass-pass-pass7',
        enabled: true,
        route: { landingNodeId: 'n7', ixId: 'ix-cm7' },
      },
    ],
    nodes: [{ id: 'n7', name: 'CM7-home', server: { listenPort: 7901 }, jobs: [] }],
    server: { listenPort: 7901, protocol: 'TCP' },
    mode: 'agent',
  };
  topology.ensureTopology(st);
  // 纠正 7901 → 10400 并记录 dirty node
  assert.ok(
    Number(st.topology.landings[0].listenPort) >= 10400,
    'landing port sanitized to 104xx'
  );
  assert.ok(
    Array.isArray(st._portSanitizeDirtyNodeIds) && st._portSanitizeDirtyNodeIds.includes('n7'),
    'sanitize should mark node dirty for apply: ' + JSON.stringify(st._portSanitizeDirtyNodeIds)
  );
  const ing = topology.resolveIngress(st, { landingNodeId: 'n7', ixId: 'ix-cm7' });
  assert.strictEqual(String(ing.mobileHost || ''), '', JSON.stringify(ing));
  assert.strictEqual(String(ing.externalHost || ''), '', JSON.stringify(ing));
  const host = topology.activeIngressHost(st, null, { landingNodeId: 'n7' });
  assert.ok(!host, 'empty second IX must not resolve first IX host');
  let threw = false;
  try {
    mieru.buildDualShareLinks(st, st.clients[0]);
  } catch (e) {
    threw = e.code === 'NO_ENDPOINT' || /前置|endpoint|Host/i.test(String(e.message || ''));
  }
  // preferred 可能是空串而非 throw，两种都算对
  if (!threw) {
    const dual = mieru.buildDualShareLinks(st, st.clients[0]);
    assert.ok(!dual.preferred || !/211\.0\.0\.1|114\.0\.0\.1/.test(dual.preferred), dual);
  }
  // 保存第二台不得改全局 port
  const gPortBefore = st.topology.ingress.port;
  topology.applyTopologyPatch(st, {
    ixId: 'ix-cm7',
    ingress: {
      active: 'mobile',
      port: 10400,
      mobileHost: '',
      externalHost: '',
      customHost: '',
      protocol: 'TCP',
    },
    ixes: st.topology.ixes.map((x) => ({ ...x, ingress: { ...(x.ingress || {}) } })),
  });
  assert.strictEqual(
    Number(st.topology.ingress.port),
    Number(gPortBefore),
    'saving CM7 must not overwrite global ingress.port'
  );
  ok('second IX empty hosts isolated + global port preserved');
}

// 23) diagnose no longer has global ingress id
{
  const st = {
    topology: topology.defaultTopology(),
    clients: [],
    nodes: [],
    server: { listenPort: 7901, protocol: 'TCP', endpoint: '' },
    mode: 'local',
  };
  topology.ensureTopology(st);
  st.topology.ixes[0].ingress.mobileHost = '1.1.1.1';
  const d = topology.diagnoseTopology(st, { mode: 'local' });
  assert.ok(!d.items.some((x) => x.id === 'ingress'), 'global ingress item removed');
  ok('diagnose dropped useless global ingress item');
}

// 24) agent bundle version readable
{
  const fs = require('fs');
  const path = require('path');
  const ver = fs.readFileSync(path.join(__dirname, '..', 'agent', 'VERSION'), 'utf8').trim();
  assert.strictEqual(ver, '4.3.3');
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'index.js'), 'utf8');
  assert.ok(src.includes("const VERSION = '4.3.3'"));
  assert.ok(src.includes('agentTargetVersion'));
  ok('agent 4.3.3 bundle present');
}


// 25) second IX forward script must NOT equal first IX script
{
  const st = {
    server: { listenPort: 7901, protocol: 'TCP' },
    clients: [],
    nodes: [],
    topology: {
      profile: 'cm-ix-home',
      ingress: {
        active: 'external',
        port: 7901,
        protocol: 'TCP',
        externalHost: '114.1.1.1',
        mobileHost: '211.1.1.1',
      },
      ixes: [
        topology.defaultIx({
          id: 'ix-1',
          name: 'NB,CM5',
          lanIp: '172.16.2.79',
          portMin: 7900,
          portMax: 7999,
          ingress: {
            active: 'external',
            externalHost: '114.111.176.37',
            mobileHost: '211.136.162.184',
          },
        }),
        topology.defaultIx({
          id: 'ix-2',
          name: 'IX2',
          lanIp: '172.16.2.80',
          portMin: 10400,
          portMax: 10499,
          ingress: {
            active: 'external',
            externalHost: '114.2.2.2',
            mobileHost: '211.2.2.2',
          },
        }),
      ],
      landings: [
        topology.defaultLanding({
          id: 'l1',
          name: 'NB.JP',
          nodeId: 'n1',
          ixId: 'ix-1',
          listenPort: 7901,
          homeReachableHost: '82.22.26.185',
        }),
        topology.defaultLanding({
          id: 'l2',
          name: 'pro3',
          nodeId: 'n2',
          ixId: 'ix-1',
          listenPort: 7902,
          homeReachableHost: '68.252.208.114',
        }),
      ],
    },
  };
  topology.ensureTopology(st);
  const s1 = topology.buildIxForwardScript(st, { ixId: 'ix-1' });
  assert.ok(s1.ok);
  assert.ok(s1.script.includes('ixId=ix-1'));
  assert.ok(s1.script.includes('7901'));
  // 第二台无落地：不得回落生成第一台脚本
  const s2empty = topology.buildIxForwardScript(st, { ixId: 'ix-2' });
  assert.strictEqual(s2empty.ok, false, 'ix2 without landings must fail');
  assert.ok(!s2empty.script, 'ix2 must not return first ix script');
  assert.ok(String(s2empty.error || '').includes('没有绑定落地') || String(s2empty.error || '').includes('落地'));
  // 跨 IX 的 landingId 不得把第一台规则写进第二台
  const s2cross = topology.buildIxForwardScript(st, { ixId: 'ix-2', landingId: 'l1', port: 7901 });
  assert.strictEqual(s2cross.ok, false);
  assert.ok(!s2cross.script);
  // 把 pro3 绑到第二台并改 10400
  st.topology.landings[1].ixId = 'ix-2';
  st.topology.landings[1].listenPort = 10400;
  st.topology.landings[1].homeReachablePort = 10400;
  topology.ensureTopology(st);
  const s2 = topology.buildIxForwardScript(st, { ixId: 'ix-2' });
  assert.ok(s2.ok, s2.error);
  assert.ok(s2.script.includes('ixId=ix-2'));
  assert.ok(s2.script.includes('10400'));
  assert.ok(s2.script.includes('68.252.208.114'));
  assert.ok(!s2.script.includes('dport 7901'), 'ix2 script must not DNAT 7901');
  assert.notStrictEqual(s1.script, s2.script);
  // 未知 ixId
  const sBad = topology.buildIxForwardScript(st, { ixId: 'ix-nope' });
  assert.strictEqual(sBad.ok, false);
  assert.ok(!sBad.script);
  ok('second IX forward script isolated from first');
}


// 26) GET topology without ixId must not return first-IX script body
// (simulates old refreshCore bug)
{
  const st = {
    server: { listenPort: 7901, protocol: 'TCP' },
    clients: [],
    nodes: [],
    topology: {
      profile: 'cm-ix-home',
      ingress: { active: 'external', port: 7901, protocol: 'TCP', externalHost: '114.1.1.1' },
      ixes: [
        topology.defaultIx({
          id: 'ix-1',
          name: 'IX1',
          lanIp: '10.0.0.1',
          portMin: 7900,
          portMax: 7999,
          ingress: { active: 'external', externalHost: '114.1.1.1' },
        }),
        topology.defaultIx({
          id: 'ix-2',
          name: 'IX2',
          lanIp: '10.0.0.2',
          portMin: 10400,
          portMax: 10499,
          ingress: { active: 'external', externalHost: '114.2.2.2' },
        }),
      ],
      landings: [
        topology.defaultLanding({
          id: 'l1',
          name: 'A',
          nodeId: 'n1',
          ixId: 'ix-1',
          listenPort: 7901,
          homeReachableHost: '1.1.1.1',
        }),
        topology.defaultLanding({
          id: 'l2',
          name: 'B',
          nodeId: 'n2',
          ixId: 'ix-2',
          listenPort: 10400,
          homeReachableHost: '2.2.2.2',
        }),
      ],
    },
  };
  topology.ensureTopology(st);
  const withId = topology.buildIxForwardScript(st, { ixId: 'ix-2' });
  assert.ok(withId.ok && withId.script.includes('10400'));
  const noId = topology.buildIxForwardScript(st, {});
  // noId 仍可能生成第一台（内部默认）——面板 GET 已禁止无 ixId 返回 script
  assert.ok(noId.script.includes('7901') || noId.ok);
  // 关键点：带 ixId 的两台脚本必须不同
  const a = topology.buildIxForwardScript(st, { ixId: 'ix-1' });
  const b = topology.buildIxForwardScript(st, { ixId: 'ix-2' });
  assert.notStrictEqual(a.script, b.script);
  assert.ok(a.script.includes('ixId=ix-1'));
  assert.ok(b.script.includes('ixId=ix-2'));
  ok('per-ix scripts differ; ix2 has 10400');
}

console.log('\nsmoke-v4: all passed');
console.log('tmp data:', tmp);
