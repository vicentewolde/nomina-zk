//! Verificador Groth16 sobre BN254 con las host functions `bn254_*` (Protocolo 25+).
//!
//! Ecuación de Groth16: e(A, B) = e(alpha, beta) · e(vk_x, gamma) · e(C, delta),
//! con vk_x = IC[0] + Σ input_i · IC[i+1]. La comprobamos como un único
//! multi-pairing: e(-A, B) · e(alpha, beta) · e(vk_x, gamma) · e(C, delta) == 1.

use soroban_sdk::{
    contracttype,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
    vec, BytesN, Env, Vec,
};

/// G1 = X || Y (64 bytes BE). G2 = X.c1 || X.c0 || Y.c1 || Y.c0 (128 bytes BE).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerificationKey {
    pub alpha: BytesN<64>,
    pub beta: BytesN<128>,
    pub gamma: BytesN<128>,
    pub delta: BytesN<128>,
    pub ic: Vec<BytesN<64>>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proof {
    pub a: BytesN<64>,
    pub b: BytesN<128>,
    pub c: BytesN<64>,
}

/// `inputs` deben ser elementos canónicos de Fr (< r); el llamador lo garantiza.
pub fn verify(env: &Env, vk: &VerificationKey, proof: &Proof, inputs: &Vec<Bn254Fr>) -> bool {
    if vk.ic.len() != inputs.len() + 1 {
        return false;
    }
    let bn = env.crypto().bn254();

    let mut points: Vec<Bn254G1Affine> = Vec::new(env);
    for i in 1..vk.ic.len() {
        points.push_back(Bn254G1Affine::from_bytes(vk.ic.get_unchecked(i)));
    }
    let ic0 = Bn254G1Affine::from_bytes(vk.ic.get_unchecked(0));
    let vk_x = if inputs.is_empty() {
        ic0
    } else {
        bn.g1_add(&ic0, &bn.g1_msm(points, inputs.clone()))
    };

    let neg_a = -Bn254G1Affine::from_bytes(proof.a.clone());
    let g1 = vec![
        env,
        neg_a,
        Bn254G1Affine::from_bytes(vk.alpha.clone()),
        vk_x,
        Bn254G1Affine::from_bytes(proof.c.clone()),
    ];
    let g2 = vec![
        env,
        Bn254G2Affine::from_bytes(proof.b.clone()),
        Bn254G2Affine::from_bytes(vk.beta.clone()),
        Bn254G2Affine::from_bytes(vk.gamma.clone()),
        Bn254G2Affine::from_bytes(vk.delta.clone()),
    ];
    bn.pairing_check(g1, g2)
}
