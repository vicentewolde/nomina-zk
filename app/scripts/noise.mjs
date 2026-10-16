// Tráfico señuelo para el pool: depósitos y retiros hechos con EL MISMO código que la app
// (mismas fees, timebounds y forma de transacción), a intervalos aleatorios. Así el
// depósito y el retiro del jurado quedan mezclados con otros iguales.
//
// Uso (desde app/):  npx vite-node scripts/noise.mjs -- [minutos=30] [minSeg=20] [maxSeg=70]
// Notas pendientes de cobro: scripts/.seed-notes.json en la raíz del repo (ignorado por git).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { depositNewNote, withdrawNote, isSpent, parseNote } from '../src/lib/pool.js';
import { newFundedKeypair, keypairSigner } from '../src/lib/stellar.js';

const args = process.argv.slice(2).filter((a) => a !== '--');
const minutes = Number(args[0] ?? 30);
const minGap = Number(args[1] ?? 20);
const maxGap = Number(args[2] ?? 70);

const NOTES_FILE = new URL('../../scripts/.seed-notes.json', import.meta.url);
const zkWasm = fileURLToPath(new URL('../public/zk/withdraw.wasm', import.meta.url));
const zkKey = fileURLToPath(new URL('../public/zk/withdraw_final.zkey', import.meta.url));

const loadNotes = () => (existsSync(NOTES_FILE) ? JSON.parse(readFileSync(NOTES_FILE)) : []);
const saveNotes = (n) => writeFileSync(NOTES_FILE, JSON.stringify(n, null, 2));
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const stamp = () => new Date().toLocaleTimeString('es-CL');

async function decoyDeposit() {
  const kp = await newFundedKeypair();
  const { text, leafIndex, hash } = await depositNewNote(keypairSigner(kp));
  const notes = loadNotes();
  notes.push({ note: text, leaf: leafIndex, from: kp.publicKey(), spent: false });
  saveNotes(notes);
  console.log(`${stamp()}  depósito señuelo → hoja ${leafIndex}  tx ${hash.slice(0, 10)}…`);
}

async function decoyWithdraw() {
  const notes = loadNotes();
  const pending = notes.filter((n) => !n.spent);
  if (pending.length === 0) return decoyDeposit();
  const pick = pending[Math.floor(Math.random() * pending.length)];
  const parsed = await parseNote(pick.note);
  if (await isSpent(parsed.nullifierHash)) {
    pick.spent = true;
    saveNotes(notes);
    return;
  }
  // Igual que la app en modo "wallet nueva": la wallet de destino paga su propia fee.
  const kp = await newFundedKeypair();
  const { hash } = await withdrawNote({
    noteText: pick.note,
    recipient: kp.publicKey(),
    signer: keypairSigner(kp),
    zkWasm,
    zkKey,
  });
  pick.spent = true;
  saveNotes(notes);
  console.log(`${stamp()}  retiro señuelo  → wallet ${kp.publicKey().slice(0, 6)}…  tx ${hash.slice(0, 10)}…`);
}

const until = Date.now() + minutes * 60_000;
console.log(`Ruido activo ${minutes} min, cada ${minGap}–${maxGap} s. Ctrl-C para detener.`);
while (Date.now() < until) {
  try {
    // Un poco más de retiros que depósitos para ir gastando las notas señuelo acumuladas.
    if (Math.random() < 0.55) await decoyWithdraw();
    else await decoyDeposit();
  } catch (err) {
    console.error(`${stamp()}  señuelo falló: ${err.message}`);
  }
  await sleep(minGap + Math.random() * (maxGap - minGap));
}
console.log('Ruido terminado.');
