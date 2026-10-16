#!/usr/bin/env bash
# Despliega el pool de Nómina ZK en Stellar testnet y escribe app/src/config.json.
# Uso: bash contracts/scripts/deploy.sh   (requiere stellar CLI >= 28 y circuits/build/vk_soroban.json)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NETWORK="${NETWORK:-testnet}"
IDENTITY="${IDENTITY:-nzk-admin}"
DENOMINATION="${DENOMINATION:-100000000}" # 10 XLM en stroops
VK_FILE="${VK_FILE:-$ROOT/circuits/build/vk_soroban.json}"
WASM="$ROOT/contracts/pool/target/wasm32v1-none/release/nomina_pool.wasm"
CONFIG="$ROOT/app/src/config.json"

[ -f "$VK_FILE" ] || { echo "Falta $VK_FILE (lo genera circuits/)"; exit 1; }

# Identidad del admin (se crea y fondea con friendbot si no existe).
if ! stellar keys address "$IDENTITY" >/dev/null 2>&1; then
  stellar keys generate "$IDENTITY" --network "$NETWORK" --fund
fi
ADMIN="$(stellar keys address "$IDENTITY")"
stellar keys fund "$IDENTITY" --network "$NETWORK" >/dev/null 2>&1 || true

# SAC del XLM nativo (lo despliega si aún no existe en la red).
TOKEN="$(stellar contract id asset --asset native --network "$NETWORK")"
stellar contract asset deploy --asset native --source "$IDENTITY" --network "$NETWORK" >/dev/null 2>&1 || true

(cd "$ROOT/contracts/pool" && stellar contract build)

POOL="$(stellar contract deploy \
  --wasm "$WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --alias nomina-pool \
  -- \
  --admin "$ADMIN" \
  --token "$TOKEN" \
  --denomination "$DENOMINATION" \
  --vk "$(cat "$VK_FILE")")"

mkdir -p "$(dirname "$CONFIG")"
cat > "$CONFIG" <<EOF
{
  "poolContractId": "$POOL",
  "tokenContractId": "$TOKEN",
  "denomination": "$DENOMINATION",
  "network": "$NETWORK"
}
EOF

echo "Pool:  $POOL"
echo "Token: $TOKEN"
echo "Admin: $ADMIN"
echo "Config escrita en $CONFIG"
