//! Derives everything a v2 plot needs besides the plot data itself: the plot ID, the memo
//! stored in the plot header, and the file name. This mirrors `create_v2_plots()` in
//! chia-blockchain (`chia/plotting/create_plots.py`) and `compute_plot_id_v2()` in chia_rs.

use chia_bls::{G1Element, SecretKey};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

/// Pool target for the plot. Plots for pools use a contract puzzle hash, solo plots
/// (legacy, "OG") use a pool public key.
pub enum Pool {
    PublicKey(G1Element),
    ContractPuzzleHash([u8; 32]),
}

pub struct PlotInfo {
    pub plot_id: [u8; 32],
    pub memo: Vec<u8>,
    pub plot_public_key: G1Element,
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// `master_sk_to_local_sk` from chia/wallet/derive_keys.py: path m/12381/8444/3/0.
pub fn master_sk_to_local_sk(master: &SecretKey) -> SecretKey {
    [12381, 8444, 3, 0]
        .iter()
        .fold(master.clone(), |sk, &i| sk.derive_hardened(i))
}

/// `generate_plot_public_key` from chia/types/blockchain_format/proof_of_space.py.
pub fn generate_plot_public_key(local_pk: &G1Element, farmer_pk: &G1Element, include_taproot: bool) -> G1Element {
    let sum = local_pk + farmer_pk;
    if include_taproot {
        let msg = [sum.to_bytes().as_slice(), &local_pk.to_bytes(), &farmer_pk.to_bytes()].concat();
        let taproot_sk = SecretKey::from_seed(&sha256(&[&msg]));
        &sum + &taproot_sk.public_key()
    } else {
        sum
    }
}

pub fn compute_plot_id_v2(strength: u8, plot_pk: &G1Element, pool: &Pool, plot_index: u16, meta_group: u8) -> [u8; 32] {
    let pool_bytes: Vec<u8> = match pool {
        Pool::PublicKey(pk) => pk.to_bytes().to_vec(),
        Pool::ContractPuzzleHash(ph) => ph.to_vec(),
    };
    let group_id = sha256(&[&[strength], &plot_pk.to_bytes(), &pool_bytes]);
    // chia_rs streams integers big endian.
    sha256(&[&group_id, &plot_index.to_be_bytes(), &[meta_group]])
}

/// Same steps as one iteration of `create_v2_plots()`.
pub fn derive_plot(master_seed: &[u8; 32], farmer_pk: &G1Element, pool: &Pool, strength: u8, plot_index: u16, meta_group: u8) -> PlotInfo {
    let sk = SecretKey::from_seed(master_seed);
    let include_taproot = matches!(pool, Pool::ContractPuzzleHash(_));
    let local_pk = master_sk_to_local_sk(&sk).public_key();
    let plot_public_key = generate_plot_public_key(&local_pk, farmer_pk, include_taproot);
    let plot_id = compute_plot_id_v2(strength, &plot_public_key, pool, plot_index, meta_group);
    let pool_bytes: Vec<u8> = match pool {
        Pool::PublicKey(pk) => pk.to_bytes().to_vec(),
        Pool::ContractPuzzleHash(ph) => ph.to_vec(),
    };
    let memo = [pool_bytes.as_slice(), &farmer_pk.to_bytes(), &sk.to_bytes()].concat();
    PlotInfo { plot_id, memo, plot_public_key }
}

fn parse_g1(hex_str: &str) -> Result<G1Element, String> {
    let s = hex_str.trim().trim_start_matches("0x");
    let bytes: [u8; 48] = hex::decode(s)
        .map_err(|e| format!("invalid hex: {e}"))?
        .try_into()
        .map_err(|_| "public key must be 48 bytes (96 hex chars)".to_string())?;
    G1Element::from_bytes(&bytes).map_err(|e| format!("invalid public key: {e}"))
}

/// Decodes a bech32m address (xch1..., txch1...) into its 32-byte puzzle hash.
pub fn decode_address(address: &str) -> Result<[u8; 32], String> {
    let (_hrp, data) = bech32::decode(address.trim()).map_err(|e| format!("invalid address: {e}"))?;
    data.try_into().map_err(|_| "address must encode 32 bytes".to_string())
}

#[wasm_bindgen]
pub struct DerivedPlot {
    plot_id: Vec<u8>,
    memo: Vec<u8>,
    plot_public_key: String,
}

#[wasm_bindgen]
impl DerivedPlot {
    #[wasm_bindgen(getter)]
    pub fn plot_id(&self) -> Vec<u8> {
        self.plot_id.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn plot_id_hex(&self) -> String {
        hex::encode(&self.plot_id)
    }
    #[wasm_bindgen(getter)]
    pub fn memo(&self) -> Vec<u8> {
        self.memo.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn plot_public_key(&self) -> String {
        self.plot_public_key.clone()
    }
}

/// Browser entry point. Exactly one of `pool_public_key` and `pool_contract_address` must be
/// non-empty. `seed` must be 32 random bytes.
#[wasm_bindgen]
pub fn derive(
    seed: &[u8],
    farmer_public_key: &str,
    pool_public_key: &str,
    pool_contract_address: &str,
    strength: u8,
    plot_index: u16,
    meta_group: u8,
) -> Result<DerivedPlot, JsError> {
    let seed: [u8; 32] = seed.try_into().map_err(|_| JsError::new("seed must be 32 bytes"))?;
    let farmer = parse_g1(farmer_public_key).map_err(|e| JsError::new(&format!("farmer key: {e}")))?;
    let pool = match (pool_public_key.trim().is_empty(), pool_contract_address.trim().is_empty()) {
        (false, true) => Pool::PublicKey(parse_g1(pool_public_key).map_err(|e| JsError::new(&format!("pool key: {e}")))?),
        (true, false) => Pool::ContractPuzzleHash(decode_address(pool_contract_address).map_err(|e| JsError::new(&e))?),
        _ => return Err(JsError::new("set exactly one of pool public key or pool contract address")),
    };
    let info = derive_plot(&seed, &farmer, &pool, strength, plot_index, meta_group);
    Ok(DerivedPlot {
        plot_id: info.plot_id.to_vec(),
        memo: info.memo,
        plot_public_key: hex::encode(info.plot_public_key.to_bytes()),
    })
}

/// Validates a farmer or pool public key. Returns an empty string when valid.
#[wasm_bindgen]
pub fn check_public_key(hex_str: &str) -> String {
    parse_g1(hex_str).err().unwrap_or_default()
}

/// Validates a pool contract address. Returns an empty string when valid.
#[wasm_bindgen]
pub fn check_address(address: &str) -> String {
    decode_address(address).err().unwrap_or_default()
}

#[wasm_bindgen]
pub struct MemoInfo {
    farmer_public_key: String,
    pool_public_key: String,
    pool_contract_address: String,
    plot_id_hex: String,
}

#[wasm_bindgen]
impl MemoInfo {
    #[wasm_bindgen(getter)]
    pub fn farmer_public_key(&self) -> String {
        self.farmer_public_key.clone()
    }
    /// Empty when the plot uses a pool contract.
    #[wasm_bindgen(getter)]
    pub fn pool_public_key(&self) -> String {
        self.pool_public_key.clone()
    }
    /// Empty when the plot uses a pool public key.
    #[wasm_bindgen(getter)]
    pub fn pool_contract_address(&self) -> String {
        self.pool_contract_address.clone()
    }
    /// The plot ID implied by the memo keys. It must equal the ID in the plot header.
    #[wasm_bindgen(getter)]
    pub fn plot_id_hex(&self) -> String {
        self.plot_id_hex.clone()
    }
}

/// Decodes a plot memo (pool key or contract puzzle hash, farmer key, plot secret key) and
/// recomputes the plot ID the same way `create_v2_plots()` does. `address_prefix` is "xch"
/// or "txch".
#[wasm_bindgen]
pub fn inspect_memo(memo: &[u8], strength: u8, plot_index: u16, meta_group: u8, address_prefix: &str) -> Result<MemoInfo, JsError> {
    let (pool, rest) = match memo.len() {
        128 => {
            let pk: [u8; 48] = memo[..48].try_into().unwrap();
            let pk = G1Element::from_bytes(&pk).map_err(|e| JsError::new(&format!("pool key in memo: {e}")))?;
            (Pool::PublicKey(pk), &memo[48..])
        }
        112 => (Pool::ContractPuzzleHash(memo[..32].try_into().unwrap()), &memo[32..]),
        n => return Err(JsError::new(&format!("memo is {n} bytes, expected 112 or 128"))),
    };
    let farmer_bytes: [u8; 48] = rest[..48].try_into().unwrap();
    let farmer = G1Element::from_bytes(&farmer_bytes).map_err(|e| JsError::new(&format!("farmer key in memo: {e}")))?;
    let sk_bytes: [u8; 32] = rest[48..80].try_into().unwrap();
    let sk = SecretKey::from_bytes(&sk_bytes).map_err(|e| JsError::new(&format!("plot secret key in memo: {e}")))?;

    let include_taproot = matches!(pool, Pool::ContractPuzzleHash(_));
    let local_pk = master_sk_to_local_sk(&sk).public_key();
    let plot_pk = generate_plot_public_key(&local_pk, &farmer, include_taproot);
    let plot_id = compute_plot_id_v2(strength, &plot_pk, &pool, plot_index, meta_group);

    let (pool_public_key, pool_contract_address) = match &pool {
        Pool::PublicKey(pk) => (hex::encode(pk.to_bytes()), String::new()),
        Pool::ContractPuzzleHash(ph) => {
            let hrp = bech32::Hrp::parse(address_prefix).map_err(|e| JsError::new(&e.to_string()))?;
            let addr = bech32::encode::<bech32::Bech32m>(hrp, ph).map_err(|e| JsError::new(&e.to_string()))?;
            (String::new(), addr)
        }
    };
    Ok(MemoInfo {
        farmer_public_key: hex::encode(farmer.to_bytes()),
        pool_public_key,
        pool_contract_address,
        plot_id_hex: hex::encode(plot_id),
    })
}
