#!/usr/bin/env bash
# Compila withdraw.circom, hace el trusted setup Groth16 (BN254) y copia los
# artefactos a app/public/zk/. Reproducible: bash circuits/scripts/build.sh
set -euo pipefail

CIRCUITS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR="$(cd "$CIRCUITS_DIR/.." && pwd)"
BUILD="$CIRCUITS_DIR/build"
# Powers of Tau de PSE (perpetual powers of tau, 2^13 = 8192 restricciones; el circuito usa ~6.6k).
PTAU_NAME="ppot_0080_13.ptau"
PTAU="$CIRCUITS_DIR/$PTAU_NAME"
PTAU_URL="${PTAU_URL:-https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/$PTAU_NAME}"
SNARKJS="$CIRCUITS_DIR/node_modules/.bin/snarkjs"
APP_ZK="$ROOT_DIR/app/public/zk"

cd "$CIRCUITS_DIR"
[ -x "$SNARKJS" ] || npm install
command -v circom >/dev/null || { echo "Falta circom 2.x en el PATH"; exit 1; }

mkdir -p "$BUILD"

echo "==> Compilando circuito"
circom withdraw.circom --r1cs --wasm --sym --prime bn128 -o "$BUILD"
"$SNARKJS" r1cs info "$BUILD/withdraw.r1cs"

if [ ! -f "$PTAU" ]; then
  echo "==> Descargando $PTAU_NAME"
  curl -fL -o "$PTAU.tmp" "$PTAU_URL"
  mv "$PTAU.tmp" "$PTAU"
fi

echo "==> Groth16 setup"
"$SNARKJS" groth16 setup "$BUILD/withdraw.r1cs" "$PTAU" "$BUILD/withdraw_0000.zkey"
ENTROPY="${ZK_ENTROPY:-$(head -c 32 /dev/urandom | xxd -p -c 64)}"
"$SNARKJS" zkey contribute "$BUILD/withdraw_0000.zkey" "$BUILD/withdraw_final.zkey" \
  --name="nomina-zk-1" -e="$ENTROPY"
"$SNARKJS" zkey export verificationkey "$BUILD/withdraw_final.zkey" "$BUILD/verification_key.json"

echo "==> VK para Soroban"
node "$CIRCUITS_DIR/scripts/export-vk.mjs" "$BUILD/verification_key.json" "$BUILD/vk_soroban.json"

echo "==> Copiando artefactos a app/public/zk"
mkdir -p "$APP_ZK"
cp "$BUILD/withdraw_js/withdraw.wasm" "$APP_ZK/withdraw.wasm"
cp "$BUILD/withdraw_final.zkey" "$APP_ZK/withdraw_final.zkey"
cp "$BUILD/verification_key.json" "$APP_ZK/verification_key.json"

echo "==> Listo"
ls -la "$APP_ZK" "$BUILD/vk_soroban.json"
