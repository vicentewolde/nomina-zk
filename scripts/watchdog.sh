#!/usr/bin/env bash
# Vigila Nómina ZK mientras el jurado la prueba: chequea la app, la IA, el RPC y el contrato,
# y mantiene vivo el tráfico señuelo (app/scripts/noise.mjs), reiniciándolo si se detiene.
# Uso (desde la raíz del repo):  caffeinate -i bash scripts/watchdog.sh
set -u
cd "$(dirname "$0")/.."
APP=https://nomina-zk.vercel.app
POOL=$(python3 -c 'import json;print(json.load(open("app/src/config.json"))["poolContractId"])')
LOG=scripts/noise.log
i=0

stamp() { date '+%H:%M:%S'; }
code() { curl -s -o /dev/null -m 20 -w '%{http_code}' "$@"; }

while true; do
  status=()
  [ "$(code "$APP")" = 200 ] && status+=("app ok") || status+=("APP CAÍDA")
  [ "$(code "$APP/zk/withdraw_final.zkey")" = 200 ] && status+=("zk ok") || status+=("ZK FALTA")
  rpc=$(curl -s -m 20 -X POST https://soroban-testnet.stellar.org -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -o '"status":"[a-z]*"')
  [ "$rpc" = '"status":"healthy"' ] && status+=("rpc ok") || status+=("RPC MAL")

  # La IA y el contrato cada 5 minutos (la IA gasta del pozo compartido de OpenRouter).
  if [ $((i % 5)) -eq 0 ]; then
    ia=$(curl -s -m 30 -X POST "$APP/api/payroll" -H 'Content-Type: application/json' \
      -d '{"text":"paga 10 a Ana","denominationXlm":10}')
    echo "$ia" | grep -q '"payments"' && status+=("ia ok") || status+=("IA FALLA (usa '+ Agregar fila manual')")
    leaves=$(stellar contract invoke --id "$POOL" --source nzk-admin --network testnet --send=no -- get_leaves 2>/dev/null \
      | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null)
    [ -n "$leaves" ] && status+=("pool $leaves hojas") || status+=("CONTRATO NO RESPONDE")
  fi

  if pgrep -f "vite-node scripts/noise.mjs" >/dev/null; then
    status+=("ruido ok")
  else
    (cd app && NOISE_MIN=120 nohup npx vite-node scripts/noise.mjs >>"../$LOG" 2>&1 &)
    status+=("RUIDO REINICIADO")
  fi

  echo "$(stamp)  ${status[*]}"
  i=$((i + 1))
  sleep 60
done
