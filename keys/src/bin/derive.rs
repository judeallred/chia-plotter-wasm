//! Native helper for cross-checking against chia-blockchain.
//! Usage: derive <seed_hex> <farmer_pk_hex> <pool_pk_hex|-> <pool_address|-> <strength>
use plot_keys::*;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let seed: [u8; 32] = hex::decode(&a[1]).unwrap().try_into().unwrap();
    let farmer = chia_bls::G1Element::from_bytes(&hex::decode(&a[2]).unwrap().try_into().unwrap()).unwrap();
    let pool = if a[3] != "-" {
        Pool::PublicKey(chia_bls::G1Element::from_bytes(&hex::decode(&a[3]).unwrap().try_into().unwrap()).unwrap())
    } else {
        Pool::ContractPuzzleHash(decode_address(&a[4]).unwrap())
    };
    let info = derive_plot(&seed, &farmer, &pool, a[5].parse().unwrap(), 0, 0);
    println!("{} {}", hex::encode(info.plot_id), hex::encode(info.memo));
}
