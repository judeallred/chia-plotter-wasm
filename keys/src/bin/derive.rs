//! Native helper for cross-checking against chia-blockchain (`tools/derive_reference.py`
//! takes the same arguments). Prints the plot ID and the memo, in hex.
//!
//! Usage: `derive <seed_hex> <farmer_pk_hex> <pool_pk_hex|-> <pool_address|-> <strength>`

use std::process::ExitCode;

use plot_keys::{Pool, decode_address, derive_plot, parse_public_key};

const USAGE: &str = "usage: derive <seed_hex> <farmer_pk_hex> <pool_pk_hex|-> <pool_address|-> <strength>";

fn run(args: &[String]) -> Result<String, String> {
    let [seed, farmer, pool_pk, pool_address, strength] = args else {
        return Err(USAGE.to_owned());
    };
    let mut seed_bytes = [0; 32];
    hex::decode_to_slice(seed, &mut seed_bytes).map_err(|e| format!("seed must be 32 bytes of hex: {e}"))?;
    let farmer = parse_public_key(farmer, "farmer key").map_err(|e| e.to_string())?;
    let pool = if pool_pk == "-" {
        Pool::ContractPuzzleHash(decode_address(pool_address).map_err(|e| e.to_string())?)
    } else {
        Pool::PublicKey(parse_public_key(pool_pk, "pool key").map_err(|e| e.to_string())?)
    };
    let strength = strength.parse().map_err(|e| format!("strength: {e}"))?;
    let info = derive_plot(&seed_bytes, &farmer, &pool, strength, 0, 0);
    Ok(format!("{} {}", hex::encode(info.plot_id), hex::encode(info.memo)))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(line) => {
            #[allow(clippy::print_stdout, reason = "printing the result is this tool's job")]
            {
                println!("{line}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            #[allow(clippy::print_stderr, reason = "reporting usage errors")]
            {
                eprintln!("{e}");
            }
            ExitCode::FAILURE
        }
    }
}
