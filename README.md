# Nómina ZK

Pago de sueldos **privado e irrastreable** en Stellar testnet, con un circuito ZK, un contrato Soroban y una app web construidos desde cero.

En un ledger público, pagar sueldos expone quién trabaja para quién y cuánto gana. Nómina ZK usa un *privacy pool* propio al estilo Tornado: la empresa deposita notas de monto fijo (10 XLM) y cada empleado retira la suya a una **wallet nueva** con una prueba Groth16 generada en su navegador. On-chain se ve "la empresa depositó N notas" y "alguien retiró una nota a la wallet X", pero no hay vínculo entre ambos.

> Solo testnet. No uses esto con fondos reales.

## En vivo

- **App:** https://nomina-zk.vercel.app
- **Contrato pool (testnet):** [`CD3CQAF32DMZ4HRJYQTTFQ2O2KXIEIRP4N6OMFHZFLC25LBBLDR2OBMP`](https://stellar.expert/explorer/testnet/contract/CD3CQAF32DMZ4HRJYQTTFQ2O2KXIEIRP4N6OMFHZFLC25LBBLDR2OBMP)
- **Pago irrastreable verificado on-chain:** retiro [`76a097c2…cd6c9702`](https://stellar.expert/explorer/testnet/tx/76a097c2b65f1b693363b97689aa0b84f7ee4a7ba37368bef8d9ccdfcd6c9702) a una wallet nueva ([`GB2P…AYGI`](https://stellar.expert/explorer/testnet/account/GB2P2NMR4ZQWKDRZEICAP2G5QEST2OVS6XSJJ6ONFVOR3O7HLKFUAYGI)), cuyo historial solo muestra a Friendbot y al contrato, nunca a la empresa.
- Explicación para principiantes: [docs/EXPLICACION.md](docs/EXPLICACION.md) · PRD: [docs/PRD.md](docs/PRD.md)

## Cómo funciona

1. **Asistente de nómina (IA).** La empresa escribe la nómina en lenguaje natural ("paga 30 XLM a Ana y 20 a Bruno"). La función serverless `/api/payroll` llama a la API de **OpenRouter**, que la convierte en una lista de pagos y señala alertas (duplicados, montos atípicos). Cada empleado recibe `⌈monto / 10⌉` notas.
2. **Depósito.** Por cada nota, el navegador genera `nullifier` y `secret` aleatorios y llama a `deposit(from, commitment)` con `commitment = Poseidon(nullifier, secret)`. El contrato inserta el commitment en un Merkle tree on-chain.
3. **Entrega.** La empresa le pasa a cada empleado un link `/#nota=nzk-…` (el fragmento `#` nunca llega al servidor) por un canal privado. **La nota es el dinero.**
4. **Retiro.** El empleado abre el link; la app crea una wallet nueva (friendbot), descarga las hojas con `get_leaves`, arma el Merkle path, genera la prueba Groth16 con snarkjs y llama a `withdraw(proof, root, nullifier_hash, recipient)`. El contrato verifica la prueba (host functions BN254), marca el `nullifierHash` como gastado y transfiere 10 XLM.
5. **Lo que ve el mundo.** La app enlaza cada transacción en stellar.expert: el depósito muestra un commitment y el retiro un nullifierHash, y no hay forma de relacionarlos sin el secreto.

## Arquitectura

```
circuits/   withdraw.circom (Groth16, BN254, Poseidon, Merkle de 10 niveles)
   │         → trusted setup local → app/public/zk/{withdraw.wasm, withdraw_final.zkey}
   │         → VK codificada para Soroban (circuits/build/vk_soroban.json)
   ▼
contracts/  pool (Soroban, Rust): Merkle tree incremental + nullifiers + verificador Groth16
   │         con las host functions bn254_* y Poseidon del Protocolo 25
   │         → desplegado en testnet → app/src/config.json
   ▼
app/        Vite + JS vanilla
             src/main.js       UI (Empresa · Cobrar · Lo que ve el mundo)
             src/lib/stellar.js  RPC Soroban, friendbot, Freighter, firma y reintentos
             src/lib/pool.js     deposit / withdraw / get_leaves
             src/zk/            notas, Merkle path, recipient y codificación de pruebas
             api/payroll.js     función serverless → OpenRouter (la key nunca llega al cliente)
```

Los formatos compartidos (nota, Merkle, codificación BN254, API del contrato) están en [docs/INTERFACE.md](docs/INTERFACE.md). El problema y el alcance, en [docs/PRD.md](docs/PRD.md).

## Correrlo en local

Requisitos: Node 20+.

```bash
cd app
npm install
cp .env.example .env.local   # y pon tu OPENROUTER_API_KEY
npm run dev
```

Abre http://localhost:5173. En desarrollo, un middleware de Vite sirve `/api/payroll` con el mismo handler que Vercel y lee `app/.env.local`.

Variables:

| Variable | Uso |
| --- | --- |
| `OPENROUTER_API_KEY` | Key de OpenRouter (solo servidor). |
| `OPENROUTER_MODEL` | Modelo; por defecto `openai/gpt-4o-mini`. |

Para reconstruir el circuito o redesplegar el contrato, ver `circuits/` y [contracts/README.md](contracts/README.md). Si se rehace el trusted setup cambia la VK y hay que redesplegar el contrato.

## Desplegar en Vercel

1. Importa el repo en Vercel y fija **Root Directory = `app`** (framework Vite; build `npm run build`, output `dist`, funciones en `app/api/`; todo está en `app/vercel.json`).
2. En *Settings → Environment Variables* agrega `OPENROUTER_API_KEY` (y opcionalmente `OPENROUTER_MODEL`).
3. Deploy. O, desde la CLI: `cd app && vercel --prod`.

## Demo rápida

1. **Empresa** → *Crear cuenta testnet* (se fondea con friendbot).
2. Escribe la nómina → *Interpretar con IA* → revisa o edita → *Depositar*.
3. Copia el link de un empleado y ábrelo en otra ventana → *Generar prueba y cobrar*.
4. **Lo que ve el mundo** → abre ambas transacciones en stellar.expert.

## Límites conocidos (MVP)

- Árbol de 1024 hojas y `get_leaves` devuelve todas las hojas.
- Sin relayer: la fee del retiro la paga la wallet nueva (o una cuenta efímera, ambas fondeadas con friendbot).
- Si un empleado retira varias notas a la misma wallet, el total queda a la vista en esa wallet.
- Las notas y la clave de la empresa se guardan en el `localStorage` del navegador (aceptable solo en testnet).
- Trusted setup de una sola parte, hecho localmente.
