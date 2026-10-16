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

## Notas de `circuits/` (implementado, 16 oct)
- **G2 verificado** contra `soroban-sdk 29.0.1` (`src/crypto/bn254.rs`): `X.c1 || X.c0 || Y.c1 || Y.c0`. Sin cambios. (Control: `gamma` de la VK empieza por `198e9393…`, el generador G2 de BN254 en orden Ethereum.)
- **ptau:** los espejos de Hermez (S3 y GCS) devuelven 403. Se usa el Perpetual Powers of Tau de PSE `ppot_0080_13.ptau` (2^13). El circuito tiene 6631 restricciones.
- **Restricción extra:** el circuito comprueba que `nullifier` y `secret` caben en 248 bits (`Num2Bits(248)`), coherente con "31 bytes".
- **Vectores para el contrato** (commiteados con `git add -f`, `circuits/build/` sigue ignorado):
  - `circuits/build/vk_soroban.json`: `{ alpha, beta, gamma, delta, ic: [4] }` en hex.
  - `circuits/build/test-vector.json`: prueba real + `soroban.proof {a,b,c}` + `soroban.publicInputs [root, nullifierHash, recipient]` (hex 32 B BE) + `recipientAddress` y `leaves`. Debe verificar en el contrato.
  - `circuits/build/poseidon-vectors.json`: `Poseidon([1]) = 29176100…0133`, `Poseidon([1,2]) = 115cc0f5…189a`, `zeros[0..10]` y la raíz vacía.
- **¡No vuelvas a correr `build.sh` tras desplegar el contrato!** La contribución del setup es aleatoria: regenera zkey y VK, y el contrato desplegado dejaría de aceptar pruebas. Si se regenera, hay que redesplegar con el nuevo `vk_soroban.json`.
- **API de `app/src/zk/note.js`** (todo async salvo indicación): `createNote(denominationStroops)`, `parseNote(text)`, `serializeNote(note)` (sync), `commitmentOf`, `nullifierHashOf`, `computeZeros()`, `buildMerklePath(leaves, index)`, `computeRoot(leaves)`, `recipientField(G)`, `buildWithdrawInput(note, leaves, G) -> { leafIndex, input }` (listo para `snarkjs.groth16.fullProve(input, '/zk/withdraw.wasm', '/zk/withdraw_final.zkey')`). Las hojas aceptan BigInt, hex o `Uint8Array(32)`. Depende de `circomlibjs` y `@stellar/stellar-sdk` (la app debe tenerlos en sus dependencias).
- **`app/src/zk/encode.js`:** `proofToSoroban(proof) -> {a,b,c}`, `vkToSoroban(vk)`, `publicSignalsToHex(publicSignals)`, `toHex32`, `hexToBytes`, `bytesToHex`.

## Notas del contrato `contracts/pool` (desplegado en testnet)
- **Pool:** `CD3CQAF32DMZ4HRJYQTTFQ2O2KXIEIRP4N6OMFHZFLC25LBBLDR2OBMP` · **SAC XLM:** `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` · admin `nzk-admin`. Redesplegar: `bash contracts/scripts/deploy.sh` (reescribe `app/src/config.json`).
- La codificación G2 de soroban-sdk (`be(X.c1)||be(X.c0)||be(Y.c1)||be(Y.c0)`) coincide con la de arriba: sin cambios.
- `VerificationKey { alpha: BytesN<64>, beta: BytesN<128>, gamma: BytesN<128>, delta: BytesN<128>, ic: Vec<BytesN<64>> }` = el JSON de `vk_soroban.json` (debe tener 4 IC). `Proof { a, b, c }` como `proofToSoroban`.
- Todas las entradas `BytesN<32>` (commitment, root, nullifier_hash) deben ser < r de BN254; si no, `Error #5`.
- Errores: `1 UnknownRoot`, `2 NullifierSpent`, `3 InvalidProof`, `4 TreeFull`, `5 InvalidFieldElement`, `6 InvalidVerificationKey`, `7 InvalidDenomination`.
- Eventos: deposit → topics `["deposit", commitment]`, data `leaf_index: u32`; withdraw → topics `["withdraw", nullifier_hash]`, data `()`.
- `withdraw` no requiere firma de nadie (cualquiera puede enviarlo; la prueba ata el `recipient`). La cuenta G de destino debe existir en la red (el SAC nativo no crea cuentas).
- Poseidon on-chain: crate oficial `soroban-poseidon` 28 (host function `poseidon_permutation` con parámetros de circomlib), verificado contra `poseidon-vectors.json` en `cargo test`.
- Smoke test ya hecho en testnet: hojas 0..2 = las de `test-vector.json` y un withdraw real con esa prueba (nullifier `1c53f739…bb8b` ya gastado). Los depósitos de la app empiezan en el índice 3.
