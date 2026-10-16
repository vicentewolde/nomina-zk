# PRD — Nómina ZK (pago de sueldos privado e irrastreable en Stellar testnet)

**Hackathon de Privacidad · Tellus Hub · 16 oct 2026 · solo testnet**

## Problema
En un ledger público, pagar sueldos expone quién trabaja para quién y cuánto gana. Basta vincular una wallet con una persona para exponer todo su historial y convertirla en blanco de robo o extorsión.

## Solución
Un *privacy pool* propio, construido desde cero, al estilo Tornado Cash:
1. **Depósito (empresa):** la empresa deposita notas de monto fijo en el pool. Cada nota es `commitment = Poseidon(nullifier, secret)` y se inserta en un Merkle tree on-chain.
2. **Entrega:** la empresa entrega a cada empleado su nota secreta fuera de la cadena (link o código).
3. **Retiro (empleado):** el empleado demuestra con una prueba Groth16 (generada en su navegador) que posee *alguna* nota del árbol, sin revelar cuál, y retira a una wallet nueva. El `nullifierHash` impide gastar la nota dos veces.

Resultado: on-chain se ve "la empresa depositó N notas" y "alguien retiró una nota a la wallet X", pero no hay vínculo entre ambos. Todas las notas valen lo mismo, así que el monto tampoco las delata.

## OpenRouter en el flujo de pago
Antes de depositar, la empresa escribe la nómina en lenguaje natural ("paga 30 XLM a Ana y 20 a Bruno"). Un modelo vía la API de OpenRouter la convierte en una lista estructurada de pagos y señala posibles alertas (montos atípicos, duplicados). Ese resultado define cuántas notas se depositan por empleado. La llamada pasa por una función serverless (`/api/payroll`), así que la API key nunca llega al navegador.

## Alcance (MVP del hackathon)
- Circuito Circom propio (`circuits/withdraw.circom`), con su trusted setup local.
- Contrato Soroban propio: pool + verificador Groth16 sobre BN254 (host functions del Protocolo 25) + Merkle tree con Poseidon.
- Desplegado en **Stellar testnet**.
- App web (Vite) desplegada en **Vercel**: asistente de nómina con IA, depósito, entrega de notas y retiro con prueba generada en el navegador.

## Fuera de alcance
Mainnet, auditoría, relayer para pagar fees y montos variables por nota.

## Criterio de éxito
Un pago de testnet de empresa a empleado en el que el explorador no permita vincular el depósito con el retiro, verificado on-chain por nuestro contrato.
