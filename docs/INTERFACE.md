# Interfaces compartidas (contrato entre circuito, contrato Soroban y app)

Todas las piezas DEBEN respetar esto. Si algo es imposible, documenta el cambio aquí mismo y avísalo.

## Curva y hash
- Curva: **BN254** (circom por defecto, `--prime bn128`). Groth16 vía snarkjs.
- Hash: **Poseidon de circomlib** (BN254, el mismo que `circomlibjs.buildPoseidon`).
  - El contrato usa la host function Poseidon de Soroban (Protocolo 25). DEBE dar el mismo resultado que circomlib para `t=2` (1 entrada) y `t=3` (2 entradas). Verifícalo con vectores de prueba de circomlibjs.

## Nota (secreto del empleado)
- `nullifier`, `secret`: 31 bytes aleatorios cada uno (siempre < p).
- `commitment = Poseidon([nullifier, secret])`.
- `nullifierHash = Poseidon([nullifier])`.
- Formato de texto de la nota: `nzk-<denominationStroops>-<nullifierHex62>-<secretHex62>`.

## Merkle tree
- `LEVELS = 10` (1024 hojas). Árbol incremental (estilo Tornado).
- Nodo: `Poseidon([left, right])`.
- `zeros[0] = 0`, `zeros[i] = Poseidon([zeros[i-1], zeros[i-1]])`.
- El contrato guarda las últimas `ROOT_HISTORY = 30` raíces.
- Índice de hoja: orden de inserción, desde 0. Bits del path: `pathIndices[i] = (index >> i) & 1` (0 = el nodo actual va a la izquierda).

## Circuito `withdraw.circom`
- Entradas públicas, en este orden: `root`, `nullifierHash`, `recipient`.
- Entradas privadas: `nullifier`, `secret`, `pathElements[10]`, `pathIndices[10]`.
- `recipient` se restringe con un cuadrado (`recipientSquare <== recipient * recipient`) para que no se pueda alterar.
- `recipient` es un elemento de campo derivado de la dirección G del destinatario:
  `recipient = BigInt('0x' + hex(sha256(ScVal::Address(G).toXDR())) )` con el **primer byte en 0** (o sea, se usan los últimos 31 bytes, big-endian).
  - En JS: `xdr = nativeToScVal(Address.fromString(G)).toXDR()`; `h = sha256(xdr)`; `h[0] = 0`.
  - En Rust: `env.crypto().sha256(&recipient.to_xdr(&env))`; poner el byte 0 en 0.

## Artefactos que produce `circuits/` (los consume la app)
- `app/public/zk/withdraw.wasm`
- `app/public/zk/withdraw_final.zkey`
- `app/public/zk/verification_key.json`
- `circuits/build/vk_soroban.json`: VK codificada para el contrato (ver abajo).

## Codificación para Soroban (BN254, igual que las host functions `bn254_*`)
- Fp: 32 bytes big-endian.
- G1: 64 bytes = `X || Y`.
- G2: 128 bytes = `X.c1 || X.c0 || Y.c1 || Y.c0` (orden estilo Ethereum: primero la parte imaginaria). **Verifícalo contra la documentación de soroban-sdk** y, si difiere, corrige aquí.
- Escalares (entradas públicas): `U256` / 32 bytes big-endian.
- Prueba: `{ a: BytesN<64>, b: BytesN<128>, c: BytesN<64> }`. snarkjs entrega `pi_a`, `pi_b` y `pi_c` en proyectivo; usa x e y (ignora z = 1). OJO: en snarkjs `pi_b[i] = [c0, c1]`.
- La app y `circuits/scripts/` comparten una función `proofToSoroban(proof)` en `app/src/zk/encode.js`.

## API del contrato `contracts/pool` (Soroban, Rust)
```
__constructor(admin: Address, token: Address, denomination: i128, vk: VerificationKey)
deposit(from: Address, commitment: BytesN<32>) -> u32          // require_auth(from); transfiere `denomination` del token al contrato; inserta la hoja; emite el evento ("deposit", commitment, leaf_index)
withdraw(proof: Proof, root: BytesN<32>, nullifier_hash: BytesN<32>, recipient: Address)  // verifica la raíz conocida, que el nullifier no esté usado y la prueba Groth16; transfiere `denomination` a `recipient`
get_root() -> BytesN<32>
is_known_root(root: BytesN<32>) -> bool
is_spent(nullifier_hash: BytesN<32>) -> bool
get_leaves() -> Vec<BytesN<32>>     // todas las hojas en orden, para que el cliente reconstruya el Merkle path (MVP: 1024 como máximo)
denomination() -> i128
```
- `token` = Stellar Asset Contract del XLM nativo en testnet (`stellar contract id asset --asset native --network testnet`).
- `denomination` = 10 XLM = `100_000_000` stroops.
- Tras desplegar, escribe el ID del contrato en `app/src/config.json` como `{ "poolContractId": "C...", "tokenContractId": "C...", "denomination": "100000000", "network": "testnet" }`.

## Función serverless de OpenRouter (`app/api/payroll.js`, Vercel)
- `POST /api/payroll { text: string, denominationXlm: number }` → `{ payments: [{ name, amountXlm, notes }], warnings: [string] }`.
- Usa `process.env.OPENROUTER_API_KEY`. El modelo se configura con `OPENROUTER_MODEL` (por defecto un modelo barato). Nunca expongas la key al cliente.
