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

console.log('\nsmoke-v4: all passed');
console.log('tmp data:', tmp);
