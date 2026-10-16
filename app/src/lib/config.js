// app/src/config.json lo escribe el despliegue del contrato. Se carga con glob para que
// la app compile aunque todavía no exista; un override en localStorage sirve para pruebas.
const found = import.meta.glob('../config.json', { eager: true, import: 'default' });
const fileConfig = Object.values(found)[0] || {};
const OVERRIDE_KEY = 'nzk.configOverride';

const DEFAULTS = { poolContractId: '', tokenContractId: '', denomination: '100000000', network: 'testnet' };

function readOverride() {
  try {
    return JSON.parse(localStorage.getItem(OVERRIDE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function getConfig() {
  const o = readOverride();
  const cfg = { ...DEFAULTS, ...fileConfig };
  if (o.poolContractId) cfg.poolContractId = o.poolContractId;
  return cfg;
}

export const hasFileConfig = () => Boolean(fileConfig.poolContractId);
export const denominationXlm = () => Number(getConfig().denomination) / 1e7;

export function setPoolOverride(id) {
  try {
    if (id) localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ poolContractId: id }));
    else localStorage.removeItem(OVERRIDE_KEY);
  } catch {}
}
