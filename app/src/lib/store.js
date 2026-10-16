// Persistencia local (solo testnet). Todo vive en el localStorage de este navegador.
const PREFIX = 'nzk.';

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {}
}

/** Registro de transacciones para la vista "Lo que ve el mundo". */
export function logActivity(entry) {
  const list = load('activity', []);
  list.unshift({ ...entry, at: Date.now() });
  save('activity', list.slice(0, 200));
}
