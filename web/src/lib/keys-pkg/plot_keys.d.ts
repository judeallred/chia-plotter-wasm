/* tslint:disable */
/* eslint-disable */

/**
 * A derived plot's identity, for the plotter and the file name.
 */
export class DerivedPlot {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The memo for the plot header.
     */
    readonly memo: Uint8Array;
    /**
     * The plot group ID bytes, for the plotter and the plot group file header.
     */
    readonly plot_group_id: Uint8Array;
    /**
     * The plot group ID in hex, for the file name. Plots with the same group ID pass the
     * filter together.
     */
    readonly plot_group_id_hex: string;
    /**
     * The plot ID bytes, for the plotter.
     */
    readonly plot_id: Uint8Array;
    /**
     * The plot ID in hex, for the file name.
     */
    readonly plot_id_hex: string;
    /**
     * The plot public key in hex.
     */
    readonly plot_public_key: string;
}

/**
 * What a plot's memo says about it.
 */
export class MemoInfo {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The farmer public key in hex.
     */
    readonly farmer_public_key: string;
    /**
     * Plots with the same group ID pass the plot filter together.
     */
    readonly plot_group_id_hex: string;
    /**
     * The plot ID implied by the memo keys. It must equal the ID in the plot header.
     */
    readonly plot_id_hex: string;
    /**
     * Empty when the plot uses a pool public key.
     */
    readonly pool_contract_address: string;
    /**
     * Empty when the plot uses a pool contract.
     */
    readonly pool_public_key: string;
}

/**
 * Validates a pool contract address. Returns an empty string when valid.
 */
export function check_address(address: string): string;

/**
 * Validates a farmer or pool public key. Returns an empty string when valid.
 */
export function check_public_key(hex_str: string): string;

/**
 * Derives a new plot. Exactly one of `pool_public_key` and `pool_contract_address` must be
 * non-empty. `seed` must be 32 random bytes.
 *
 * # Errors
 *
 * Fails on a bad seed, key or address, or when both or neither pool is set.
 */
export function derive(seed: Uint8Array, farmer_public_key: string, pool_public_key: string, pool_contract_address: string, strength: number, plot_index: number, meta_group: number): DerivedPlot;

/**
 * Derives another plot in the same group as an existing plot, from that plot's memo. The
 * memo holds the plot secret key, so the new plot shares its plot key and group ID.
 *
 * # Errors
 *
 * Fails if the memo does not parse.
 */
export function derive_from_memo(memo: Uint8Array, strength: number, plot_index: number, meta_group: number): DerivedPlot;

/**
 * Decodes a plot memo and recomputes the plot ID the same way `create_v2_plots()` does.
 * `address_prefix` is "xch" or "txch".
 *
 * # Errors
 *
 * Fails if the memo does not parse or the prefix is invalid.
 */
export function inspect_memo(memo: Uint8Array, strength: number, plot_index: number, meta_group: number, address_prefix: string): MemoInfo;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_derivedplot_free: (a: number, b: number) => void;
    readonly __wbg_memoinfo_free: (a: number, b: number) => void;
    readonly check_address: (a: number, b: number) => [number, number];
    readonly check_public_key: (a: number, b: number) => [number, number];
    readonly derive: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly derive_from_memo: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly derivedplot_memo: (a: number) => [number, number];
    readonly derivedplot_plot_group_id: (a: number) => [number, number];
    readonly derivedplot_plot_group_id_hex: (a: number) => [number, number];
    readonly derivedplot_plot_id: (a: number) => [number, number];
    readonly derivedplot_plot_id_hex: (a: number) => [number, number];
    readonly derivedplot_plot_public_key: (a: number) => [number, number];
    readonly inspect_memo: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly memoinfo_farmer_public_key: (a: number) => [number, number];
    readonly memoinfo_plot_group_id_hex: (a: number) => [number, number];
    readonly memoinfo_plot_id_hex: (a: number) => [number, number];
    readonly memoinfo_pool_contract_address: (a: number) => [number, number];
    readonly memoinfo_pool_public_key: (a: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
