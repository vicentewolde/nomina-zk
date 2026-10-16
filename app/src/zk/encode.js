// Codificación de pruebas y VK Groth16 (snarkjs, BN254) al formato de las host
// functions bn254_* de Soroban. Ver docs/INTERFACE.md.
// - Fp / escalares: 32 bytes big-endian.
// - G1: X || Y (64 bytes).
// - G2: X.c1 || X.c0 || Y.c1 || Y.c0 (128 bytes). snarkjs da [c0, c1].
// ESM sin dependencias: funciona en el navegador y en Node.

export function toHex32(value) {
  const n = BigInt(value);
  if (n < 0n || n >= 1n << 256n) throw new Error(`Fuera de rango para 32 bytes: ${value}`);
  return n.toString(16).padStart(64, '0');
}

export function g1ToHex(p) {
  return toHex32(p[0]) + toHex32(p[1]);
}

export function g2ToHex(p) {
  const [x, y] = p;
  return toHex32(x[1]) + toHex32(x[0]) + toHex32(y[1]) + toHex32(y[0]);
}

export function proofToSoroban(proof) {
  return {
    a: g1ToHex(proof.pi_a),
    b: g2ToHex(proof.pi_b),
    c: g1ToHex(proof.pi_c),
  };
}

export function vkToSoroban(vk) {
  return {
    alpha: g1ToHex(vk.vk_alpha_1),
    beta: g2ToHex(vk.vk_beta_2),
    gamma: g2ToHex(vk.vk_gamma_2),
    delta: g2ToHex(vk.vk_delta_2),
    ic: vk.IC.map(g1ToHex),
  };
}

// publicSignals de snarkjs ([root, nullifierHash, recipient]) a hex de 32 bytes BE.
export function publicSignalsToHex(publicSignals) {
  return publicSignals.map(toHex32);
}

export function hexToBytes(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Igual que proofToSoroban pero en bytes: { a: Uint8Array(64), b: Uint8Array(128), c: Uint8Array(64) }.
export function proofToSorobanBytes(proof) {
  const { a, b, c } = proofToSoroban(proof);
  return { a: hexToBytes(a), b: hexToBytes(b), c: hexToBytes(c) };
}
