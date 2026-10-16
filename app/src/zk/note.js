// Notas, Merkle tree y recipient para Nómina ZK. Ver docs/INTERFACE.md.
// ESM para el navegador (también corre en Node >= 20): usa crypto.subtle y
// crypto.getRandomValues, circomlibjs (Poseidon) y @stellar/stellar-sdk (XDR).
import { buildPoseidon } from 'circomlibjs';
import { Address } from '@stellar/stellar-sdk';

export const LEVELS = 10;
export const NOTE_PREFIX = 'nzk';

let poseidonPromise;
export function getPoseidon() {
  if (!poseidonPromise) poseidonPromise = buildPoseidon();
  return poseidonPromise;
}

// Poseidon de circomlib sobre BigInts; devuelve BigInt.
export async function poseidonHash(inputs) {
  const poseidon = await getPoseidon();
  return poseidon.F.toObject(poseidon(inputs.map((x) => BigInt(x))));
}

function bytesToBigInt(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

// Acepta BigInt, número, string decimal, hex "0x..." / hex de 64 chars o Uint8Array(32).
export function toField(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (value instanceof Uint8Array) return bytesToBigInt(value);
  if (typeof value === 'string') {
    if (value.startsWith('0x')) return BigInt(value);
    if (/^[0-9a-fA-F]{64}$/.test(value)) return BigInt('0x' + value);
    return BigInt(value);
  }
  throw new Error(`No se puede convertir a elemento de campo: ${value}`);
}

export function fieldToHex(n) {
  return BigInt(n).toString(16).padStart(64, '0');
}

export function randomField31() {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return bytesToBigInt(bytes);
}

export async function commitmentOf(nullifier, secret) {
  return poseidonHash([nullifier, secret]);
}

export async function nullifierHashOf(nullifier) {
  return poseidonHash([nullifier]);
}

async function completeNote(denomination, nullifier, secret) {
  const note = {
    denomination: BigInt(denomination),
    nullifier,
    secret,
    commitment: await commitmentOf(nullifier, secret),
    nullifierHash: await nullifierHashOf(nullifier),
  };
  note.text = serializeNote(note);
  return note;
}

// Genera una nota nueva. denominationStroops: p. ej. 100000000n (10 XLM).
export async function createNote(denominationStroops) {
  return completeNote(denominationStroops, randomField31(), randomField31());
}

// Formato: nzk-<denominationStroops>-<nullifierHex62>-<secretHex62>
export function serializeNote({ denomination, nullifier, secret }) {
  const h62 = (n) => BigInt(n).toString(16).padStart(62, '0');
  return `${NOTE_PREFIX}-${BigInt(denomination).toString()}-${h62(nullifier)}-${h62(secret)}`;
}

export async function parseNote(text) {
  const m = /^nzk-(\d+)-([0-9a-fA-F]{62})-([0-9a-fA-F]{62})$/.exec(text.trim());
  if (!m) throw new Error('Nota inválida: se espera nzk-<stroops>-<nullifier62>-<secret62>');
  return completeNote(BigInt(m[1]), BigInt('0x' + m[2]), BigInt('0x' + m[3]));
}

// zeros[0] = 0, zeros[i] = Poseidon([zeros[i-1], zeros[i-1]]). Devuelve LEVELS+1 valores
// (zeros[LEVELS] es la raíz del árbol vacío).
let zerosCache;
export async function computeZeros(levels = LEVELS) {
  if (zerosCache && zerosCache.length >= levels + 1) return zerosCache.slice(0, levels + 1);
  const zeros = [0n];
  for (let i = 1; i <= levels; i++) zeros.push(await poseidonHash([zeros[i - 1], zeros[i - 1]]));
  zerosCache = zeros;
  return zeros.slice();
}

// Construye root + Merkle path para la hoja `index` a partir de todas las hojas en orden.
// `leaves` puede venir como BigInt, hex o Uint8Array (BytesN<32> del contrato).
export async function buildMerklePath(leaves, index, levels = LEVELS) {
  const zeros = await computeZeros(levels);
  let layer = leaves.map(toField);
  if (index < 0 || index >= layer.length) throw new Error(`Índice ${index} fuera del árbol (${layer.length} hojas)`);
  if (layer.length > 2 ** levels) throw new Error('Demasiadas hojas para el árbol');

  const pathElements = [];
  const pathIndices = [];
  let idx = index;
  for (let level = 0; level < levels; level++) {
    const isRight = idx & 1;
    const sibling = isRight ? idx - 1 : idx + 1;
    pathElements.push(sibling < layer.length ? layer[sibling] : zeros[level]);
    pathIndices.push(isRight);

    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : zeros[level];
      next.push(await poseidonHash([left, right]));
    }
    layer = next;
    idx >>= 1;
  }
  return { root: layer[0], pathElements, pathIndices };
}

// Raíz del árbol para una lista de hojas (útil para comparar con get_root()).
export async function computeRoot(leaves, levels = LEVELS) {
  if (leaves.length === 0) return (await computeZeros(levels))[levels];
  return (await buildMerklePath(leaves, 0, levels)).root;
}

// recipient = sha256(ScVal::Address(G).toXDR()) con el primer byte en 0, como BigInt BE.
export async function recipientField(address) {
  const xdr = Address.fromString(address).toScVal().toXDR();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(xdr)));
  digest[0] = 0;
  return bytesToBigInt(digest);
}

// Entradas completas del circuito withdraw para snarkjs.groth16.fullProve.
export async function buildWithdrawInput(note, leaves, recipientAddress) {
  const leafValues = leaves.map(toField);
  const index = leafValues.findIndex((l) => l === note.commitment);
  if (index < 0) throw new Error('La nota no está en el pool (commitment no encontrado entre las hojas)');
  const { root, pathElements, pathIndices } = await buildMerklePath(leafValues, index);
  const recipient = await recipientField(recipientAddress);
  return {
    leafIndex: index,
    input: {
      root: root.toString(),
      nullifierHash: note.nullifierHash.toString(),
      recipient: recipient.toString(),
      nullifier: note.nullifier.toString(),
      secret: note.secret.toString(),
      pathElements: pathElements.map(String),
      pathIndices: pathIndices.map(String),
    },
  };
}

// Alias que usa la app.
export const buildMerkleProof = buildMerklePath;
export const recipientToField = recipientField;
