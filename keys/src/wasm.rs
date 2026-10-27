//! Browser API, built with wasm-pack into `web/src/lib/keys-pkg`. Thin wrappers over the
//! crate's functions that take hex and bech32 strings and return JavaScript errors.

use wasm_bindgen::prelude::*;

use crate::{Error, Memo, PlotInfo, Pool, decode_address, derive_plot, encode_address, parse_public_key};

/// `JsError` only works on wasm32, so the conversion is the last step of every export.
fn js(e: &Error) -> JsError {
    JsError::new(&e.to_string())
}

/// A derived plot's identity, for the plotter and the file name.
#[wasm_bindgen]
#[derive(Debug)]
pub struct DerivedPlot {
    info: PlotInfo,
}

#[wasm_bindgen]
impl DerivedPlot {
    /// The plot ID bytes, for the plotter.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn plot_id(&self) -> Vec<u8> {
        self.info.plot_id.to_vec()
    }

    /// The plot ID in hex, for the file name.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn plot_id_hex(&self) -> String {
        hex::encode(self.info.plot_id)
    }

    /// The plot group ID in hex. Plots with the same group ID pass the filter together.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn plot_group_id_hex(&self) -> String {
        hex::encode(self.info.plot_group_id)
    }

    /// The memo for the plot header.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn memo(&self) -> Vec<u8> {
        self.info.memo.clone()
    }

    /// The plot public key in hex.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn plot_public_key(&self) -> String {
        hex::encode(self.info.plot_public_key.to_bytes())
    }
}

/// Derives a new plot. Exactly one of `pool_public_key` and `pool_contract_address` must be
/// non-empty. `seed` must be 32 random bytes.
///
/// # Errors
///
/// Fails on a bad seed, key or address, or when both or neither pool is set.
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
    let seed: &[u8; 32] = seed.try_into().map_err(|_| {
        js(&Error::Length {
            what: "seed",
            expected: 32,
            actual: seed.len(),
        })
    })?;
    let farmer = parse_public_key(farmer_public_key, "farmer key").map_err(|e| js(&e))?;
    let pool = match (
        pool_public_key.trim().is_empty(),
        pool_contract_address.trim().is_empty(),
    ) {
        (false, true) => Pool::PublicKey(parse_public_key(pool_public_key, "pool key").map_err(|e| js(&e))?),
        (true, false) => Pool::ContractPuzzleHash(decode_address(pool_contract_address).map_err(|e| js(&e))?),
        _ => return Err(js(&Error::PoolChoice)),
    };
    Ok(DerivedPlot {
        info: derive_plot(seed, &farmer, &pool, strength, plot_index, meta_group),
    })
}

/// Derives another plot in the same group as an existing plot, from that plot's memo. The
/// memo holds the plot secret key, so the new plot shares its plot key and group ID.
///
/// # Errors
///
/// Fails if the memo does not parse.
#[wasm_bindgen]
pub fn derive_from_memo(memo: &[u8], strength: u8, plot_index: u16, meta_group: u8) -> Result<DerivedPlot, JsError> {
    let memo = Memo::parse(memo).map_err(|e| js(&e))?;
    Ok(DerivedPlot {
        info: PlotInfo::from_memo(&memo, strength, plot_index, meta_group),
    })
}

/// Validates a farmer or pool public key. Returns an empty string when valid.
#[wasm_bindgen]
#[must_use]
pub fn check_public_key(hex_str: &str) -> String {
    parse_public_key(hex_str, "public key")
        .err()
        .map(|e| e.to_string())
        .unwrap_or_default()
}

/// Validates a pool contract address. Returns an empty string when valid.
#[wasm_bindgen]
#[must_use]
pub fn check_address(address: &str) -> String {
    decode_address(address).err().map(|e| e.to_string()).unwrap_or_default()
}

/// What a plot's memo says about it.
#[wasm_bindgen]
#[derive(Debug)]
pub struct MemoInfo {
    farmer_public_key: String,
    pool_public_key: String,
    pool_contract_address: String,
    plot_id_hex: String,
    plot_group_id_hex: String,
}

#[wasm_bindgen]
impl MemoInfo {
    /// The farmer public key in hex.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn farmer_public_key(&self) -> String {
        self.farmer_public_key.clone()
    }

    /// Empty when the plot uses a pool contract.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn pool_public_key(&self) -> String {
        self.pool_public_key.clone()
    }

    /// Empty when the plot uses a pool public key.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn pool_contract_address(&self) -> String {
        self.pool_contract_address.clone()
    }

    /// The plot ID implied by the memo keys. It must equal the ID in the plot header.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn plot_id_hex(&self) -> String {
        self.plot_id_hex.clone()
    }

    /// Plots with the same group ID pass the plot filter together.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn plot_group_id_hex(&self) -> String {
        self.plot_group_id_hex.clone()
    }
}

/// Decodes a plot memo and recomputes the plot ID the same way `create_v2_plots()` does.
/// `address_prefix` is "xch" or "txch".
///
/// # Errors
///
/// Fails if the memo does not parse or the prefix is invalid.
#[wasm_bindgen]
pub fn inspect_memo(
    memo: &[u8],
    strength: u8,
    plot_index: u16,
    meta_group: u8,
    address_prefix: &str,
) -> Result<MemoInfo, JsError> {
    let memo = Memo::parse(memo).map_err(|e| js(&e))?;
    let info = PlotInfo::from_memo(&memo, strength, plot_index, meta_group);
    let (pool_public_key, pool_contract_address) = match &memo.pool {
        Pool::PublicKey(pk) => (hex::encode(pk.to_bytes()), String::new()),
        Pool::ContractPuzzleHash(ph) => (String::new(), encode_address(ph, address_prefix).map_err(|e| js(&e))?),
    };
    Ok(MemoInfo {
        farmer_public_key: hex::encode(memo.farmer_public_key.to_bytes()),
        pool_public_key,
        pool_contract_address,
        plot_id_hex: hex::encode(info.plot_id),
        plot_group_id_hex: hex::encode(info.plot_group_id),
    })
}
