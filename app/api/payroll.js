// Función serverless (Vercel, runtime Node) que convierte una nómina escrita en
// lenguaje natural en una lista estructurada de pagos usando la API de OpenRouter.
// La key vive solo en el servidor (process.env.OPENROUTER_API_KEY).
//
// POST /api/payroll { text: string, denominationXlm: number }
//   → { payments: [{ name, amountXlm, notes }], warnings: [string] }

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const MAX_TEXT = 4000;

const SYSTEM_PROMPT = `Eres el asistente de nómina de una empresa que paga sueldos en XLM (Stellar testnet).
Recibes una instrucción en lenguaje natural y devuelves SOLO un objeto JSON con esta forma exacta:
{"payments":[{"name":"string","amountXlm":number}],"warnings":["string"]}
Reglas:
- Un elemento por empleado. Si un mismo nombre aparece dos veces, súmalo en un único pago y agrega una alerta de posible duplicado.
- amountXlm es el monto EXACTO pedido en XLM, como número positivo (sin texto). Nunca lo redondees: el sistema calcula las notas. Si se menciona otra moneda o no hay monto claro, omite ese pago y explica por qué en warnings.
- Los pagos se hacen en notas de monto fijo de {DEN} XLM. Si un monto no es múltiplo de {DEN}, agrega una alerta indicando que el pago se redondeará hacia arriba a notas enteras (pero deja amountXlm sin redondear).
- Agrega alertas para montos atípicos (muy distintos al resto o mayores a 1000 XLM), nombres ambiguos o instrucciones que no sean de nómina.
- Las alertas van en español, breves.
- No inventes empleados. No incluyas texto fuera del JSON.`;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body !== undefined) {
    return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function extractJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('El modelo no devolvió JSON');
    return JSON.parse(match[0]);
  }
}

export function normalize(parsed, denominationXlm) {
  const warnings = Array.isArray(parsed?.warnings)
    ? parsed.warnings.filter((w) => typeof w === 'string' && w.trim()).map((w) => w.trim())
    : [];
  const payments = [];
  for (const p of Array.isArray(parsed?.payments) ? parsed.payments : []) {
    const name = String(p?.name ?? '').trim().slice(0, 80);
    const amountXlm = Number(p?.amountXlm);
    if (!name || !Number.isFinite(amountXlm) || amountXlm <= 0) {
      warnings.push(`Se descartó un pago inválido: ${JSON.stringify(p).slice(0, 120)}`);
      continue;
    }
    payments.push({ name, amountXlm, notes: Math.ceil(amountXlm / denominationXlm) });
  }
  return { payments, warnings };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Usa POST' });

  let body;
  try {
    body = await readBody(req);
  } catch {
    return send(res, 400, { error: 'JSON inválido' });
  }

  const text = String(body?.text ?? '').trim();
  const denominationXlm = Number(body?.denominationXlm) > 0 ? Number(body.denominationXlm) : 10;
  if (!text) return send(res, 400, { error: 'Falta el texto de la nómina' });
  if (text.length > MAX_TEXT) return send(res, 400, { error: `Texto demasiado largo (máx. ${MAX_TEXT})` });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return send(res, 500, { error: 'Falta OPENROUTER_API_KEY en el servidor' });
  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;

  let upstream;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://nomina-zk.vercel.app',
        'X-Title': 'Nomina ZK',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT.replaceAll('{DEN}', String(denominationXlm)) },
          { role: 'user', content: text },
        ],
      }),
    });
  } catch (err) {
    return send(res, 502, { error: `No se pudo contactar a OpenRouter: ${err.message}` });
  }

  const data = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    const msg = data?.error?.message || `HTTP ${upstream.status}`;
    return send(res, 502, { error: `OpenRouter respondió con error: ${msg}` });
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) return send(res, 502, { error: 'Respuesta vacía de OpenRouter' });

  try {
    const result = normalize(extractJson(content), denominationXlm);
    return send(res, 200, { ...result, model: data.model || model });
  } catch (err) {
    return send(res, 502, { error: err.message });
  }
}
