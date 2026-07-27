/**
 * WireGuard 兼容的 Curve25519 密钥生成（纯 JS，不依赖系统 wg）
 * 私钥：32 字节随机数，按 WireGuard clamp 规则处理后 base64
 * 公钥：X25519 标量乘法 base64
 */

const crypto = require('crypto');

// base64 helpers
function toB64(buf) {
  return Buffer.from(buf).toString('base64');
}

function fromB64(str) {
  return new Uint8Array(Buffer.from(str, 'base64'));
}

// ---- minimal X25519 (RFC 7748) ----
const P = 2n ** 255n - 19n;
const A24 = 121665n;

function mod(a) {
  let r = a % P;
  if (r < 0n) r += P;
  return r;
}

function pow(base, exp) {
  let r = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = mod(r * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return r;
}

function inv(x) {
  return pow(x, P - 2n);
}

function decodeScalar(bytes) {
  const arr = Uint8Array.from(bytes);
  arr[0] &= 248;
  arr[31] &= 127;
  arr[31] |= 64;
  let x = 0n;
  for (let i = 0; i < 32; i++) x |= BigInt(arr[i]) << BigInt(8 * i);
  return x;
}

function decodeUCoordinate(bytes) {
  const arr = Uint8Array.from(bytes);
  arr[31] &= 127;
  let x = 0n;
  for (let i = 0; i < 32; i++) x |= BigInt(arr[i]) << BigInt(8 * i);
  return mod(x);
}

function encodeUCoordinate(n) {
  let x = mod(n);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function x25519(scalarBytes, uBytes) {
  const k = decodeScalar(scalarBytes);
  const u = decodeUCoordinate(uBytes);

  let x1 = u;
  let x2 = 1n;
  let z2 = 0n;
  let x3 = u;
  let z3 = 1n;
  let swap = 0n;

  for (let t = 254; t >= 0; t--) {
    const kt = (k >> BigInt(t)) & 1n;
    swap ^= kt;
    // cswap
    let dummy = swap * (x2 - x3);
    x2 = mod(x2 - dummy);
    x3 = mod(x3 + dummy);
    dummy = swap * (z2 - z3);
    z2 = mod(z2 - dummy);
    z3 = mod(z3 + dummy);
    swap = kt;

    const A = mod(x2 + z2);
    const AA = mod(A * A);
    const B = mod(x2 - z2);
    const BB = mod(B * B);
    const E = mod(AA - BB);
    const C = mod(x3 + z3);
    const D = mod(x3 - z3);
    const DA = mod(D * A);
    const CB = mod(C * B);
    x3 = mod((DA + CB) * (DA + CB));
    z3 = mod(x1 * (DA - CB) * (DA - CB));
    x2 = mod(AA * BB);
    z2 = mod(E * (AA + mod(A24 * E)));
  }

  // final cswap
  let dummy = swap * (x2 - x3);
  x2 = mod(x2 - dummy);
  x3 = mod(x3 + dummy);
  dummy = swap * (z2 - z3);
  z2 = mod(z2 - dummy);
  z3 = mod(z3 + dummy);

  return encodeUCoordinate(mod(x2 * inv(z2)));
}

const BASE_POINT = (() => {
  const p = new Uint8Array(32);
  p[0] = 9;
  return p;
})();

function clampPrivateKey(raw) {
  const key = Uint8Array.from(raw);
  key[0] &= 248;
  key[31] &= 127;
  key[31] |= 64;
  return key;
}

function generatePrivateKey() {
  const raw = crypto.randomBytes(32);
  return toB64(clampPrivateKey(raw));
}

function derivePublicKey(privateKeyB64) {
  const priv = fromB64(privateKeyB64);
  if (priv.length !== 32) throw new Error('私钥长度无效');
  const pub = x25519(priv, BASE_POINT);
  return toB64(pub);
}

function generateKeyPair() {
  const privateKey = generatePrivateKey();
  const publicKey = derivePublicKey(privateKey);
  return { privateKey, publicKey };
}

function generatePresharedKey() {
  return toB64(crypto.randomBytes(32));
}

function isValidKey(key) {
  if (typeof key !== 'string' || !key.trim()) return false;
  try {
    const buf = Buffer.from(key.trim(), 'base64');
    return buf.length === 32;
  } catch {
    return false;
  }
}

module.exports = {
  generatePrivateKey,
  derivePublicKey,
  generateKeyPair,
  generatePresharedKey,
  isValidKey,
};
