/* tslint:disable */
/* eslint-disable */

export class DerivedPlot {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly memo: Uint8Array;
    readonly plot_id: Uint8Array;
    readonly plot_id_hex: string;
    readonly plot_public_key: string;
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
 * Browser entry point. Exactly one of `pool_public_key` and `pool_contract_address` must be
 * non-empty. `seed` must be 32 random bytes.
 */
export function derive(seed: Uint8Array, farmer_public_key: string, pool_public_key: string, pool_contract_address: string, strength: number, plot_index: number, meta_group: number): DerivedPlot;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_derivedplot_free: (a: number, b: number) => void;
    readonly check_address: (a: number, b: number) => [number, number];
    readonly check_public_key: (a: number, b: number) => [number, number];
    readonly derive: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly derivedplot_memo: (a: number) => [number, number];
    readonly derivedplot_plot_id: (a: number) => [number, number];
    readonly derivedplot_plot_id_hex: (a: number) => [number, number];
    readonly derivedplot_plot_public_key: (a: number) => [number, number];
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
