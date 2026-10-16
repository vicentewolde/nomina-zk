# Revisión adversarial de Nómina ZK (16 oct 2026)

Revisé el código (circuito, contrato, app y `/api/payroll`) y probé en vivo como lo haría el jurado en https://nomina-zk.vercel.app: creé una empresa, armé la nómina con la IA ("Paga 10 XLM a Ana"), deposité 1 nota y cobré a una wallet nueva. Después intenté vincular la empresa con la wallet usando solo RPC/Horizon/stellar.expert.

**Veredicto actualizado (re-verificación, 22:14 UTC, tras `def6190`/`776e856`): ¿puede el jurado rastrear el pago? No. Con el tráfico señuelo activo, el jurado no puede probar el vínculo; lo mejor que logra es una apuesta de 1 entre 3 por timing.** Ver la sección "Re-verificación" al final.

*Veredicto original (21:58 UTC): sí, con alta confianza. Los señuelos del CLI no tenían `timebounds`, las tx de la app sí, y no había retiros señuelo.*

## Prueba en vivo (lo que ve un analista)

| Hora (UTC) | Tx | Cuenta fuente | Qué publica |
|---|---|---|---|
| 21:56:22 | `5a9ccc58ec…` | friendbot `GAIH3U…` | `create_account` de la empresa `GALPD3CZ…F5XW` (10.000 XLM) |
| 21:56:47 | `0d61b8cc7a72f2cd2ed260e95168a917bb06a639a3daa4b1c8863ea76461083b` | empresa `GALPD3…` | `deposit(from=GALPD3…, commitment=163688a6…)`, evento `["deposit", commitment]` → hoja **24**, transferencia SAC de 10 XLM empresa→pool, `timebounds.max_time` = firma + 120 s |
| 21:57:17 | `7d03f53479…` | friendbot | `create_account` de la wallet `GDF3R3I7…6Q6Z` |
| 21:57:22 | `41c0e36046c2e93c4fe89e09a3076b332c8666d7febfe79b566715823992d05f` | wallet `GDF3R3…` (paga su propia fee) | `withdraw(proof, root, nullifier_hash=2e1bad67…, recipient=GDF3R3…)`, evento `["withdraw", nh]`, 10 XLM pool→wallet; sin memo, sin auth entries; `root` = raíz del árbol con **27 hojas** |

- Cobro completo, incluido friendbot, en **18,7 s**. El AI parseó bien (modelo `openai/gpt-4o-mini`).
- **Doble cobro desde la UI:** "Esta nota ya fue cobrada" ✅. Antes de mostrar el error crea y fondea otra wallet (ver I5).
- **Contra el contrato** (simulando con la prueba real de `41c0e3…`):
  - replay → `Error(Contract, #2)` NullifierSpent
  - raíz falsa → `#1` UnknownRoot
  - otro nullifierHash con la misma prueba → `#3` InvalidProof
  - cambiar el `recipient` (front-run) → `#3` InvalidProof

  El contrato y el circuito son sólidos.
- **Móvil (375 px):** sin scroll horizontal y el layout está correcto.

## CRÍTICO

### C1. Los señuelos se distinguen de las tx reales y no hay retiros señuelo
- **Qué pasa:** `invokeContract` (`app/src/lib/stellar.js:126`, `.setTimeout(120)`) pone `timebounds` en cada tx de la app. `scripts/seed-pool.mjs` usa `stellar contract invoke` y sus tx salen **sin timebounds**. En Horizon (`/transactions/<hash>` → `preconditions.timebounds`) la separación es perfecta:
  - Con timebounds (app): `3740607209`, `3d5cb4e8b5`, `498cbc304d`, `e28e23c2e8`, `165250ff3a`, `76a097c2b6`, `f8b4c2039f`, `8f03a78263`, `0d61b8cc7a` (jurado), `41c0e36046` (jurado).
  - Sin timebounds: los 28 señuelos.
  - Entre 21:47 y 21:58 la única tx de depósito "de la app" es la del jurado, y el único retiro es el suyo, 35 s después. Vínculo directo.
- Además todos los retiros del pool vienen de la app: no existe ningún retiro señuelo.
- **Corrección:**
  1. Que `seed-pool.mjs` use el mismo código que la app: importar `depositNewNote` de `app/src/lib/pool.js` con `keypairSigner(Keypair)`, para que tenga el mismo `BASE_FEE`, el mismo `prepareTransaction` y el mismo `setTimeout(120)`. El CLI no debe enviar tx.
  2. Lanzar durante la demo un bucle de señuelos que haga **depósitos y retiros** (`withdrawNote` con las notas de `.seed-notes.json` hacia wallets nuevas de friendbot), uno cada 20–90 s al azar, para que alrededor del retiro del jurado haya otros retiros iguales.
  3. Verificarlo con el filtro de arriba: no debe quedar ninguna diferencia en `timebounds`, `max_fee` ni en la cantidad de operaciones.

### C2. En producción la nota viaja al servidor (`?nota=`)
- **Qué pasa:** el bundle en vivo (`/assets/index-DskG8urv.js`) genera `${origin}/?nota=…`. Al abrir el link, el navegador hizo `GET https://nomina-zk.vercel.app/?nota=…` (capturado en el panel de red). Consecuencias:
  - La nota completa queda en los logs de Vercel: quien tenga acceso al proyecto puede **cobrar y vincular** cada pago.
  - Las revalidaciones de `/assets/*` llevan la URL completa en el `Referer`, porque es same-origin.
  - Los previsualizadores de links de WhatsApp, Slack y otros también piden esa URL.
- El cambio a `#nota=` ya está commiteado (`83f6949`, `app/src/main.js:225`), pero producción sigue sirviendo `index-DskG8urv.js` con `?nota=`: **no está desplegado**.
- **Corrección:**
  1. Desplegar `83f6949`.
  2. Agregar `<meta name="referrer" content="no-referrer">` en `app/index.html` y un header `Referrer-Policy: no-referrer` en `app/vercel.json`.
  3. Tras desplegar, comprobar con `curl -s https://nomina-zk.vercel.app/assets/index-*.js | grep -o '/[?#]nota='` que salga `#nota=`.
  4. Las notas ya repartidas con `?nota=` deben considerarse expuestas.

## IMPORTANTE

### I1. Correlación por tiempo: todos los cobros llegan ~35 s después del depósito
- **Qué pasa:** en los tres casos que hay, el retiro llega 35 s después del depósito:
  - `3d5cb4e8b5` (21:42:47) → `498cbc304d` (21:43:22)
  - `165250ff3a` (21:46:37) → `76a097c2b6` (21:47:12)
  - `0d61b8cc7a` (21:56:47) → `41c0e36046` (21:57:22)

  La `root` del withdraw también revela cuántas hojas había al probar (`41c0e3…` → 27), así que el depósito está entre las hojas 0–26. Eso es normal en Tornado, pero sumado al tiempo achica mucho el conjunto.
- **Corrección:**
  - En la demo, que la empresa deposite antes de la presentación o que haya varios depósitos y retiros señuelo entre medio (C1).
  - En la UI de cobro, un aviso del tipo "tu anonimato = depósitos no cobrados desde el tuyo: N; espera a que haya más".

### I2. Varias notas por empleado se agrupan
- **Qué pasa:** "30 XLM a Ana" genera 3 depósitos seguidos desde la misma empresa (`main.js:497-517`) y luego 3 retiros seguidos a **la misma wallet**, pagados por la misma cuenta (`main.js:604-623`). Que coincidan la cantidad y la secuencia es una huella clara. Ya pasó en la práctica: `GD2MCE…` hizo 2 depósitos seguidos (`f8b4c2039f`, `8f03a78263`).
- **Corrección:** una wallet nueva por nota (o la opción de hacerlo), con espera aleatoria entre retiros. En la demo, usar 1 nota por empleado.

### I3. La empresa conoce la nota: puede vincular el pago y cobrarlo antes que el empleado
- **Qué pasa:** la nota se genera en el navegador de la empresa (`pool.js:17`). La empresa ve `nullifierHash` y sabe a qué wallet se cobró, y además puede cobrar ella misma. La privacidad es frente a terceros, no frente al empleador. El jurado lo va a preguntar.
- **Corrección:** dejarlo explícito en el pitch. Si da el tiempo, agregar un flujo "el empleado genera la nota y le pasa a la empresa solo el commitment".

### I4. Friendbot es un punto único de falla
- **Qué pasa:** `fundWithFriendbot` (`stellar.js:37`) se llama sin reintentos para crear la empresa y para crear la wallet nueva o la cuenta efímera de la fee. Si friendbot falla, la demo se cae ("Friendbot falló (5xx)"). En mi segundo intento tardó unos 15 s.
- **Corrección:**
  - 3 reintentos con backoff y timeout de 20 s.
  - Si falla, consultar Horizon `/accounts/<G>`: a veces la cuenta se crea aunque la respuesta falle.
  - Mensaje claro con el botón "Reintentar".
  - Tener un plan B preparado: una wallet ya fondeada para el modo "Usar una dirección G".

### I5. El doble cobro gasta friendbot antes de detectarse
- **Qué pasa:** `main.js:588-594` crea y fondea la wallet **antes** de `isSpent` (`pool.js:55`). En el segundo intento se creó una wallet inútil (`nzk.wallets` pasó de 1 a 2) y el error tardó unos 20 s.
- **Corrección:** antes de `newFundedKeypair`, hacer `parseNote` + `isSpent` de todas las notas con una cuenta fuente aleatoria. `readContract` ya lo permite.

## MENOR

- **M1. El texto de la nómina sale a terceros.** Nombres y montos van a OpenRouter/OpenAI (`api/payroll.js:88-104`). No permite vincular on-chain, pero sí expone salarios. Hay que mencionarlo, o reemplazar los nombres por alias antes de enviar y restaurarlos en el cliente.
- **M2. Metadata de red.** En la demo, la empresa y el empleado usan el mismo navegador e IP, así que RPC/Horizon/friendbot (SDF) ven la misma IP. Además `readContract` simula `is_spent`/`get_leaves` usando la wallet nueva como fuente (`pool.js:55-58`). No es visible on-chain. Basta con mencionarlo (relayer o Tor como trabajo futuro).
- **M3. Un depósito duplicado pierde 10 XLM.** Si `sendTransaction` llega a la red pero la respuesta falla, `invokeContract` reintenta (`stellar.js:162-166`) con el mismo commitment. El contrato no rechaza commitments repetidos (`lib.rs:145`), así que se cobran 20 XLM por una sola nota cobrable. **Corrección:** en el contrato, guardar `Commitment(c)` y rechazar repetidos; o en la app, no reintentar tras enviar sin antes consultar `getTransaction`.
- **M4. Errores de contrato sin traducir.** Llegan como `HostError … Error(Contract, #N)`. Mapear 1–7 a español en `invokeContract`, por ejemplo "#1: la raíz quedó vieja, reintenta" (puede pasar si entran más de 30 depósitos entre la prueba y el envío) y "#2: ya cobrada".
- **M5. El saldo de la wallet nueva confunde.** Muestra "10.009,99 XLM": friendbot más el sueldo. Mostrar "Recibiste +10 XLM del pool" aparte.
- **M6. Huella de la wallet nueva.** Su primera operación es un `create_account` de friendbot 5 s antes del withdraw. Eso no la liga a la empresa, pero sí identifica que es una wallet de Nómina ZK.
- **M7. Redondeo hacia arriba.** `⌈monto/10⌉` paga de más (15 → 20 XLM). La IA avisa, pero conviene confirmarlo en la UI antes de depositar.
- **M8. "Lo que ve el mundo" solo usa el localStorage de ese navegador.** Para el jurado sería mejor leer los eventos del pool vía `getEvents`.

## Verificado y correcto

- **Circuito:** `nullifier`/`secret` ≤ 248 bits; `pathIndices` binarios (`DualMux`); `recipient` es entrada pública ligada a la prueba.
- **Contrato:**
  - comprueba que `root` esté entre las últimas 30 raíces y no sea 0;
  - nullifier persistente que se marca antes de transferir;
  - entradas < r;
  - `recipient_field` se calcula on-chain;
  - withdraw sin auth y con `denomination` fija.
- **Por transacción:**
  - deposit expone empresa y commitment, por diseño;
  - withdraw expone wallet, nullifierHash y root.

  No hay memo, y nada en los eventos o argumentos liga un deposit con su withdraw.
- **Fees y fondeo:** la fee del withdraw la paga la wallet nueva o una cuenta efímera, nunca la empresa. Empresa y wallet se fondean con el mismo friendbot `GAIH3U…`, cuyo conjunto de anonimato es enorme.
- **Frontend:** no hay analytics ni scripts de terceros en el bundle. Los únicos hosts son RPC, Horizon, friendbot y stellar.expert. `history.replaceState` limpia la URL.

## Re-verificación (22:12–22:14 UTC, producción con `def6190` + `776e856`)

**Despliegue:**
- El bundle `index-CV3bUAl_.js` genera `#nota=`.
- Header `referrer-policy: no-referrer` y `<meta name="referrer" content="no-referrer">` presentes.
- I5 corregido: `isSpent` se consulta antes de `newFundedKeypair` (`main.js:587` vs `:595`).

**Prueba como jurado:**
- Empresa `GDBNL6NH…ZVPH`, creada por friendbot a las 22:11:52.
- Deposit `dd17276fa8066937d16731ce31b216f908ae93ced23a97d42201ab2e1cbc1cca` a las 22:12:07, hoja 40.
- Link `#nota=…`.
- Withdraw `27bc1e635615b6b8fbbfe56afc95aa19acc301b4e0c29973a48e87a76165e868` a las 22:12:42, hacia la wallet `GBN25GXL…NN3B`, creada a las 22:12:32.
- 44 s en total: la confirmación tardó más con el ruido en la red.

**Intento de vincularlos:**

| Señal | Jurado | Señuelos (`noise.mjs`, desde 22:02) | ¿Distingue? |
|---|---|---|---|
| `timebounds` (max_time − cierre) | 118 s / 114 s | 111–118 s | No |
| `max_fee` deposit / withdraw | 53.594 / 135.086 | 53.489–53.565 / 134.957–135.086 | No (crece igual que en todos) |
| Nº de ops, memo, auth | 1, none, deposit 1 / withdraw 0 | idéntico | No |
| Fondeo de las cuentas | friendbot `GAIH3U…` | friendbot `GAIH3U…` | No |
| Edad de la cuenta al primer uso | empresa 15 s, wallet 10 s | 5–25 s | Débil |
| Raíz del withdraw | árbol con 41 hojas | `69a5da9519` (22:12:32) y `6b60c679ec` (22:13:12) también usan la raíz de 41 hojas | No |
| Timing | withdraw 35 s después del deposit | 3 retiros en los 65 s posteriores a mi depósito | Apuesta 1/3 |

Los retiros señuelo gastan notas viejas (hojas 0–39), así que cualquiera de esos tres puede gastar cualquier hoja no cobrada. Con la criptografía y la metadata on-chain el vínculo no se puede demostrar.

**Riesgos que quedan para la demo:**
1. `noise.mjs` tiene que seguir corriendo durante la presentación (dura 60 min). Si se detiene, vuelve el escenario de C1: un depósito y un retiro solos, a 35 s.
2. Que el jurado deposite y cobre seguido sigue siendo la mejor pista. Si el ruido mete un depósito señuelo entre ambos, o el cobro se hace un minuto después, la apuesta se diluye todavía más.
3. Siguen abiertos I2, I3, M1–M8. No los volví a probar.
