#![cfg(test)]
extern crate std;

use crate::{recipient_field, verifier, Error, Pool, PoolClient, Proof, VerificationKey};
use serde_json::Value;
use soroban_poseidon::poseidon_hash;
use soroban_sdk::{
    crypto::bn254::Bn254Fr,
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    vec, Address, BytesN, Env, String, Vec, U256,
};
use std::{format, path::PathBuf};

const DENOM: i128 = 100_000_000;

/// Lee primero circuits/build (artefactos vivos del circuito) y, si no existe,
/// la copia congelada en testdata/.
fn load_json(name: &str) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let live = root.join("../../circuits/build").join(name);
    let path = if live.exists() { live } else { root.join("testdata").join(name) };
    let s = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("falta {:?}", path));
    serde_json::from_str(&s).unwrap()
}

fn hex_n<const N: usize>(env: &Env, h: &str) -> BytesN<N> {
    let h = h.trim_start_matches("0x");
    let v = hex::decode(format!("{:0>width$}", h, width = N * 2)).unwrap();
    BytesN::from_array(env, &v.try_into().unwrap())
}

fn u256(env: &Env, h: &str) -> U256 {
    U256::from_be_bytes(env, &hex_n::<32>(env, h).into())
}

fn vk_from(env: &Env, v: &Value) -> VerificationKey {
    let mut ic = Vec::new(env);
    for p in v["ic"].as_array().unwrap() {
        ic.push_back(hex_n::<64>(env, p.as_str().unwrap()));
    }
    VerificationKey {
        alpha: hex_n(env, v["alpha"].as_str().unwrap()),
        beta: hex_n(env, v["beta"].as_str().unwrap()),
        gamma: hex_n(env, v["gamma"].as_str().unwrap()),
        delta: hex_n(env, v["delta"].as_str().unwrap()),
        ic,
    }
}

fn proof_from(env: &Env, v: &Value) -> Proof {
    Proof {
        a: hex_n(env, v["a"].as_str().unwrap()),
        b: hex_n(env, v["b"].as_str().unwrap()),
        c: hex_n(env, v["c"].as_str().unwrap()),
    }
}

// ---------- Poseidon: compatibilidad exacta con circomlib ----------

#[test]
fn poseidon_matches_circomlib_known_values() {
    let env = Env::default();
    let h1 = poseidon_hash::<2, Bn254Fr>(&env, &vec![&env, U256::from_u32(&env, 1)]);
    assert_eq!(
        h1,
        u256(&env, "29176100eaa962bdc1fe6c654d6a3c130e96a4d1168b33848b897dc502820133")
    );
    let h12 = poseidon_hash::<3, Bn254Fr>(
        &env,
        &vec![&env, U256::from_u32(&env, 1), U256::from_u32(&env, 2)],
    );
    assert_eq!(
        h12,
        u256(&env, "115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a")
    );
}

#[test]
fn poseidon_matches_circuit_vectors() {
    let env = Env::default();
    let v = load_json("poseidon-vectors.json");
    let h1 = poseidon_hash::<2, Bn254Fr>(&env, &vec![&env, U256::from_u32(&env, 1)]);
    assert_eq!(h1, u256(&env, v["poseidon_1"]["hex"].as_str().unwrap()));
    let h12 = poseidon_hash::<3, Bn254Fr>(
        &env,
        &vec![&env, U256::from_u32(&env, 1), U256::from_u32(&env, 2)],
    );
    assert_eq!(h12, u256(&env, v["poseidon_1_2"]["hex"].as_str().unwrap()));

    let zeros = v["zeros_all_hex"].as_array().unwrap();
    assert_eq!(zeros.len(), 11);
    let mut z = U256::from_u32(&env, 0);
    assert_eq!(z, u256(&env, zeros[0].as_str().unwrap()));
    for i in 1..=10 {
        z = poseidon_hash::<3, Bn254Fr>(&env, &vec![&env, z.clone(), z.clone()]);
        assert_eq!(z, u256(&env, zeros[i].as_str().unwrap()), "zeros[{}]", i);
    }
    assert_eq!(z, u256(&env, v["empty_root_hex"].as_str().unwrap()));
}

// ---------- Setup del contrato ----------

struct Setup<'a> {
    env: Env,
    pool: PoolClient<'a>,
    token: TokenClient<'a>,
    sac: StellarAssetClient<'a>,
}

fn setup<'a>() -> Setup<'a> {
    let env = Env::default();
    let vk = real_vk(&env);
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let admin = Address::generate(&env);
    let sac_contract = env.register_stellar_asset_contract_v2(admin.clone());
    let token_id = sac_contract.address();
    let pool_id = env.register(Pool, (admin.clone(), token_id.clone(), DENOM, vk));
    Setup {
        pool: PoolClient::new(&env, &pool_id),
        token: TokenClient::new(&env, &token_id),
        sac: StellarAssetClient::new(&env, &token_id),
        env,
    }
}

fn real_vk(env: &Env) -> VerificationKey {
    vk_from(env, &load_json("vk_soroban.json"))
}

#[test]
fn empty_root_and_merkle_insertions_match_circomlibjs() {
    let s = setup();
    let env = &s.env;
    // Raíz del árbol vacío = zeros[10].
    assert_eq!(
        s.pool.get_root(),
        hex_n::<32>(env, "1b7201da72494f1e28717ad1a52eb469f95892f957713533de6175e5da190af2")
    );
    // Raíces calculadas con circomlibjs para las hojas 11, 22, 33, 44, 55.
    let expected = [
        "20d6dbb7a3de22a0f4e8c6117713bfdf3cacd7c793ef89dfafc646aebebf492e",
        "2a4d86ec06c35c379c9fd17ffdfa08f44fec07daff95af1cbad5846ba8247cb9",
        "14ec4bb7c4794c226712e2f599af89d6211426e59c3337589cfcf48aa2a66f77",
        "0c55f10053d6494c80a2b14e1561690380e649011c923d144647dce649ed5dcb",
        "1b5aa2fa72c5248e94c35747be6eba4a13170d82301ca08ad4655eafede68d40",
    ];
    let user = Address::generate(env);
    s.sac.mint(&user, &(DENOM * 10));
    for (i, leaf) in [11u32, 22, 33, 44, 55].iter().enumerate() {
        let c = hex_n::<32>(env, &format!("{:x}", leaf));
        assert_eq!(s.pool.deposit(&user, &c), i as u32);
        assert_eq!(s.pool.get_root(), hex_n::<32>(env, expected[i]));
        assert!(s.pool.is_known_root(&hex_n::<32>(env, expected[i])));
    }
    assert_eq!(s.pool.get_leaves().len(), 5);
    assert_eq!(s.token.balance(&s.pool.address), DENOM * 5);
    assert_eq!(s.token.balance(&user), DENOM * 5);
    assert_eq!(s.pool.denomination(), DENOM);
}

#[test]
fn root_history_keeps_last_30() {
    let s = setup();
    let env = &s.env;
    let user = Address::generate(env);
    s.sac.mint(&user, &(DENOM * 40));
    let first = {
        s.pool.deposit(&user, &hex_n::<32>(env, "01"));
        s.pool.get_root()
    };
    for i in 2..=31u32 {
        s.pool.deposit(&user, &hex_n::<32>(env, &format!("{:x}", i)));
    }
    // 31 depósitos: la raíz del primero ya salió del anillo de 30.
    assert!(!s.pool.is_known_root(&first));
    assert!(s.pool.is_known_root(&s.pool.get_root()));
    assert_eq!(s.pool.get_leaves().len(), 31);
    assert!(!s.pool.is_known_root(&BytesN::from_array(env, &[0u8; 32])));
}

#[test]
fn leaves_span_multiple_chunks() {
    let s = setup();
    let env = &s.env;
    let user = Address::generate(env);
    s.sac.mint(&user, &(DENOM * 200));
    for i in 1..=130u32 {
        s.pool.deposit(&user, &hex_n::<32>(env, &format!("{:x}", i)));
    }
    let leaves = s.pool.get_leaves();
    assert_eq!(leaves.len(), 130);
    assert_eq!(leaves.get(129).unwrap(), hex_n::<32>(env, "82"));
}

#[test]
fn deposit_rejects_non_field_commitment() {
    let s = setup();
    let env = &s.env;
    let user = Address::generate(env);
    s.sac.mint(&user, &DENOM);
    let r = hex_n::<32>(env, "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001");
    assert_eq!(
        s.pool.try_deposit(&user, &r).unwrap_err().unwrap(),
        Error::InvalidFieldElement.into()
    );
}

// ---------- Verificador Groth16 ----------

#[test]
fn verifier_accepts_toy_proof_and_rejects_tampering() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let v: Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("testdata/toy-vector.json")).unwrap(),
    )
    .unwrap();
    let vk = vk_from(&env, &v["vk"]);
    let proof = proof_from(&env, &v["proof"]);
    let mut inputs = Vec::new(&env);
    for p in v["public"].as_array().unwrap() {
        inputs.push_back(Bn254Fr::from_u256(u256(&env, p.as_str().unwrap())));
    }
    assert!(verifier::verify(&env, &vk, &proof, &inputs));

    let mut bad = inputs.clone();
    bad.set(2, Bn254Fr::from_u256(U256::from_u32(&env, 78)));
    assert!(!verifier::verify(&env, &vk, &proof, &bad));
}

#[test]
fn verifier_accepts_circuit_test_vector() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let tv = load_json("test-vector.json");
    let vk = real_vk(&env);
    let proof = proof_from(&env, &tv["soroban"]["proof"]);
    let mut inputs = Vec::new(&env);
    for p in tv["soroban"]["publicInputs"].as_array().unwrap() {
        inputs.push_back(Bn254Fr::from_u256(u256(&env, p.as_str().unwrap())));
    }
    assert!(verifier::verify(&env, &vk, &proof, &inputs));

    // El recipient derivado en el contrato coincide con el de la app/circuito.
    let addr = Address::from_string(&String::from_str(
        &env,
        tv["recipientAddress"].as_str().unwrap(),
    ));
    assert_eq!(
        recipient_field(&env, &addr),
        u256(&env, tv["soroban"]["recipient"].as_str().unwrap())
    );
}

// Token mínimo para el e2e: el SAC de test exige trustline a cuentas G.
mod mock_token {
    use soroban_sdk::{contract, contractimpl, Address, Env};
    #[contract]
    pub struct MockToken;
    #[contractimpl]
    impl MockToken {
        pub fn mint(env: Env, to: Address, amount: i128) {
            let b: i128 = env.storage().persistent().get(&to).unwrap_or(0);
            env.storage().persistent().set(&to, &(b + amount));
        }
        pub fn balance(env: Env, id: Address) -> i128 {
            env.storage().persistent().get(&id).unwrap_or(0)
        }
        pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
            from.require_auth();
            let fb: i128 = env.storage().persistent().get(&from).unwrap_or(0);
            assert!(fb >= amount);
            env.storage().persistent().set(&from, &(fb - amount));
            let tb: i128 = env.storage().persistent().get(&to).unwrap_or(0);
            env.storage().persistent().set(&to, &(tb + amount));
        }
    }
}

#[test]
fn end_to_end_deposit_and_withdraw_with_real_proof() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let token_id = env.register(mock_token::MockToken, ());
    let mt = mock_token::MockTokenClient::new(&env, &token_id);
    let vk = real_vk(&env);
    let pool_id = env.register(Pool, (Address::generate(&env), token_id.clone(), DENOM, vk));
    let pool = PoolClient::new(&env, &pool_id);
    let env = &env;
    let tv = load_json("test-vector.json");

    let company = Address::generate(env);
    mt.mint(&company, &(DENOM * 3));
    for l in tv["leaves"].as_array().unwrap() {
        pool.deposit(&company, &hex_n::<32>(env, l.as_str().unwrap()));
    }
    let root = hex_n::<32>(env, tv["soroban"]["root"].as_str().unwrap());
    assert_eq!(pool.get_root(), root);

    let nh = hex_n::<32>(env, tv["soroban"]["nullifierHash"].as_str().unwrap());
    let recipient = Address::from_string(&String::from_str(
        env,
        tv["recipientAddress"].as_str().unwrap(),
    ));
    let proof = proof_from(env, &tv["soroban"]["proof"]);

    // Otro destinatario con la misma prueba: falla.
    let thief = Address::generate(env);
    assert_eq!(
        pool.try_withdraw(&proof, &root, &nh, &thief).unwrap_err().unwrap(),
        Error::InvalidProof.into()
    );

    env.cost_estimate().budget().reset_default();
    pool.withdraw(&proof, &root, &nh, &recipient);
    std::println!("withdraw cpu insns: {}", env.cost_estimate().budget().cpu_instruction_cost());
    env.cost_estimate().budget().reset_unlimited();

    assert!(pool.is_spent(&nh));
    assert_eq!(mt.balance(&recipient), DENOM);
    assert_eq!(mt.balance(&pool_id), DENOM * 2);

    // Doble gasto.
    assert_eq!(
        pool.try_withdraw(&proof, &root, &nh, &recipient).unwrap_err().unwrap(),
        Error::NullifierSpent.into()
    );
    // Raíz desconocida.
    let bad_root = hex_n::<32>(env, "01");
    assert_eq!(
        pool.try_withdraw(&proof, &bad_root, &nh, &recipient).unwrap_err().unwrap(),
        Error::UnknownRoot.into()
    );
}

#[test]
fn deposit_fits_default_budget() {
    let s = setup();
    let env = &s.env;
    let user = Address::generate(env);
    s.sac.mint(&user, &DENOM);
    env.cost_estimate().budget().reset_default();
    s.pool.deposit(&user, &hex_n::<32>(env, "2a"));
    std::println!("deposit cpu insns: {}", env.cost_estimate().budget().cpu_instruction_cost());
}
