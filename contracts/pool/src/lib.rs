#![no_std]
//! Nómina ZK: privacy pool de monto fijo (estilo Tornado) sobre Soroban.
//! Merkle tree incremental con Poseidon (circomlib, BN254) y verificador Groth16 BN254.

use soroban_poseidon::PoseidonSponge;
use soroban_sdk::{
    bytesn, contract, contracterror, contractimpl, contracttype,
    crypto::bn254::Bn254Fr,
    panic_with_error, symbol_short, token,
    xdr::ToXdr,
    Address, BytesN, Env, Vec, U256,
};

mod verifier;
pub use verifier::{Proof, VerificationKey};

#[cfg(test)]
mod test;

pub const LEVELS: u32 = 10;
pub const ROOT_HISTORY: u32 = 30;
/// Hojas por entrada de almacenamiento (get_leaves lee 1024 / 128 = 8 entradas como máximo).
const CHUNK: u32 = 128;

const TTL_THRESHOLD: u32 = 100_000;
const TTL_EXTEND: u32 = 500_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    UnknownRoot = 1,
    NullifierSpent = 2,
    InvalidProof = 3,
    TreeFull = 4,
    InvalidFieldElement = 5,
    InvalidVerificationKey = 6,
    InvalidDenomination = 7,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Token,
    Denomination,
    Vk,
    /// zeros[0..=LEVELS]; zeros[LEVELS] es la raíz del árbol vacío.
    Zeros,
    FilledSubtrees,
    /// Anillo de las últimas ROOT_HISTORY raíces.
    Roots,
    CurrentRootIndex,
    NextIndex,
    Leaves(u32),
    Nullifier(BytesN<32>),
}

fn fr_modulus(env: &Env) -> U256 {
    U256::from_be_bytes(
        env,
        &bytesn!(env, 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001).into(),
    )
}

fn to_field(env: &Env, b: &BytesN<32>) -> U256 {
    let v = U256::from_be_bytes(env, &b.clone().into());
    if v >= fr_modulus(env) {
        panic_with_error!(env, Error::InvalidFieldElement);
    }
    v
}

fn to_bytes(v: &U256) -> BytesN<32> {
    v.to_be_bytes().try_into().unwrap()
}

/// Hash de 2 entradas de un nodo del árbol: Poseidon([left, right]) (t = 3).
fn hash_pair(env: &Env, sponge: &mut PoseidonSponge<3, Bn254Fr>, l: &U256, r: &U256) -> U256 {
    sponge.compute_hash(&soroban_sdk::vec![env, l.clone(), r.clone()])
}

/// recipient = sha256(ScVal::Address.toXDR()) con el primer byte en 0.
pub fn recipient_field(env: &Env, recipient: &Address) -> U256 {
    let h = env.crypto().sha256(&recipient.clone().to_xdr(env));
    let mut arr = h.to_array();
    arr[0] = 0;
    U256::from_be_bytes(env, &BytesN::from_array(env, &arr).into())
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
}

#[contract]
pub struct Pool;

#[contractimpl]
impl Pool {
    pub fn __constructor(
        env: Env,
        admin: Address,
        token: Address,
        denomination: i128,
        vk: VerificationKey,
    ) {
        if denomination <= 0 {
            panic_with_error!(&env, Error::InvalidDenomination);
        }
        // 3 entradas públicas: root, nullifierHash, recipient.
        if vk.ic.len() != 4 {
            panic_with_error!(&env, Error::InvalidVerificationKey);
        }
        let st = env.storage().instance();
        st.set(&DataKey::Admin, &admin);
        st.set(&DataKey::Token, &token);
        st.set(&DataKey::Denomination, &denomination);
        st.set(&DataKey::Vk, &vk);

        let mut sponge = PoseidonSponge::<3, Bn254Fr>::new(&env);
        let mut zeros: Vec<BytesN<32>> = Vec::new(&env);
        let mut z = U256::from_u32(&env, 0);
        zeros.push_back(to_bytes(&z));
        for _ in 0..LEVELS {
            z = hash_pair(&env, &mut sponge, &z, &z);
            zeros.push_back(to_bytes(&z));
        }
        let mut filled: Vec<BytesN<32>> = Vec::new(&env);
        for i in 0..LEVELS {
            filled.push_back(zeros.get_unchecked(i));
        }
        let mut roots: Vec<BytesN<32>> = Vec::new(&env);
        roots.push_back(zeros.get_unchecked(LEVELS));

        st.set(&DataKey::Zeros, &zeros);
        st.set(&DataKey::FilledSubtrees, &filled);
        st.set(&DataKey::Roots, &roots);
        st.set(&DataKey::CurrentRootIndex, &0u32);
        st.set(&DataKey::NextIndex, &0u32);
        bump_instance(&env);
    }

    /// Deposita una nota de `denomination` y devuelve el índice de su hoja.
    pub fn deposit(env: Env, from: Address, commitment: BytesN<32>) -> u32 {
        from.require_auth();
        let leaf = to_field(&env, &commitment);
        let st = env.storage().instance();

        let index: u32 = st.get(&DataKey::NextIndex).unwrap();
        if index >= (1u32 << LEVELS) {
            panic_with_error!(&env, Error::TreeFull);
        }

        let token: Address = st.get(&DataKey::Token).unwrap();
        let denomination: i128 = st.get(&DataKey::Denomination).unwrap();
        token::Client::new(&env, &token).transfer(
            &from,
            &env.current_contract_address(),
            &denomination,
        );

        // Inserción incremental.
        let zeros: Vec<BytesN<32>> = st.get(&DataKey::Zeros).unwrap();
        let mut filled: Vec<BytesN<32>> = st.get(&DataKey::FilledSubtrees).unwrap();
        let mut sponge = PoseidonSponge::<3, Bn254Fr>::new(&env);
        let mut cur = leaf;
        let mut cur_idx = index;
        for i in 0..LEVELS {
            let (l, r) = if cur_idx & 1 == 0 {
                filled.set(i, to_bytes(&cur));
                let z = U256::from_be_bytes(&env, &zeros.get_unchecked(i).into());
                (cur, z)
            } else {
                let f = U256::from_be_bytes(&env, &filled.get_unchecked(i).into());
                (f, cur)
            };
            cur = hash_pair(&env, &mut sponge, &l, &r);
            cur_idx >>= 1;
        }

        let mut roots: Vec<BytesN<32>> = st.get(&DataKey::Roots).unwrap();
        let cur_root_idx: u32 = st.get(&DataKey::CurrentRootIndex).unwrap();
        let new_root_idx = (cur_root_idx + 1) % ROOT_HISTORY;
        if new_root_idx < roots.len() {
            roots.set(new_root_idx, to_bytes(&cur));
        } else {
            roots.push_back(to_bytes(&cur));
        }

        st.set(&DataKey::FilledSubtrees, &filled);
        st.set(&DataKey::Roots, &roots);
        st.set(&DataKey::CurrentRootIndex, &new_root_idx);
        st.set(&DataKey::NextIndex, &(index + 1));
        bump_instance(&env);

        // Guardar la hoja para que los clientes reconstruyan el árbol.
        let chunk_key = DataKey::Leaves(index / CHUNK);
        let ps = env.storage().persistent();
        let mut chunk: Vec<BytesN<32>> = ps.get(&chunk_key).unwrap_or(Vec::new(&env));
        chunk.push_back(commitment.clone());
        ps.set(&chunk_key, &chunk);
        ps.extend_ttl(&chunk_key, TTL_THRESHOLD, TTL_EXTEND);

        #[allow(deprecated)]
        env.events()
            .publish((symbol_short!("deposit"), commitment), index);
        index
    }

    /// Retira una nota a `recipient` presentando una prueba Groth16.
    pub fn withdraw(
        env: Env,
        proof: Proof,
        root: BytesN<32>,
        nullifier_hash: BytesN<32>,
        recipient: Address,
    ) {
        let root_f = to_field(&env, &root);
        let nh_f = to_field(&env, &nullifier_hash);

        if !Self::is_known_root(env.clone(), root) {
            panic_with_error!(&env, Error::UnknownRoot);
        }
        let nkey = DataKey::Nullifier(nullifier_hash.clone());
        let ps = env.storage().persistent();
        if ps.has(&nkey) {
            panic_with_error!(&env, Error::NullifierSpent);
        }

        let st = env.storage().instance();
        let vk: VerificationKey = st.get(&DataKey::Vk).unwrap();
        let inputs = soroban_sdk::vec![
            &env,
            Bn254Fr::from_u256(root_f),
            Bn254Fr::from_u256(nh_f),
            Bn254Fr::from_u256(recipient_field(&env, &recipient)),
        ];
        if !verifier::verify(&env, &vk, &proof, &inputs) {
            panic_with_error!(&env, Error::InvalidProof);
        }

        ps.set(&nkey, &true);
        ps.extend_ttl(&nkey, TTL_THRESHOLD, TTL_EXTEND);
        bump_instance(&env);

        let token: Address = st.get(&DataKey::Token).unwrap();
        let denomination: i128 = st.get(&DataKey::Denomination).unwrap();
        token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &recipient,
            &denomination,
        );

        #[allow(deprecated)]
        env.events()
            .publish((symbol_short!("withdraw"), nullifier_hash), ());
    }

    pub fn get_root(env: Env) -> BytesN<32> {
        let st = env.storage().instance();
        let roots: Vec<BytesN<32>> = st.get(&DataKey::Roots).unwrap();
        let idx: u32 = st.get(&DataKey::CurrentRootIndex).unwrap();
        roots.get_unchecked(idx)
    }

    pub fn is_known_root(env: Env, root: BytesN<32>) -> bool {
        if root == BytesN::from_array(&env, &[0u8; 32]) {
            return false;
        }
        let roots: Vec<BytesN<32>> = env.storage().instance().get(&DataKey::Roots).unwrap();
        roots.iter().any(|r| r == root)
    }

    pub fn is_spent(env: Env, nullifier_hash: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier_hash))
    }

    pub fn get_leaves(env: Env) -> Vec<BytesN<32>> {
        let n: u32 = env.storage().instance().get(&DataKey::NextIndex).unwrap();
        let mut out: Vec<BytesN<32>> = Vec::new(&env);
        let chunks = n.div_ceil(CHUNK);
        for c in 0..chunks {
            let chunk: Vec<BytesN<32>> = env
                .storage()
                .persistent()
                .get(&DataKey::Leaves(c))
                .unwrap_or(Vec::new(&env));
            out.append(&chunk);
        }
        out
    }

    pub fn denomination(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::Denomination)
            .unwrap()
    }
}
