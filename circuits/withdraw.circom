pragma circom 2.1.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/bitify.circom";

// Si s == 0 devuelve (in[0], in[1]); si s == 1 devuelve (in[1], in[0]).
template DualMux() {
    signal input in[2];
    signal input s;
    signal output out[2];

    s * (1 - s) === 0;
    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}

// Recalcula la raíz a partir de la hoja y su Merkle path.
// pathIndices[i] = 0 => el nodo actual va a la izquierda.
template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component selectors[levels];
    component hashers[levels];

    for (var i = 0; i < levels; i++) {
        selectors[i] = DualMux();
        if (i == 0) {
            selectors[i].in[0] <== leaf;
        } else {
            selectors[i].in[0] <== hashers[i - 1].out;
        }
        selectors[i].in[1] <== pathElements[i];
        selectors[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== selectors[i].out[0];
        hashers[i].inputs[1] <== selectors[i].out[1];
    }

    root === hashers[levels - 1].out;
}

// commitment = Poseidon([nullifier, secret]); nullifierHash = Poseidon([nullifier]).
template CommitmentHasher() {
    signal input nullifier;
    signal input secret;
    signal output commitment;
    signal output nullifierHash;

    // nullifier y secret son de 31 bytes (248 bits).
    component nBits = Num2Bits(248);
    nBits.in <== nullifier;
    component sBits = Num2Bits(248);
    sBits.in <== secret;

    component cHasher = Poseidon(2);
    cHasher.inputs[0] <== nullifier;
    cHasher.inputs[1] <== secret;
    commitment <== cHasher.out;

    component nHasher = Poseidon(1);
    nHasher.inputs[0] <== nullifier;
    nullifierHash <== nHasher.out;
}

template Withdraw(levels) {
    signal input root;
    signal input nullifierHash;
    signal input recipient;

    signal input nullifier;
    signal input secret;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component hasher = CommitmentHasher();
    hasher.nullifier <== nullifier;
    hasher.secret <== secret;
    hasher.nullifierHash === nullifierHash;

    component tree = MerkleTreeChecker(levels);
    tree.leaf <== hasher.commitment;
    tree.root <== root;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    // Ata recipient a la prueba para que no se pueda alterar.
    signal recipientSquare;
    recipientSquare <== recipient * recipient;
}

component main {public [root, nullifierHash, recipient]} = Withdraw(10);
