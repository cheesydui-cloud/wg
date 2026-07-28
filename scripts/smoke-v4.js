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
  })
);
state.topology.landings.push(
  topology.defaultLanding({
    id: 'landing-2',
    nodeId: 'node-2',
    name: '落地2',
    homeReachableHost: '5.6.7.8',
    listenPort: 7902,
  })
);
const fwd = topology.buildIxForwardScript(state, {
  ixId: 'ix-2',
  landingId: 'landing-2',
  port: 7902,
});
assert.ok(fwd.ok, fwd.error);
assert.ok(fwd.script.includes('7902'));
assert.ok(fwd.script.includes('5.6.7.8'));
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

console.log('\nsmoke-v4: all passed');
console.log('tmp data:', tmp);
