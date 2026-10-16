import './style.css';
import { Keypair } from '@stellar/stellar-sdk';
import {
  explorerAccount,
  explorerContract,
  explorerTx,
  freighterSigner,
  fundWithFriendbot,
  getXlmBalance,
  isValidG,
  keypairSigner,
  newFundedKeypair,
  short,
} from './lib/stellar.js';
import { denominationXlm, getConfig, hasFileConfig, setPoolOverride } from './lib/config.js';
import { load, logActivity, save, setScope } from './lib/store.js';

// El código ZK (circomlibjs, snarkjs) es pesado: se carga solo cuando hace falta.
const poolLib = () => import('./lib/pool.js');

// ---------------------------------------------------------------- estado
const urlNotes = readNotesFromUrl();
setScope(addressOf(load('company', null)));
const state = {
  tab: urlNotes ? 'empleado' : load('tab', 'empresa'),
  company: load('company', null), // { type: 'local', secret } | { type: 'freighter', address }
  balance: null,
  freighter: null,
  payroll: load('payroll', { text: '', payments: [], warnings: [], model: null }),
  ai: { busy: false, error: null },
  deliveries: load('deliveries', []), // [{ id, name, amountXlm, notes: [{ text, commitment, leafIndex, hash }] }]
  dep: { busy: false, log: [], error: null },
  claim: { text: urlNotes || '', mode: 'new', g: '', busy: false, steps: [], error: null, result: null },
  companyMsg: null,
};

function readNotesFromUrl() {
  const params = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.slice(1));
  const raw = params.get('nota') || hash.get('nota');
  if (!raw) return null;
  // La nota ya quedó en memoria: la sacamos de la barra de direcciones.
  history.replaceState(null, '', location.pathname);
  return splitNotes(raw).join('\n');
}

function splitNotes(text) {
  return String(text)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n).toLocaleString('es', { maximumFractionDigits: 2 });
const $ = (sel) => document.querySelector(sel);

function addressOf(company) {
  if (!company) return null;
  try {
    return company.type === 'local' ? Keypair.fromSecret(company.secret).publicKey() : company.address;
  } catch {
    return null;
  }
}

function companyAddress() {
  return addressOf(state.company);
}

// Cada wallet ve solo su propio historial: al cambiar de wallet se recarga desde su espacio.
function switchScope() {
  setScope(companyAddress());
  state.payroll = load('payroll', { text: '', payments: [], warnings: [], model: null });
  state.deliveries = load('deliveries', []);
  state.dep = { busy: false, log: [], error: null };
}

async function companySigner() {
  if (state.company.type === 'local') return keypairSigner(Keypair.fromSecret(state.company.secret));
  if (!state.freighter) state.freighter = await freighterSigner();
  return state.freighter;
}

// ---------------------------------------------------------------- tema
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme(load('theme', null));
function toggleTheme() {
  const current =
    document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  save('theme', next);
  applyTheme(next);
}

// ---------------------------------------------------------------- render
function render() {
  const tab = state.tab;
  $('#app').innerHTML = `
  <div class="wrap">
    <header class="top">
      <div class="brand">
        <div class="logo">ZK</div>
        <h1>Nómina ZK</h1>
        <span class="pill">testnet</span>
      </div>
      <button class="btn ghost sm" data-act="theme" aria-label="Cambiar tema">◐ Tema</button>
    </header>
    <p class="hero">Paga sueldos en Stellar sin que el ledger revele <strong>quién le paga a quién</strong>.
      La empresa deposita notas de ${fmt(denominationXlm())} XLM en un pool; cada empleado retira con una
      <strong>prueba de conocimiento cero</strong> a una wallet nueva.</p>
    <nav class="tabs" role="tablist">
      ${tabBtn('empresa', 'Empresa')}
      ${tabBtn('empleado', 'Cobrar (empleado)')}
      ${tabBtn('mundo', 'Lo que ve el mundo')}
    </nav>
    ${configBanner()}
    <main>
      ${tab === 'empresa' ? companyView() : tab === 'empleado' ? claimView() : worldView()}
    </main>
  </div>`;
}

const tabBtn = (id, label) =>
  `<button role="tab" data-act="tab" data-tab="${id}" aria-selected="${state.tab === id}">${label}</button>`;

function configBanner() {
  if (getConfig().poolContractId) return '';
  return `<div class="notice warn">El contrato pool todavía no está configurado (falta <span class="mono">app/src/config.json</span>).
    Puedes probar la IA igual, o pegar un ID de contrato en <em>Ajustes avanzados</em> (pestaña Empresa).</div>`;
}

// ---- Empresa
function companyView() {
  return `${companyCard()}${aiCard()}${depositCard()}${deliveriesCard()}${advancedCard()}`;
}

function companyCard() {
  const addr = companyAddress();
  const msg = state.companyMsg ? `<div class="notice ${state.companyMsg.kind}">${esc(state.companyMsg.text)}</div>` : '';
  if (!addr) {
    return `<section class="card">
      <h2><span class="step-n">1</span>Cuenta de la empresa</h2>
      <p class="sub">Crea una cuenta de testnet en este navegador (se fondea con friendbot) o conecta Freighter.</p>
      <div class="row">
        <button class="btn primary" data-act="create-company">Crear cuenta testnet</button>
        <button class="btn" data-act="connect-freighter">Conectar Freighter</button>
      </div>
      ${msg}
    </section>`;
  }
  const local = state.company.type === 'local';
  return `<section class="card">
    <h2><span class="step-n">1</span>Cuenta de la empresa</h2>
    <dl class="kv">
      <dt>Dirección</dt><dd><a class="mono ext" href="${explorerAccount(addr)}" target="_blank" rel="noopener">${esc(addr)}</a></dd>
      <dt>Saldo</dt><dd>${state.balance === null ? '…' : state.balance === undefined ? 'sin fondear' : `${fmt(state.balance)} XLM`}</dd>
      <dt>Firma con</dt><dd>${local ? 'clave local (este navegador)' : 'Freighter'}</dd>
    </dl>
    ${local ? `<div class="notice warn">⚠ La clave secreta está guardada en el <em>localStorage</em> de este navegador. Aceptable solo en <strong>testnet</strong>; nunca lo hagas con fondos reales.</div>` : ''}
    <div class="row">
      <button class="btn sm" data-act="friendbot">Recargar con friendbot</button>
      <button class="btn sm" data-act="refresh-balance">Actualizar saldo</button>
      ${local ? `<button class="btn sm" data-act="connect-freighter">Usar Freighter</button>` : ''}
      <button class="btn sm ghost danger" data-act="forget-company">Olvidar cuenta</button>
    </div>
    ${local ? `<details style="margin-top:10px"><summary>Ver clave secreta (testnet)</summary><p class="mono">${esc(state.company.secret)}</p></details>` : ''}
    ${msg}
  </section>`;
}

function aiCard() {
  const p = state.payroll;
  const den = denominationXlm();
  const totalNotes = p.payments.reduce((s, x) => s + notesFor(x.amountXlm), 0);
  return `<section class="card">
    <h2><span class="step-n">2</span>Asistente de nómina (IA)</h2>
    <p class="sub">Escribe la nómina como se la dirías a una persona. Un modelo vía <strong>OpenRouter</strong> la convierte en pagos y señala alertas. Luego puedes editarla.</p>
    <textarea id="payroll-text" placeholder="Ej.: Paga 30 XLM a Ana, 20 a Bruno y 15 a Carla por el sueldo de octubre.">${esc(p.text)}</textarea>
    <div class="row" style="margin-top:8px">
      <button class="btn primary" data-act="ai" ${state.ai.busy ? 'disabled' : ''}>${state.ai.busy ? 'Interpretando…' : 'Interpretar con IA'}</button>
      <button class="btn" data-act="add-row">+ Agregar fila manual</button>
      ${p.model ? `<span class="muted small">Modelo: ${esc(p.model)}</span>` : ''}
    </div>
    ${state.ai.error ? `<div class="notice err">${esc(state.ai.error)}</div>` : ''}
    ${p.warnings.length ? `<div class="notice warn"><strong>Alertas de la IA</strong><ul>${p.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    ${
      p.payments.length
        ? `<table class="pay">
        <thead><tr><th>Empleado</th><th>XLM</th><th>Notas</th><th></th></tr></thead>
        <tbody>${p.payments
          .map(
            (x, i) => `<tr>
            <td><input data-edit="name" data-i="${i}" value="${esc(x.name)}" aria-label="Nombre"></td>
            <td class="num"><input data-edit="amountXlm" data-i="${i}" type="number" min="0" step="any" inputmode="decimal" value="${esc(x.amountXlm)}" aria-label="Monto"></td>
            <td class="notes" id="notes-${i}">${notesFor(x.amountXlm)}</td>
            <td class="act"><button class="btn sm ghost danger" data-act="del-row" data-i="${i}" aria-label="Eliminar">✕</button></td>
          </tr>`,
          )
          .join('')}</tbody></table>
        <div class="total" id="payroll-total">${totalText(totalNotes, den)}</div>
        <p class="muted small">Cada nota vale ${fmt(den)} XLM; un monto se redondea hacia arriba a notas enteras: notas = ⌈monto / ${fmt(den)}⌉.</p>`
        : ''
    }
  </section>`;
}

const notesFor = (amount) => {
  const a = Number(amount);
  return Number.isFinite(a) && a > 0 ? Math.ceil(a / denominationXlm()) : 0;
};
const totalText = (n, den) => `<span>Total: ${n} nota${n === 1 ? '' : 's'}</span><span>${fmt(n * den)} XLM al pool</span>`;

function depositCard() {
  const p = state.payroll;
  const totalNotes = p.payments.reduce((s, x) => s + notesFor(x.amountXlm), 0);
  const ready = companyAddress() && totalNotes > 0 && getConfig().poolContractId;
  return `<section class="card">
    <h2><span class="step-n">3</span>Depositar en el pool</h2>
    <p class="sub">Por cada nota se genera un secreto en este navegador y se llama a <span class="mono">deposit(from, commitment)</span>. On-chain solo queda el <em>commitment</em> (un hash), nunca el nombre ni el destinatario.</p>
    <button class="btn primary" data-act="deposit" ${!ready || state.dep.busy ? 'disabled' : ''}>
      ${state.dep.busy ? 'Depositando…' : `Depositar ${totalNotes} nota${totalNotes === 1 ? '' : 's'} (${fmt(totalNotes * denominationXlm())} XLM)`}
    </button>
    ${!companyAddress() ? `<p class="muted small">Primero crea o conecta la cuenta de la empresa.</p>` : ''}
    ${state.dep.error ? `<div class="notice err">${esc(state.dep.error)}</div>` : ''}
    ${progressList(state.dep.log)}
  </section>`;
}

function progressList(items) {
  if (!items.length) return '';
  return `<ul class="progress">${items
    .map((s) => `<li class="${s.status}"><span class="ic"></span><span>${esc(s.label)}${s.detail ? ` <span class="muted small">${s.detail}</span>` : ''}</span></li>`)
    .join('')}</ul>`;
}

function shareLink(d) {
  return `${location.origin}/#nota=${d.notes.map((n) => n.text).join(',')}`;
}

function deliveriesCard() {
  if (!state.deliveries.length) return '';
  return `<section class="card">
    <h2><span class="step-n">4</span>Entregar las notas</h2>
    <p class="sub">Envía a cada empleado su link por un canal privado (Signal, en persona…). Con él cobra a una wallet nueva.</p>
    <div class="notice err">🔑 <strong>La nota ES el dinero.</strong> Quien tenga el link puede cobrarla. No la publiques ni la mandes por un canal inseguro.</div>
    ${state.deliveries
      .map(
        (d) => `<div class="emp">
        <h3><span>${esc(d.name)}</span><span class="muted small">${d.notes.length} nota${d.notes.length === 1 ? '' : 's'} · ${fmt(d.notes.length * denominationXlm())} XLM${d.notes.length < d.expected ? ` · ⚠ ${d.expected - d.notes.length} pendientes` : ''}</span></h3>
        ${
          d.notes.length
            ? `<div class="linkbox"><input readonly value="${esc(shareLink(d))}" aria-label="Link para ${esc(d.name)}"><button class="btn sm" data-act="copy" data-id="${d.id}">Copiar</button></div>`
            : '<p class="muted small">Sin notas depositadas.</p>'
        }
      </div>`,
      )
      .join('')}
    <div class="row" style="margin-top:10px"><button class="btn sm ghost danger" data-act="clear-deliveries">Borrar historial de entregas</button></div>
  </section>`;
}

function advancedCard() {
  const cfg = getConfig();
  return `<section class="card">
    <details><summary>Ajustes avanzados</summary>
      <div class="spacer"></div>
      <dl class="kv">
        <dt>Pool</dt><dd>${cfg.poolContractId ? `<a class="mono ext" href="${explorerContract(cfg.poolContractId)}" target="_blank" rel="noopener">${esc(cfg.poolContractId)}</a>` : '—'}</dd>
        <dt>Token</dt><dd class="mono">${esc(cfg.tokenContractId || '—')}</dd>
        <dt>Denominación</dt><dd>${fmt(denominationXlm())} XLM (${esc(cfg.denomination)} stroops)</dd>
        <dt>Origen</dt><dd>${hasFileConfig() ? 'config.json' : 'sin config.json'}</dd>
      </dl>
      <div class="spacer"></div>
      <label class="field" for="pool-override">ID de contrato pool (override local, para pruebas)</label>
      <div class="row"><input class="grow" id="pool-override" placeholder="C…" value="${esc(load('configOverride', {}).poolContractId || '')}">
      <button class="btn sm" data-act="save-override">Guardar</button></div>
    </details>
  </section>`;
}

// ---- Empleado
function claimView() {
  const c = state.claim;
  const count = splitNotes(c.text).length;
  return `<section class="card">
    <h2><span class="step-n">1</span>Tu nota</h2>
    <p class="sub">Pega la nota (o las notas) que te dio la empresa, o abre su link. Nunca sale de tu navegador: solo se envía una prueba ZK.</p>
    <textarea id="claim-text" class="mono" placeholder="nzk-100000000-…">${esc(c.text)}</textarea>
    <p class="muted small" id="claim-count">${count ? `${count} nota${count === 1 ? '' : 's'} · ${fmt(count * denominationXlm())} XLM` : ''}</p>
  </section>
  <section class="card">
    <h2><span class="step-n">2</span>¿A dónde cobras?</h2>
    <div class="row" style="flex-direction:column;align-items:stretch">
      <label class="row"><input type="radio" name="mode" value="new" style="width:auto" ${c.mode === 'new' ? 'checked' : ''}>
        <span><strong>Crear una wallet nueva</strong> (recomendado) — sin historial, imposible de ligar a la empresa.</span></label>
      <label class="row"><input type="radio" name="mode" value="g" style="width:auto" ${c.mode === 'g' ? 'checked' : ''}>
        <span>Usar una dirección G que ya tengo (debe existir en testnet).</span></label>
    </div>
    <div id="g-wrap" style="margin-top:8px;${c.mode === 'g' ? '' : 'display:none'}">
      <input id="claim-g" class="mono" placeholder="G…" value="${esc(c.g)}">
      <p class="muted small">La fee la paga una cuenta efímera fondeada con friendbot, así tu dirección no firma nada.</p>
    </div>
  </section>
  <section class="card">
    <h2><span class="step-n">3</span>Cobrar</h2>
    <p class="sub">Se descarga el Merkle tree del contrato, se genera la prueba Groth16 aquí mismo y se llama a <span class="mono">withdraw(proof, root, nullifier_hash, recipient)</span>.</p>
    <button class="btn primary" data-act="claim" ${c.busy || !getConfig().poolContractId ? 'disabled' : ''}>${c.busy ? 'Cobrando…' : 'Generar prueba y cobrar'}</button>
    ${c.error ? `<div class="notice err">${esc(c.error)}</div>` : ''}
    ${progressList(c.steps)}
    ${claimResult()}
  </section>`;
}

function claimResult() {
  const r = state.claim.result;
  if (!r) return '';
  return `<div class="notice ok"><strong>¡Cobrado!</strong> ${r.count} nota${r.count === 1 ? '' : 's'} (${fmt(r.count * denominationXlm())} XLM) a tu wallet.</div>
    <dl class="kv">
      <dt>Wallet</dt><dd><a class="mono ext" href="${explorerAccount(r.recipient)}" target="_blank" rel="noopener">${esc(r.recipient)}</a></dd>
      ${r.balance != null ? `<dt>Saldo</dt><dd>${fmt(r.balance)} XLM</dd>` : ''}
      ${r.txs.map((h, i) => `<dt>Retiro ${i + 1}</dt><dd><a class="mono ext" href="${explorerTx(h)}" target="_blank" rel="noopener">${short(h, 8)}</a></dd>`).join('')}
    </dl>
    ${
      r.secret
        ? `<div class="notice warn">Guarda la clave secreta de tu wallet nueva: es la única forma de mover esos fondos.<p class="mono" style="margin:6px 0 0">${esc(r.secret)}</p></div>`
        : ''
    }`;
}

// ---- Lo que ve el mundo
function worldView() {
  const acts = load('activity', []);
  const deps = acts.filter((a) => a.type === 'deposit');
  const wds = acts.filter((a) => a.type === 'withdraw');
  const pool = getConfig().poolContractId;
  const poolChip = `<span class="chip pool">pool ${esc(short(pool, 4))}</span>`;
  const txItem = (a, left, right, extra) => `<div class="tx">
    <div class="flow">${left} → ${right}</div>
    <div class="muted small">${extra}</div>
    <a class="ext small" href="${explorerTx(a.hash)}" target="_blank" rel="noopener">tx ${short(a.hash, 6)}</a>
    <span class="muted small"> · ${new Date(a.at).toLocaleString('es')}</span>
  </div>`;
  const acct = (g) => `<a class="chip" href="${explorerAccount(g)}" target="_blank" rel="noopener">${esc(short(g, 4))}</a>`;
  return `<section class="card">
    <h2>Lo que ve el mundo</h2>
    <p class="sub">Esto es todo lo que un observador del ledger puede ver. Abre cada transacción en stellar.expert y compruébalo.</p>
    <div class="world">
      <div class="col"><h3>Depósitos (empresa → pool)</h3>
        ${deps.length ? deps.map((a) => txItem(a, acct(a.from), poolChip, `commitment ${esc(short(a.commitment, 6))} · ${fmt(denominationXlm())} XLM`)).join('') : '<p class="muted small">Aún no hay depósitos desde esta wallet.</p>'}
      </div>
      <div class="col"><h3>Retiros (pool → wallet nueva)</h3>
        ${wds.length ? wds.map((a) => txItem(a, poolChip, acct(a.to), `nullifierHash ${esc(short(a.nullifierHash, 6))} · ${fmt(denominationXlm())} XLM${a.from !== a.to ? ` · fee pagada por ${esc(short(a.from, 4))}` : ''}`)).join('') : '<p class="muted small">Aún no hay retiros desde esta wallet.</p>'}
      </div>
    </div>
    <div class="notice" style="margin-top:12px">
      <strong>¿Por qué no se pueden vincular?</strong>
      <ul>
        <li>El depósito publica un <em>commitment</em> = Poseidon(nullifier, secret). El retiro publica un <em>nullifierHash</em> = Poseidon(nullifier). Sin el secreto no hay forma de relacionar uno con otro.</li>
        <li>La prueba Groth16 demuestra que el retiro corresponde a <em>alguna</em> hoja del Merkle tree, sin decir cuál.</li>
        <li>Todas las notas valen ${fmt(denominationXlm())} XLM, así que el monto tampoco delata a nadie.</li>
        <li>La wallet que recibe es nueva: no tiene historial con la empresa.</li>
      </ul>
    </div>
    ${pool ? `<p class="small">Contrato pool: <a class="mono ext" href="${explorerContract(pool)}" target="_blank" rel="noopener">${esc(pool)}</a></p>` : ''}
  </section>`;
}

// ---------------------------------------------------------------- acciones
async function refreshBalance() {
  const addr = companyAddress();
  if (!addr) return;
  state.balance = null;
  try {
    const b = await getXlmBalance(addr);
    state.balance = b === null ? undefined : b;
  } catch {
    state.balance = undefined;
  }
  if (state.tab === 'empresa') render();
}

const actions = {
  theme: toggleTheme,
  tab(el) {
    state.tab = el.dataset.tab;
    save('tab', state.tab);
    render();
  },

  async 'create-company'() {
    state.companyMsg = { kind: '', text: 'Creando cuenta y pidiendo fondos a friendbot…' };
    render();
    try {
      const kp = await newFundedKeypair();
      state.company = { type: 'local', secret: kp.secret() };
      save('company', state.company);
      switchScope();
      state.companyMsg = { kind: 'ok', text: 'Cuenta creada y fondeada con 10.000 XLM de testnet.' };
    } catch (err) {
      state.companyMsg = { kind: 'err', text: err.message };
    }
    await refreshBalance();
    render();
  },

  async 'connect-freighter'() {
    try {
      state.freighter = await freighterSigner();
      state.company = { type: 'freighter', address: state.freighter.address };
      save('company', state.company);
      switchScope();
      state.companyMsg = { kind: 'ok', text: 'Freighter conectado.' };
    } catch (err) {
      state.companyMsg = { kind: 'err', text: err.message };
    }
    await refreshBalance();
    render();
  },

  async friendbot() {
    state.companyMsg = { kind: '', text: 'Pidiendo fondos a friendbot…' };
    render();
    try {
      await fundWithFriendbot(companyAddress());
      state.companyMsg = { kind: 'ok', text: 'Friendbot respondió.' };
    } catch (err) {
      state.companyMsg = { kind: 'err', text: err.message };
    }
    await refreshBalance();
  },

  'refresh-balance': refreshBalance,

  'forget-company'() {
    if (!confirm('¿Olvidar la cuenta de la empresa en este navegador? Si es una clave local y no la guardaste, se pierde.')) return;
    state.company = null;
    state.freighter = null;
    state.companyMsg = null;
    save('company', null);
    switchScope();
    render();
  },

  async ai() {
    const text = $('#payroll-text').value.trim();
    state.payroll.text = text;
    if (!text) {
      state.ai.error = 'Escribe la nómina primero.';
      return render();
    }
    state.ai = { busy: true, error: null };
    render();
    try {
      const res = await fetch('/api/payroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, denominationXlm: denominationXlm() }),
      });
      const data = await res.json().catch(() => ({ error: `Respuesta inválida del servidor (${res.status})` }));
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      state.payroll = { text, payments: data.payments, warnings: data.warnings || [], model: data.model || null };
      if (!data.payments.length) state.ai.error = 'La IA no encontró pagos en el texto.';
    } catch (err) {
      state.ai.error = `${err.message}. Puedes agregar los pagos a mano.`;
    }
    state.ai.busy = false;
    save('payroll', state.payroll);
    render();
  },

  'add-row'() {
    state.payroll.text = $('#payroll-text')?.value ?? state.payroll.text;
    state.payroll.payments.push({ name: '', amountXlm: denominationXlm() });
    save('payroll', state.payroll);
    render();
  },

  'del-row'(el) {
    state.payroll.text = $('#payroll-text')?.value ?? state.payroll.text;
    state.payroll.payments.splice(Number(el.dataset.i), 1);
    save('payroll', state.payroll);
    render();
  },

  async deposit() {
    const payments = state.payroll.payments.filter((p) => p.name.trim() && notesFor(p.amountXlm) > 0);
    const total = payments.reduce((s, p) => s + notesFor(p.amountXlm), 0);
    if (!total) return;
    if (state.balance != null && state.balance < total * denominationXlm() + 1) {
      state.dep.error = `Saldo insuficiente: necesitas ~${fmt(total * denominationXlm() + 1)} XLM.`;
      return render();
    }
    state.dep = { busy: true, error: null, log: [] };
    render();

    let signer;
    try {
      signer = await companySigner();
    } catch (err) {
      state.dep = { busy: false, error: err.message, log: [] };
      return render();
    }
    const { depositNewNote } = await poolLib();
    const log = state.dep.log;
    for (const p of payments) for (let i = 0; i < notesFor(p.amountXlm); i++) log.push({ label: `${p.name} · nota ${i + 1}`, status: 'wait' });
    render();

    let k = 0;
    const previous = state.deliveries;
    const run = [];
    try {
      for (const p of payments) {
        const delivery = { id: crypto.randomUUID(), name: p.name.trim(), amountXlm: p.amountXlm, expected: notesFor(p.amountXlm), notes: [] };
        run.push(delivery);
        state.deliveries = [...run, ...previous];
        for (let i = 0; i < delivery.expected; i++, k++) {
          const item = log[k];
          item.status = 'run';
          const update = (t) => {
            item.detail = esc(t);
            render();
          };
          update('Iniciando…');
          const note = await depositNewNote(signer, update);
          // Guardar de inmediato: la nota ya representa fondos en el pool.
          delivery.notes.push(note);
          save('deliveries', state.deliveries);
          logActivity({ type: 'deposit', hash: note.hash, from: signer.address, commitment: note.commitment });
          item.status = 'ok';
          item.detail = `hoja #${note.leafIndex ?? '?'} · <a class="ext" href="${explorerTx(note.hash)}" target="_blank" rel="noopener">tx ${short(note.hash, 6)}</a>`;
          render();
        }
      }
    } catch (err) {
      if (log[k]) log[k].status = 'err';
      state.dep.error = `Falló el depósito: ${err.message}`;
    }
    state.deliveries = state.deliveries.filter((d) => d.notes.length);
    save('deliveries', state.deliveries);
    state.dep.busy = false;
    await refreshBalance();
    render();
  },

  async copy(el) {
    const d = state.deliveries.find((x) => x.id === el.dataset.id);
    if (!d) return;
    try {
      await navigator.clipboard.writeText(shareLink(d));
      el.textContent = '¡Copiado!';
    } catch {
      el.previousElementSibling.select();
      el.textContent = 'Selecciónalo y copia';
    }
    setTimeout(() => (el.textContent = 'Copiar'), 1500);
  },

  'clear-deliveries'() {
    if (!confirm('Esto borra las notas guardadas en este navegador. Si un empleado aún no cobró y no le enviaste su link, ese dinero se pierde. ¿Continuar?')) return;
    state.deliveries = [];
    save('deliveries', []);
    render();
  },

  'save-override'() {
    setPoolOverride($('#pool-override').value.trim());
    render();
  },

  async claim() {
    const c = state.claim;
    c.text = $('#claim-text').value;
    c.g = $('#claim-g')?.value.trim() || '';
    const notes = splitNotes(c.text);
    c.error = null;
    c.result = null;
    if (!notes.length) {
      c.error = 'Pega al menos una nota.';
      return render();
    }
    if (c.mode === 'g' && !isValidG(c.g)) {
      c.error = 'La dirección G no es válida.';
      return render();
    }

    c.busy = true;
    c.steps = [];
    const steps = c.steps;
    const begin = (label) => {
      steps.forEach((s) => s.status === 'run' && (s.status = 'ok'));
      steps.push({ label, status: 'run' });
      render();
      return steps[steps.length - 1];
    };

    try {
      const { parseNote, withdrawNote, isSpent } = await poolLib();
      // Valida el formato y que ninguna nota esté cobrada antes de gastar friendbot o fees.
      const probe = Keypair.random().publicKey();
      for (const n of notes) {
        const parsed = await parseNote(n);
        if (await isSpent(parsed.nullifierHash, probe)) throw new Error('Esta nota ya fue cobrada');
      }

      let recipient;
      let secret = null;
      let feeSigner;
      if (c.mode === 'new') {
        begin('Creando tu wallet nueva y fondeándola con friendbot…');
        const kp = await newFundedKeypair();
        recipient = kp.publicKey();
        secret = kp.secret();
        save('wallets', [...load('wallets', []), { publicKey: recipient, secret }]);
        feeSigner = keypairSigner(kp);
      } else {
        recipient = c.g;
        begin('Comprobando que tu dirección existe en testnet…');
        if ((await getXlmBalance(recipient)) === null) throw new Error('Esa dirección no existe en testnet: fondéala primero con friendbot.');
        begin('Creando una cuenta efímera para pagar la fee…');
        feeSigner = keypairSigner(await newFundedKeypair());
      }

      const txs = [];
      for (let i = 0; i < notes.length; i++) {
        const prefix = notes.length > 1 ? `Nota ${i + 1}/${notes.length}: ` : '';
        let current = null;
        const { hash, nullifierHash } = await withdrawNote({
          noteText: notes[i],
          recipient,
          signer: feeSigner,
          onStep: (key, text) => {
            if (!current || current.key !== key) {
              current = begin(prefix + text);
              current.key = key;
            } else {
              current.label = prefix + text;
              render();
            }
          },
        });
        txs.push(hash);
        logActivity({ type: 'withdraw', hash, from: feeSigner.address, to: recipient, nullifierHash });
      }
      steps.forEach((s) => (s.status = 'ok'));
      const balance = await getXlmBalance(recipient).catch(() => null);
      c.result = { recipient, secret, txs, count: notes.length, balance };
    } catch (err) {
      const last = steps[steps.length - 1];
      if (last) last.status = 'err';
      c.error = err.message;
    }
    c.busy = false;
    render();
  },
};

// ---------------------------------------------------------------- eventos
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el);
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.edit) {
    const row = state.payroll.payments[Number(el.dataset.i)];
    row[el.dataset.edit] = el.dataset.edit === 'amountXlm' ? Number(el.value) : el.value;
    save('payroll', state.payroll);
    const cell = $(`#notes-${el.dataset.i}`);
    if (cell) cell.textContent = notesFor(row.amountXlm);
    const total = state.payroll.payments.reduce((s, x) => s + notesFor(x.amountXlm), 0);
    $('#payroll-total').innerHTML = totalText(total, denominationXlm());
    const btn = document.querySelector('[data-act="deposit"]');
    if (btn && !state.dep.busy) {
      btn.textContent = `Depositar ${total} nota${total === 1 ? '' : 's'} (${fmt(total * denominationXlm())} XLM)`;
      btn.disabled = !(companyAddress() && total > 0 && getConfig().poolContractId);
    }
  } else if (el.id === 'payroll-text') {
    state.payroll.text = el.value;
    save('payroll', state.payroll);
  } else if (el.id === 'claim-text') {
    state.claim.text = el.value;
    const n = splitNotes(el.value).length;
    $('#claim-count').textContent = n ? `${n} nota${n === 1 ? '' : 's'} · ${fmt(n * denominationXlm())} XLM` : '';
  } else if (el.id === 'claim-g') {
    state.claim.g = el.value.trim();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.name === 'mode') {
    state.claim.mode = e.target.value;
    $('#g-wrap').style.display = state.claim.mode === 'g' ? '' : 'none';
  }
});

render();
refreshBalance();
