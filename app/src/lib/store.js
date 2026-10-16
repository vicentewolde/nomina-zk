// Persistencia local (solo testnet). Todo vive en el navegador; no hay servidor con historial.
//
// El historial (nómina, notas entregadas, actividad, wallets de cobro) se guarda POR WALLET:
// quien conecta otra wallet en este mismo navegador no ve lo de las demás. Sin wallet
// conectada, el historial va a sessionStorage y desaparece al cerrar la pestaña.
const PREFIX = 'nzk.';
const SCOPED = new Set(['payroll', 'deliveries', 'activity', 'wallets']);
let scope = null;

function slot(key) {
  if (!SCOPED.has(key)) return { storage: localStorage, name: PREFIX + key };
  if (scope) return { storage: localStorage, name: `${PREFIX}w.${scope}.${key}` };
  return { storage: sessionStorage, name: `${PREFIX}guest.${key}` };
}

/** Cambia la wallet dueña del historial (null = invitado, solo esta pestaña). */
export function setScope(address) {
  scope = address || null;
  if (scope) migrateLegacy();
}

// Versiones anteriores guardaban el historial sin dueño: se lo asignamos a la primera wallet.
function migrateLegacy() {
  try {
    for (const key of SCOPED) {
      const legacy = localStorage.getItem(PREFIX + key);
      if (legacy === null) continue;
      const target = `${PREFIX}w.${scope}.${key}`;
      if (localStorage.getItem(target) === null) localStorage.setItem(target, legacy);
      localStorage.removeItem(PREFIX + key);
    }
  } catch {}
}

export function load(key, fallback) {
  try {
    const { storage, name } = slot(key);
    const raw = storage.getItem(name);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    const { storage, name } = slot(key);
    if (value === undefined || value === null) storage.removeItem(name);
    else storage.setItem(name, JSON.stringify(value));
  } catch {}
}

/** Registro de transacciones para la vista "Lo que ve el mundo" (solo de la wallet actual). */
export function logActivity(entry) {
  const list = load('activity', []);
  list.unshift({ ...entry, at: Date.now() });
  save('activity', list.slice(0, 200));
}
