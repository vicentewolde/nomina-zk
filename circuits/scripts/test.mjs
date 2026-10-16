// Prueba de punta a punta en Node: notas -> árbol -> prueba Groth16 -> verificación.
// Escribe build/test-vector.json y build/poseidon-vectors.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as snarkjs from 'snarkjs';
import { Keypair } from '@stellar/stellar-sdk';
import { proofToSoroban, publicSignalsToHex, toHex32 } from '../../app/src/zk/encode.js';
import {
  createNote, parseNote, poseidonHash, computeZeros, computeRoot,
  buildWithdrawInput, recipientField, LEVELS,
} from '../../app/src/zk/note.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const build = path.join(here, '..', 'build');
const WASM = path.join(build, 'withdraw_js', 'withdraw.wasm');
const ZKEY = path.join(build, 'withdraw_final.zkey');
const VK = JSON.parse(readFileSync(path.join(build, 'verification_key.json'), 'utf8'));
const DENOMINATION = 100_000_000n;

function assert(cond, msg) { if (!cond) throw new Error('FALLO: ' + msg); }

// 1. Vectores Poseidon para el contrato.
const zeros = await computeZeros(LEVELS);
const poseidonVectors = {
  note: 'Poseidon de circomlibjs (BN254). Valores como hex de 32 bytes big-endian y decimal.',
  poseidon_1: { inputs: ['1'], hex: toHex32(await poseidonHash([1n])), dec: (await poseidonHash([1n])).toString() },
  poseidon_1_2: { inputs: ['1', '2'], hex: toHex32(await poseidonHash([1n, 2n])), dec: (await poseidonHash([1n, 2n])).toString() },
  zeros: zeros.slice(0, 4).map((z) => ({ hex: toHex32(z), dec: z.toString() })),
  zeros_all_hex: zeros.map(toHex32),
  empty_root_hex: toHex32(zeros[LEVELS]),
};
assert(poseidonVectors.poseidon_1_2.hex === '115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a', 'Poseidon([1,2]) no coincide con el valor conocido de circomlib');
writeFileSync(path.join(build, 'poseidon-vectors.json'), JSON.stringify(poseidonVectors, null, 2) + '\n');
console.log('Poseidon([1])   =', poseidonVectors.poseidon_1.hex);
console.log('Poseidon([1,2]) =', poseidonVectors.poseidon_1_2.hex);

// 2. Tres notas, ida y vuelta por el formato de texto.
const notes = [];
for (let i = 0; i < 3; i++) notes.push(await createNote(DENOMINATION));
for (const n of notes) {
  const back = await parseNote(n.text);
  assert(back.commitment === n.commitment && back.nullifierHash === n.nullifierHash, 'parseNote/serializeNote');
}
const leaves = notes.map((n) => n.commitment);
const root = await computeRoot(leaves);
console.log('Nota de ejemplo:', notes[1].text);
console.log('Root:', toHex32(root));

// 3. Prueba para la nota 1 hacia un destinatario nuevo.
const recipientAddress = Keypair.random().publicKey();
const target = notes[1];
const { input, leafIndex } = await buildWithdrawInput(target, leaves, recipientAddress);
assert(leafIndex === 1, 'leafIndex');
assert(BigInt(input.root) === root, 'root del path');

console.time('fullProve');
const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
console.timeEnd('fullProve');
assert(publicSignals.length === 3, 'publicSignals = [root, nullifierHash, recipient]');
assert(BigInt(publicSignals[0]) === root, 'publicSignals[0] = root');
assert(BigInt(publicSignals[1]) === target.nullifierHash, 'publicSignals[1] = nullifierHash');
assert(BigInt(publicSignals[2]) === await recipientField(recipientAddress), 'publicSignals[2] = recipient');

const ok = await snarkjs.groth16.verify(VK, publicSignals, proof);
assert(ok, 'la prueba no verifica');
console.log('Prueba verificada localmente: OK');

// 4. Caso negativo: alterar el recipient invalida la prueba.
const tampered = [...publicSignals];
tampered[2] = (BigInt(tampered[2]) + 1n).toString();
assert(!(await snarkjs.groth16.verify(VK, tampered, proof)), 'una prueba con recipient alterado no debe verificar');
console.log('Recipient alterado rechazado: OK');

// 5. Vector de prueba para el contrato.
const [rootHex, nullifierHashHex, recipientHex] = publicSignalsToHex(publicSignals);
const vector = {
  recipientAddress,
  note: target.text,
  leafIndex,
  leaves: leaves.map(toHex32),
  proof,
  publicSignals,
  soroban: {
    proof: proofToSoroban(proof),
    root: rootHex,
    nullifierHash: nullifierHashHex,
    recipient: recipientHex,
    publicInputs: [rootHex, nullifierHashHex, recipientHex],
  },
};
writeFileSync(path.join(build, 'test-vector.json'), JSON.stringify(vector, null, 2) + '\n');
console.log('Escritos build/test-vector.json y build/poseidon-vectors.json');
process.exit(0);
