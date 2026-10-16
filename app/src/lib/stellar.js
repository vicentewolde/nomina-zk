import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

export const RPC_URL = 'https://soroban-testnet.stellar.org';
export const HORIZON_URL = 'https://horizon-testnet.stellar.org';
export const FRIENDBOT_URL = 'https://friendbot.stellar.org';
export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const EXPLORER = 'https://stellar.expert/explorer/testnet';

export const server = new rpc.Server(RPC_URL);

export const explorerTx = (hash) => `${EXPLORER}/tx/${hash}`;
export const explorerAccount = (g) => `${EXPLORER}/account/${g}`;
export const explorerContract = (c) => `${EXPLORER}/contract/${c}`;
export const short = (s, n = 4) => (s && s.length > 2 * n + 3 ? `${s.slice(0, n)}…${s.slice(-n)}` : s || '');

export function isValidG(g) {
  try {
    Keypair.fromPublicKey(g);
    return true;
  } catch {
    return false;
  }
}

export async function fundWithFriendbot(address) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(20000) });
      if (res.ok) return true;
      const body = await res.text();
      // Friendbot responde 400 si la cuenta ya existe: no es un error para nosotros.
      if (body.includes('createAccountAlreadyExist') || body.includes('already funded')) return true;
      lastError = new Error(`Friendbot falló (${res.status})`);
    } catch (err) {
      lastError = err;
    }
    // A veces la cuenta se crea aunque la respuesta falle.
    if ((await getXlmBalance(address).catch(() => null)) !== null) return true;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`Friendbot no respondió tras 3 intentos (${lastError?.message ?? 'error'}). Reintenta en unos segundos.`);
}

export async function newFundedKeypair() {
  const kp = Keypair.random();
  await fundWithFriendbot(kp.publicKey());
  return kp;
}

export async function getXlmBalance(address) {
  const res = await fetch(`${HORIZON_URL}/accounts/${address}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Horizon ${res.status}`);
  const data = await res.json();
  const native = data.balances.find((b) => b.asset_type === 'native');
  return native ? Number(native.balance) : 0;
}

/** Firmante a partir de un Keypair local. */
export function keypairSigner(kp) {
  return {
    address: kp.publicKey(),
    async sign(tx) {
      tx.sign(kp);
      return tx;
    },
  };
}

/** Firmante que delega en la extensión Freighter. */
export async function freighterSigner() {
  const freighter = await import('@stellar/freighter-api');
  const conn = await freighter.isConnected();
  if (!conn?.isConnected) throw new Error('Freighter no está instalado en este navegador');
  const access = await freighter.requestAccess();
  if (access.error) throw new Error(access.error.message || 'Freighter rechazó el acceso');
  const net = await freighter.getNetworkDetails().catch(() => null);
  if (net?.networkPassphrase && net.networkPassphrase !== NETWORK_PASSPHRASE) {
    throw new Error('Cambia Freighter a Testnet');
  }
  const address = access.address;
  return {
    address,
    freighter: true,
    async sign(tx) {
      const out = await freighter.signTransaction(tx.toXDR(), { networkPassphrase: NETWORK_PASSPHRASE, address });
      if (out.error) throw new Error(out.error.message || 'Firma rechazada');
      return TransactionBuilder.fromXDR(out.signedTxXdr, NETWORK_PASSPHRASE);
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isBadSeq(errResult) {
  try {
    return errResult?.result().switch().name === 'txBadSeq';
  } catch {
    return false;
  }
}

function describeSendError(sent) {
  try {
    return sent.errorResult.result().switch().name;
  } catch {
    return sent.status;
  }
}

/**
 * Llama a un método de contrato: construye, simula/prepara, firma, envía y espera.
 * Reintenta si la secuencia quedó desfasada o la red pide intentar más tarde.
 */
export async function invokeContract({ contractId, method, args, signer, onStatus = () => {} }) {
  const contract = new Contract(contractId);
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      onStatus(attempt === 1 ? 'Preparando transacción…' : `Reintentando (${attempt}/4)…`);
      const account = await server.getAccount(signer.address);
      const built = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(contract.call(method, ...args))
        .setTimeout(120)
        .build();
      onStatus('Simulando en Soroban…');
      const prepared = await prepareWithMargin(built);
      onStatus(signer.freighter ? 'Esperando firma en Freighter…' : 'Firmando…');
      const signed = await signer.sign(prepared);
      onStatus('Enviando…');
      const sent = await server.sendTransaction(signed);
      if (sent.status === 'ERROR') {
        if (isBadSeq(sent.errorResult)) {
          lastError = new Error('Secuencia desfasada');
          await sleep(1500);
          continue;
        }
        throw new Error(`Transacción rechazada: ${describeSendError(sent)}`);
      }
      if (sent.status === 'TRY_AGAIN_LATER') {
        lastError = new Error('La red pidió reintentar');
        await sleep(2500);
        continue;
      }
      onStatus('Esperando confirmación…');
      const result = await waitForTx(sent.hash);
      return { hash: sent.hash, returnValue: result.returnValue ? scValToNative(result.returnValue) : undefined };
    } catch (err) {
      lastError = err;
      // Errores de simulación (p. ej. prueba inválida) no se arreglan reintentando.
      if (/simulat|HostError|Error\(Contract/i.test(err.message) || err.final) throw err;
      if (attempt < 4) await sleep(1500);
    }
  }
  throw lastError;
}

// Margen sobre lo que estima la simulación. Si entre simular y enviar entran otros depósitos,
// el contrato recorre más raíces y la tx real gasta algo más de CPU que la simulada; sin
// margen, la red la corta con RESOURCE_LIMIT_EXCEEDED.
const RESOURCE_MARGIN = 1.3;

async function prepareWithMargin(built) {
  const sim = await server.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`);
  const data = sim.transactionData;
  const current = data.build();
  const res = current.resources;
  data.setResources(
    Math.ceil(Number(res.instructions) * RESOURCE_MARGIN),
    Math.ceil(Number(res.diskReadBytes) * RESOURCE_MARGIN),
    Math.ceil(Number(res.writeBytes) * RESOURCE_MARGIN),
  );
  const fee = BigInt(current.resourceFee.toString());
  data.setResourceFee(((fee * 3n) / 2n).toString());
  return rpc.assembleTransaction(built, sim).build();
}

async function waitForTx(hash) {
  for (let i = 0; i < 60; i++) {
    const res = await server.getTransaction(hash);
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) return res;
    if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
      // Se revirtió entera (nada se cobró ni se gastó salvo la fee): invokeContract reintenta.
      throw new Error(`La transacción ${short(hash, 6)} falló on-chain; reintentando con estado nuevo`);
    }
    await sleep(1500);
  }
  const err = new Error('Tiempo de espera agotado esperando la confirmación');
  err.final = true;
  throw err;
}

/** Llamada de solo lectura (simulación, sin firmar ni pagar). */
export async function readContract(contractId, method, args = [], source) {
  const account = new Account(source || Keypair.random().publicKey(), '0');
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`Error al leer ${method}: ${sim.error}`);
  return sim.result?.retval ? scValToNative(sim.result.retval) : undefined;
}

// ---- Conversión de argumentos ----

export const bytesVal = (u8) => xdr.ScVal.scvBytes(Buffer.from(u8));
export const addressVal = (g) => Address.fromString(g).toScVal();

/** Proof { a: BytesN<64>, b: BytesN<128>, c: BytesN<64> } como ScMap (claves ordenadas). */
export function proofVal({ a, b, c }) {
  return xdr.ScVal.scvMap(
    [
      ['a', a],
      ['b', b],
      ['c', c],
    ].map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: bytesVal(v) })),
  );
}
