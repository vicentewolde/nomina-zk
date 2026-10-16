// Operaciones sobre el contrato pool: depósito y retiro con prueba Groth16.
import { buildWithdrawInput, createNote, fieldToHex, parseNote, toField } from '../zk/note.js';
import { hexToBytes, proofToSorobanBytes } from '../zk/encode.js';
import { addressVal, bytesVal, invokeContract, proofVal, readContract } from './stellar.js';
import { getConfig } from './config.js';

const field32 = (n) => hexToBytes(fieldToHex(n));

function poolId() {
  const id = getConfig().poolContractId;
  if (!id) throw new Error('Falta el ID del contrato pool (app/src/config.json o ajustes avanzados)');
  return id;
}

/** Crea una nota nueva y la deposita en el pool. */
export async function depositNewNote(signer, onStatus) {
  onStatus?.('Generando nota secreta…');
  const note = await createNote(BigInt(getConfig().denomination));
  const { hash, returnValue } = await invokeContract({
    contractId: poolId(),
    method: 'deposit',
    args: [addressVal(signer.address), bytesVal(field32(note.commitment))],
    signer,
    onStatus,
  });
  return { text: note.text, commitment: fieldToHex(note.commitment), leafIndex: returnValue, hash };
}

export async function getLeaves(source) {
  const leaves = (await readContract(poolId(), 'get_leaves', [], source)) || [];
  return leaves.map((l) => toField(new Uint8Array(l)));
}

export async function isSpent(nullifierHash, source) {
  return Boolean(await readContract(poolId(), 'is_spent', [bytesVal(field32(nullifierHash))], source));
}

export async function isKnownRoot(root, source) {
  return Boolean(await readContract(poolId(), 'is_known_root', [bytesVal(field32(root))], source));
}

export { parseNote };

/**
 * Retira una nota hacia `recipient`. `signer` paga la fee (puede ser la misma wallet nueva).
 * onStep(clave, texto) informa el progreso a la UI.
 */
export async function withdrawNote({ noteText, recipient, signer, onStep, zkWasm = '/zk/withdraw.wasm', zkKey = '/zk/withdraw_final.zkey' }) {
  const step = (k, t) => onStep?.(k, t);

  step('parse', 'Leyendo la nota…');
  const note = await parseNote(noteText);
  if (note.denomination !== BigInt(getConfig().denomination)) {
    throw new Error('La nota es de otra denominación que este pool');
  }

  step('spent', 'Verificando que la nota no se haya cobrado…');
  if (await isSpent(note.nullifierHash, signer.address)) throw new Error('Esta nota ya fue cobrada');

  step('leaves', 'Descargando el Merkle tree del contrato…');
  const leaves = await getLeaves(signer.address);
  const { input, leafIndex } = await buildWithdrawInput(note, leaves, recipient);
  const root = BigInt(input.root);
  if (!(await isKnownRoot(root, signer.address))) {
    throw new Error('La raíz calculada no coincide con ninguna raíz conocida por el contrato');
  }

  step('prove', `Generando la prueba ZK en tu navegador (hoja #${leafIndex} entre ${leaves.length})…`);
  const snarkjs = await import('snarkjs');
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, zkWasm, zkKey);
  const proveMs = Math.round(performance.now() - t0);
  if (publicSignals[0] !== input.root || publicSignals[1] !== input.nullifierHash) {
    throw new Error('Las señales públicas de la prueba no coinciden');
  }

  step('send', `Prueba lista en ${(proveMs / 1000).toFixed(1)} s. Enviando withdraw al contrato…`);
  const { hash } = await invokeContract({
    contractId: poolId(),
    method: 'withdraw',
    args: [
      proofVal(proofToSorobanBytes(proof)),
      bytesVal(field32(root)),
      bytesVal(field32(note.nullifierHash)),
      addressVal(recipient),
    ],
    signer,
    onStatus: (t) => step('send', t),
  });
  step('done', 'Retiro confirmado.');
  return { hash, nullifierHash: fieldToHex(note.nullifierHash), proveMs };
}
