"""Reference plot group ID, plot ID and memo derivation using chia-blockchain's own functions.

Mirrors one iteration of chia.plotting.create_plots.create_v2_plots with a fixed seed.
Usage: python -I derive_reference.py <seed_hex> <farmer_pk_hex> <pool_pk_hex|-> <pool_address|-> <strength>
       [plot_index] [meta_group]
Prints: plot_group_id plot_id memo
"""

import sys

from chia_rs import AugSchemeMPL, G1Element, compute_plot_group_id_v2, compute_plot_id_v2
from chia_rs.sized_ints import uint8, uint16

from chia.types.blockchain_format.proof_of_space import generate_plot_public_key
from chia.util.bech32m import decode_puzzle_hash
from chia.wallet.derive_keys import master_sk_to_local_sk

seed, farmer_hex, pool_hex, pool_addr, strength = sys.argv[1:6]
index = int(sys.argv[6]) if len(sys.argv) > 6 else 0
meta_group = int(sys.argv[7]) if len(sys.argv) > 7 else 0
sk = AugSchemeMPL.key_gen(bytes.fromhex(seed))
farmer = G1Element.from_bytes(bytes.fromhex(farmer_hex))
pool_pk = G1Element.from_bytes(bytes.fromhex(pool_hex)) if pool_hex != "-" else None
pool_ph = decode_puzzle_hash(pool_addr) if pool_pk is None else None
plot_pk = generate_plot_public_key(master_sk_to_local_sk(sk).get_g1(), farmer, is_v2=True)
group_id = compute_plot_group_id_v2(uint8(int(strength)), plot_pk, pool_pk, pool_ph)
plot_id = compute_plot_id_v2(uint8(int(strength)), plot_pk, pool_pk, pool_ph, uint16(index), uint8(meta_group))
memo = bytes(pool_pk if pool_pk is not None else pool_ph) + bytes(farmer) + bytes(sk)
print(group_id.hex(), plot_id.hex(), memo.hex())
