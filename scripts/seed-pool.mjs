// Siembra el pool con depósitos señuelo desde cuentas testnet distintas para ampliar
// el conjunto de anonimato. Cada depósito es una nota real (se guarda en
// scripts/.seed-notes.json, ignorado por git) para poder hacer retiros señuelo después.
//
// Uso (desde la raíz del repo):  node scripts/seed-pool.mjs [cantidad] [paralelo]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createNote, serializeNote, fieldToHex } from '../app/src/zk/note.js';

const run = promisify(execFile);
const config = JSON.parse(readFileSync(new URL('../app/src/config.json', import.meta.url)));
const NOTES_FILE = new URL('./.seed-notes.json', import.meta.url);
const total = Number(process.argv[2] ?? 20);
const parallel = Number(process.argv[3] ?? 5);
const tag = Date.now().toString(36);

const notes = existsSync(NOTES_FILE) ? JSON.parse(readFileSync(NOTES_FILE)) : [];

async function seedOne(i) {
  const id = `nzk-seed-${tag}-${i}`;
  await run('stellar', ['keys', 'generate', id, '--fund', '--network', 'testnet']);
  const { stdout: address } = await run('stellar', ['keys', 'address', id]);
  const note = await createNote(BigInt(config.denomination));
  const commitment = fieldToHex(note.commitment).replace(/^0x/, '');
  const { stdout } = await run('stellar', [
    'contract', 'invoke', '--id', config.poolContractId, '--source', id, '--network', 'testnet',
    '--', 'deposit', '--from', address.trim(), '--commitment', commitment,
  ]);
  notes.push({ note: serializeNote(note), leaf: Number(stdout.trim()), from: address.trim() });
  console.log(`depósito ${i + 1}/${total} → hoja ${stdout.trim()} desde ${address.trim().slice(0, 6)}…`);
}

for (let start = 0; start < total; start += parallel) {
  const batch = [];
  for (let i = start; i < Math.min(start + parallel, total); i++) {
    batch.push(seedOne(i).catch((e) => console.error(`depósito ${i + 1} falló: ${e.stderr || e.message}`)));
  }
  await Promise.all(batch);
  writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
}
console.log(`Listo: ${notes.length} notas señuelo guardadas en scripts/.seed-notes.json`);
