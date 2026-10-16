# contracts/pool — privacy pool de Nómina ZK (Soroban)

Merkle tree incremental (LEVELS=10, Poseidon de circomlib, 30 raíces), nullifiers y verificador Groth16 BN254 con las host functions `bn254_*`. API y formatos en `docs/INTERFACE.md`.

```bash
cd contracts/pool && cargo test        # Poseidon vs circomlibjs, raíces Merkle, verificador y e2e con la prueba real
bash contracts/scripts/deploy.sh       # build + deploy en testnet + app/src/config.json
```

Smoke test por CLI (testnet):
```bash
P=$(jq -r .poolContractId app/src/config.json)
stellar contract invoke --id $P --source nzk-admin --network testnet --send=yes -- deposit --from $(stellar keys address nzk-admin) --commitment <hex32>
stellar contract invoke --id $P --source nzk-admin --network testnet -- get_root
stellar contract invoke --id $P --source nzk-admin --network testnet -- get_leaves
stellar contract invoke --id $P --source nzk-admin --network testnet --send=yes -- withdraw \
  --proof '{"a":"…","b":"…","c":"…"}' --root <hex32> --nullifier_hash <hex32> --recipient G…
```
