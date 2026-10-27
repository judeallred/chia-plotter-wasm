//! Derives everything a v2 plot needs besides the plot data itself: the plot ID, the plot
//! group ID, and the memo stored in the plot header. This mirrors `create_v2_plots()` in
//! chia-blockchain (`chia/plotting/create_plots.py`) and `compute_plot_id_v2()` in `chia_rs`.
//!
//! The browser bindings live in [`wasm`].

use std::fmt;

use chia_bls::{G1Element, SecretKey};
use sha2::{Digest, Sha256};

pub mod wasm;

/// Bytes in a serialized BLS public key.
const PUBLIC_KEY_LEN: usize = 48;
/// Bytes in a serialized BLS secret key.
const SECRET_KEY_LEN: usize = 32;
/// Bytes in a pool contract puzzle hash.
const PUZZLE_HASH_LEN: usize = 32;

/// Why a key, address or memo could not be used.
#[derive(Debug)]
pub enum Error {
    /// `what` is not valid hex.
    Hex {
        /// The value being parsed.
        what: &'static str,
        /// The decoder's error.
        source: hex::FromHexError,
    },
    /// `what` decoded to the wrong number of bytes.
    Length {
        /// The value being parsed.
        what: &'static str,
        /// Bytes it must have.
        expected: usize,
        /// Bytes it had.
        actual: usize,
    },
    /// `what` is not a valid BLS key.
    Key {
        /// The value being parsed.
        what: &'static str,
        /// Why `chia_bls` rejected it.
        source: chia_bls::Error,
    },
    /// The pool contract address is not valid bech32m.
    Address(bech32::DecodeError),
    /// The address prefix is not a valid bech32 human readable part.
    AddressPrefix(bech32::primitives::hrp::Error),
    /// The address could not be encoded.
    AddressEncode(bech32::EncodeError),
    /// A memo must be 112 (pool contract) or 128 (pool public key) bytes.
    MemoLength(usize),
    /// Exactly one of a pool public key and a pool contract address must be given.
    PoolChoice,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Hex { what, source } => write!(f, "{what}: invalid hex: {source}"),
            Self::Length { what, expected, actual } => {
                write!(
                    f,
                    "{what} must be {expected} bytes ({} hex chars), got {actual}",
                    expected * 2
                )
            }
            Self::Key { what, source } => write!(f, "invalid {what}: {source}"),
            Self::Address(e) => write!(f, "invalid address: {e}"),
            Self::AddressPrefix(e) => write!(f, "invalid address prefix: {e}"),
            Self::AddressEncode(e) => write!(f, "cannot encode address: {e}"),
            Self::MemoLength(n) => write!(f, "memo is {n} bytes, expected 112 or 128"),
            Self::PoolChoice => f.write_str("set exactly one of pool public key or pool contract address"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Hex { source, .. } => Some(source),
            Self::Key { source, .. } => Some(source),
            Self::Address(e) => Some(e),
            Self::AddressPrefix(e) => Some(e),
            Self::AddressEncode(e) => Some(e),
            Self::Length { .. } | Self::MemoLength(_) | Self::PoolChoice => None,
        }
    }
}

/// Pool target for the plot. Plots for pools use a contract puzzle hash, solo plots
/// (legacy, "OG") use a pool public key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pool {
    /// A pool public key (solo plots).
    PublicKey(G1Element),
    /// A pool contract (plot NFT) puzzle hash.
    ContractPuzzleHash([u8; PUZZLE_HASH_LEN]),
}

impl Pool {
    /// The bytes hashed into the plot group ID and stored first in the memo.
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        match self {
            Self::PublicKey(pk) => pk.to_bytes().to_vec(),
            Self::ContractPuzzleHash(ph) => ph.to_vec(),
        }
    }

    /// Pool contract plots add a taproot key to the plot public key.
    #[must_use]
    pub const fn uses_taproot(&self) -> bool {
        matches!(self, Self::ContractPuzzleHash(_))
    }
}

/// The keys stored in a plot's memo: pool, farmer public key and the plot secret key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Memo {
    /// Where pool rewards go.
    pub pool: Pool,
    /// The farmer's public key.
    pub farmer_public_key: G1Element,
    /// The plot's own secret key, which every plot in a group shares.
    pub plot_secret_key: SecretKey,
}

impl Memo {
    /// Parses a memo: pool public key or contract puzzle hash, farmer public key, plot
    /// secret key.
    ///
    /// # Errors
    ///
    /// Fails if the memo has the wrong length or holds an invalid key.
    pub fn parse(memo: &[u8]) -> Result<Self, Error> {
        let wrong_length = || Error::MemoLength(memo.len());
        let (pool, rest) = match memo.len() {
            128 => {
                let (pk, rest) = memo.split_first_chunk::<PUBLIC_KEY_LEN>().ok_or_else(wrong_length)?;
                (Pool::PublicKey(g1_from_bytes(pk, "pool key in memo")?), rest)
            }
            112 => {
                let (ph, rest) = memo.split_first_chunk::<PUZZLE_HASH_LEN>().ok_or_else(wrong_length)?;
                (Pool::ContractPuzzleHash(*ph), rest)
            }
            n => return Err(Error::MemoLength(n)),
        };
        let (farmer, sk) = rest.split_first_chunk::<PUBLIC_KEY_LEN>().ok_or_else(wrong_length)?;
        let sk: &[u8; SECRET_KEY_LEN] = sk.try_into().map_err(|_| wrong_length())?;
        Ok(Self {
            pool,
            farmer_public_key: g1_from_bytes(farmer, "farmer key in memo")?,
            plot_secret_key: SecretKey::from_bytes(sk).map_err(|source| Error::Key {
                what: "plot secret key in memo",
                source,
            })?,
        })
    }

    /// The memo as stored in the plot header.
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        [
            self.pool.to_bytes().as_slice(),
            &self.farmer_public_key.to_bytes(),
            &self.plot_secret_key.to_bytes(),
        ]
        .concat()
    }

    /// The plot public key these keys produce.
    #[must_use]
    pub fn plot_public_key(&self) -> G1Element {
        let local_pk = master_sk_to_local_sk(&self.plot_secret_key).public_key();
        generate_plot_public_key(&local_pk, &self.farmer_public_key, self.pool.uses_taproot())
    }
}

/// A plot's identity: what goes into the header and the file name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlotInfo {
    /// The plot ID, in the header and the file name.
    pub plot_id: [u8; 32],
    /// The group ID the plot filter hashes.
    pub plot_group_id: [u8; 32],
    /// The serialized memo for the header.
    pub memo: Vec<u8>,
    /// The key that signs for the plot.
    pub plot_public_key: G1Element,
}

impl PlotInfo {
    /// The plot that `memo`'s keys produce at a strength and position in the group.
    #[must_use]
    pub fn from_memo(memo: &Memo, strength: u8, plot_index: u16, meta_group: u8) -> Self {
        let plot_public_key = memo.plot_public_key();
        let plot_group_id = compute_plot_group_id_v2(strength, &plot_public_key, &memo.pool);
        Self {
            plot_id: plot_id_from_group(&plot_group_id, plot_index, meta_group),
            plot_group_id,
            memo: memo.to_bytes(),
            plot_public_key,
        }
    }
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn g1_from_bytes(bytes: &[u8; PUBLIC_KEY_LEN], what: &'static str) -> Result<G1Element, Error> {
    G1Element::from_bytes(bytes).map_err(|source| Error::Key { what, source })
}

/// `master_sk_to_local_sk` from `chia/wallet/derive_keys.py`: path `m/12381/8444/3/0`.
#[must_use]
pub fn master_sk_to_local_sk(master: &SecretKey) -> SecretKey {
    [12381, 8444, 3, 0]
        .iter()
        .fold(master.clone(), |sk, &i| sk.derive_hardened(i))
}

/// `generate_plot_public_key` from `chia/types/blockchain_format/proof_of_space.py`.
#[must_use]
pub fn generate_plot_public_key(local_pk: &G1Element, farmer_pk: &G1Element, include_taproot: bool) -> G1Element {
    let sum = local_pk + farmer_pk;
    if include_taproot {
        let taproot_sk = SecretKey::from_seed(&sha256(&[&sum.to_bytes(), &local_pk.to_bytes(), &farmer_pk.to_bytes()]));
        &sum + &taproot_sk.public_key()
    } else {
        sum
    }
}

/// The plot group ID. The v2 plot filter hashes this, not the plot ID, so every plot with
/// the same strength, plot key and pool passes the filter at the same time.
#[must_use]
pub fn compute_plot_group_id_v2(strength: u8, plot_pk: &G1Element, pool: &Pool) -> [u8; 32] {
    sha256(&[&[strength], &plot_pk.to_bytes(), &pool.to_bytes()])
}

fn plot_id_from_group(plot_group_id: &[u8; 32], plot_index: u16, meta_group: u8) -> [u8; 32] {
    // chia_rs streams integers big endian.
    sha256(&[plot_group_id, &plot_index.to_be_bytes(), &[meta_group]])
}

/// `compute_plot_id_v2` from `chia_rs`.
#[must_use]
pub fn compute_plot_id_v2(strength: u8, plot_pk: &G1Element, pool: &Pool, plot_index: u16, meta_group: u8) -> [u8; 32] {
    plot_id_from_group(
        &compute_plot_group_id_v2(strength, plot_pk, pool),
        plot_index,
        meta_group,
    )
}

/// Same steps as one iteration of `create_v2_plots()`: a new plot secret key from
/// `master_seed`, then its plot.
#[must_use]
pub fn derive_plot(
    master_seed: &[u8; 32],
    farmer_pk: &G1Element,
    pool: &Pool,
    strength: u8,
    plot_index: u16,
    meta_group: u8,
) -> PlotInfo {
    let memo = Memo {
        pool: pool.clone(),
        farmer_public_key: *farmer_pk,
        plot_secret_key: SecretKey::from_seed(master_seed),
    };
    PlotInfo::from_memo(&memo, strength, plot_index, meta_group)
}

/// Parses a hex public key, with or without a 0x prefix.
///
/// # Errors
///
/// Fails on invalid hex, the wrong length, or an invalid key.
pub fn parse_public_key(hex_str: &str, what: &'static str) -> Result<G1Element, Error> {
    let bytes = hex::decode(hex_str.trim().trim_start_matches("0x")).map_err(|source| Error::Hex { what, source })?;
    let actual = bytes.len();
    let bytes: [u8; PUBLIC_KEY_LEN] = bytes.try_into().map_err(|_| Error::Length {
        what,
        expected: PUBLIC_KEY_LEN,
        actual,
    })?;
    g1_from_bytes(&bytes, what)
}

/// Decodes a bech32m address (xch1..., txch1...) into its 32 byte puzzle hash.
///
/// # Errors
///
/// Fails if the address is not bech32m or does not encode 32 bytes.
pub fn decode_address(address: &str) -> Result<[u8; PUZZLE_HASH_LEN], Error> {
    let (_hrp, data) = bech32::decode(address.trim()).map_err(Error::Address)?;
    let actual = data.len();
    data.try_into().map_err(|_| Error::Length {
        what: "address",
        expected: PUZZLE_HASH_LEN,
        actual,
    })
}

/// Encodes a puzzle hash as a bech32m address with the given prefix ("xch" or "txch").
///
/// # Errors
///
/// Fails if the prefix is not a valid bech32 human readable part.
pub fn encode_address(puzzle_hash: &[u8; PUZZLE_HASH_LEN], prefix: &str) -> Result<String, Error> {
    let hrp = bech32::Hrp::parse(prefix).map_err(Error::AddressPrefix)?;
    bech32::encode::<bech32::Bech32m>(hrp, puzzle_hash).map_err(Error::AddressEncode)
}

#[cfg(test)]
mod tests {
    //! Expected values come from chia-blockchain's own functions
    //! (`tools/derive_reference.py` and `compute_plot_group_id`).

    use super::*;

    const FARMER: &str =
        "aefe1789d6476f60439e1168f588ea16652dc321279f05a805fbc63933e88ae9c175d6c6ab182e54af562e1a0dce41bb";
    const ADDRESS: &str = "xch1qvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvps82kgr2";
    const SEED: [u8; 32] = [0x11; 32];
    const PLOT_SK: &str = "16e0fa58c7b2abc168e77f08a53ccba89e65f62993af753b4c95a6b6e23a7f25";

    fn hex32(s: &str) -> [u8; 32] {
        let mut out = [0; 32];
        hex::decode_to_slice(s, &mut out).expect("test vector is 32 bytes of hex");
        out
    }

    fn farmer() -> G1Element {
        parse_public_key(FARMER, "farmer key").expect("test farmer key is valid")
    }

    #[test]
    fn derives_pool_contract_plot() {
        assert_eq!(decode_address(ADDRESS).expect("valid address"), [3; 32]);
        let info = derive_plot(&SEED, &farmer(), &Pool::ContractPuzzleHash([3; 32]), 2, 0, 0);
        assert_eq!(
            info.plot_id,
            hex32("3d428cf511f012e7b2dc755c96d0268a49ce49751c7517bfe5ca716bbe3e2fcb")
        );
        assert_eq!(hex::encode(&info.memo), format!("{}{FARMER}{PLOT_SK}", "03".repeat(32)));
    }

    #[test]
    fn derives_pool_public_key_plot() {
        let info = derive_plot(&SEED, &farmer(), &Pool::PublicKey(farmer()), 6, 0, 0);
        assert_eq!(
            info.plot_id,
            hex32("a124d7421255851b9bee34e2d4e93f396b65b04914ec2f8823ad0686c1a84e21")
        );
        assert_eq!(hex::encode(&info.memo), format!("{FARMER}{FARMER}{PLOT_SK}"));
    }

    #[test]
    fn memo_round_trips_and_places_plots_in_the_group() {
        let first = derive_plot(&SEED, &farmer(), &Pool::ContractPuzzleHash([3; 32]), 4, 0, 0);
        let memo = Memo::parse(&first.memo).expect("memo parses");
        assert_eq!(memo.to_bytes(), first.memo);
        let other = PlotInfo::from_memo(&memo, 4, 7, 33);
        assert_eq!(other.plot_group_id, first.plot_group_id);
        assert_eq!(
            other.plot_group_id,
            hex32("8c1e90ef8e0fc23869caab4e3cc5d346242e0bfc1fc80898e76946f7380279df")
        );
        assert_eq!(
            other.plot_id,
            hex32("30fe389bbe502c202a209182861f47c29e28cdb3b4bc5f7ad5dce0a9ba263919")
        );
    }

    #[test]
    fn address_round_trips() {
        assert_eq!(encode_address(&[3; 32], "xch").expect("valid prefix"), ADDRESS);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(matches!(Memo::parse(&[0; 100]), Err(Error::MemoLength(100))));
        assert!(matches!(
            parse_public_key("abcd", "farmer key"),
            Err(Error::Length { actual: 2, .. })
        ));
        assert!(matches!(parse_public_key("zz", "farmer key"), Err(Error::Hex { .. })));
        assert!(decode_address("xch1notanaddress").is_err());
    }
}
