# Nómina ZK explicada para principiantes

No necesitas saber nada de blockchain ni de criptografía. Aquí va la idea, con ejemplos de todos los días.

## 1. El problema: el libro contable en la plaza

Una blockchain pública es un libro contable pegado en la plaza del pueblo. Todos pueden leerlo, y nadie puede borrar ni cambiar lo escrito.

Si una empresa paga sueldos ahí, es como pegar en la plaza la liquidación de sueldo de cada persona: quién trabaja para quién y cuánto gana. Basta que alguien sepa que una cuenta es tuya para ver todo tu historial. Eso te vuelve blanco de robos o extorsión.

## 2. La idea: la alcancía común

Imagina una alcancía grande en la plaza. Todos echan billetes iguales de 10 XLM. Cuando alguien saca un billete, nadie sabe cuál echó quién.

Eso es un *privacy pool*. **Todas las notas valen lo mismo** porque, si una valiera 37 y otra 12, el monto las delataría ("el que sacó 37 es Ana"). Con montos iguales, todos los billetes se ven idénticos. Si Ana gana 30, la empresa echa 3 billetes de 10.

## 3. La nota secreta: el ticket del guardarropa

Al depositar, la empresa crea una **nota**: dos números al azar, `nullifier` y `secret`. Es como el ticket del guardarropa o la boleta de una casa de empeño: quien llega con el ticket se lleva el abrigo.

Con esos dos números se arma el **commitment**, que es un sobre sellado: `Poseidon(nullifier, secret)`. Poseidon es una "licuadora" matemática: desde el resultado no puedes volver a lo que entró. El sobre va al pool; los dos números quedan fuera.

**La nota ES el dinero.** Quien la tenga puede cobrar, y quien la pierda pierde el dinero.

## 4. El Merkle tree: la lista de sobres

El contrato guarda todos los sobres en un **Merkle tree**: un árbol genealógico de hashes. Los sobres son las hojas. Cada par se mezcla y da un "padre", los padres se mezclan en pares, y así hasta una sola **raíz** arriba (10 niveles, hasta 1.024 sobres).

Para probar que tu sobre está en la lista no hace falta mostrar la lista entera. Basta mostrar los "hermanos" del camino hasta la raíz. Si al recalcular llegas a la raíz oficial, tu sobre está dentro. Y lo mejor: puedes hacerlo sin decir cuál es.

## 5. La prueba de conocimiento cero

Una **prueba de conocimiento cero** demuestra que sabes algo sin mostrar ese algo.

- Es como demostrar que eres mayor de edad sin mostrar tu fecha de nacimiento.
- O como el cartón agujereado de ¿Dónde está Wally?: pones un cartón con un solo hueco sobre la página y muestras a Wally por el hueco. Se ve que lo encontraste, pero no dónde está en la página.

Nuestro circuito (`circuits/withdraw.circom`) demuestra tres cosas a la vez: (1) conoces el `nullifier` y el `secret` de algún sobre, (2) ese sobre está en el árbol, y (3) el pago va a esta wallet y no a otra. **Groth16** es la receta matemática que produce una prueba diminuta, que se verifica rápido. La prueba **se genera en el navegador del empleado**, así que el secreto nunca sale de su computador.

## 6. El nullifierHash: el timbre de "cobrado"

Si la prueba no dice qué sobre es, ¿qué impide cobrar dos veces? El **nullifierHash**, que viene del `nullifier` de la nota. Es como el timbre de "COBRADO" en un cheque, con una diferencia: el timbre queda registrado, pero no dice qué cheque era.

Al retirar, el contrato anota ese número en una lista. Si alguien intenta cobrar con la misma nota, el número ya está y se rechaza. Y como nadie puede unir ese número con un sobre, el anonimato se mantiene.

## 7. El contrato Soroban: el notario automático

Un **contrato inteligente** es un programa en la blockchain que nadie puede sobornar ni alterar. El nuestro (en la red Stellar, plataforma Soroban) funciona como un cajero o notario automático: revisa la prueba, revisa que el timbre no esté usado y, si todo calza, paga 10 XLM a la wallet indicada.

Todo esto corre en **testnet**, la red de práctica de Stellar. Sus monedas son "dinero de Monopoly": no valen nada, pero funcionan igual.

## 8. Dónde entra la IA

La empresa escribe: *"paga 30 a Ana y 20 a Bruno"*. Un modelo de IA vía OpenRouter hace de secretaria: lo convierte en una planilla (Ana: 3 notas, Bruno: 2 notas) y avisa si algo se ve raro (montos atípicos, nombres repetidos). La llamada pasa por un servidor, así que la clave de la IA nunca llega al navegador. La IA no ve ningún secreto ni mueve plata.

## 9. El recorrido completo

```
 EMPRESA                      POOL (contrato)                 EMPLEADO
    |                                |                             |
 1. escribe la nómina (IA)           |                             |
 2. crea notas y sobres  ---------->  guarda los sobres            |
    (deposita 10 XLM c/u)            |  en el árbol                |
 3. entrega la nota en privado ----------------------------------> |
    (link o código, fuera de la cadena)                            |
    |                                |        4. genera la prueba  |
    |                                |           en su navegador   |
    |                                | <---- 5. envía prueba ----- |
    |                                | 6. verifica, anota el timbre|
    |                                |    y paga 10 XLM ---------> wallet nueva
```

| Lo que ve el mundo | Lo que queda oculto |
|---|---|
| La empresa depositó N notas | Qué nota es de quién |
| Alguien retiró 10 XLM a una wallet nueva | Qué depósito originó ese retiro |
| Un timbre (nullifierHash) quedó registrado | A qué nota corresponde ese timbre |
| Todos los montos son de 10 XLM | Cuánto gana cada persona en total |

## 10. Límites honestos

- **Solo testnet y sin auditar.** Es una demo de hackathon, no la uses con plata real.
- **Pocos depósitos, poco anonimato.** Si el pool tiene 2 notas, tu "multitud" es de 2 personas. Mientras más gente, mejor.
- **Quien pierde la nota pierde el dinero.** No hay botón de "olvidé mi contraseña".
- **La empresa sí sabe a quién le dio cada nota.** La privacidad es frente al público, no frente a quien reparte las notas.
- **La wallet nueva necesita algo de XLM para pagar la comisión.** Si la fondeas desde tu cuenta conocida, creas un vínculo. En este MVP no hay *relayer* que lo resuelva.
- **Contexto legal.** Tornado Cash fue un pool parecido. En 2022 la OFAC (la oficina de sanciones de EE. UU.) lo sancionó. En noviembre de 2024, en *Van Loon v. Treasury*, un tribunal de apelaciones de EE. UU. dijo que la OFAC se había excedido al sancionar contratos inmutables. Aun así, el debate sigue vivo. Por eso los privacy pools modernos agregan **cumplimiento normativo**: cada usuario puede probar que sus fondos no vienen de listas negras sin revelar nada más. Este proyecto no incluye eso todavía.

## 11. Glosario

- **Blockchain:** libro contable público que nadie puede borrar ni alterar.
- **Wallet:** tu "cuenta" en la blockchain, identificada por una dirección.
- **XLM:** la moneda de la red Stellar.
- **Testnet:** red de práctica con monedas sin valor real.
- **Hash:** huella digital de un dato: sale siempre igual, pero no se puede deshacer.
- **Poseidon:** el tipo de hash que usamos, pensado para ser barato dentro de pruebas ZK.
- **Commitment:** el sobre sellado que se guarda en el pool.
- **Nullifier / secret:** los dos números secretos que forman tu nota.
- **Nullifier hash:** el timbre de "cobrado" que impide cobrar dos veces.
- **Merkle tree:** árbol de hashes que permite probar que algo está en una lista.
- **Prueba ZK (Groth16):** demostración de que sabes algo sin revelarlo, corta y rápida de verificar.
- **Contrato Soroban:** programa automático en Stellar que verifica la prueba y paga.
