import simdWasm from "tesseract.js-core/tesseract-core-simd-lstm.wasm";

/** Precompiled for Workers. Dynamic WebAssembly.compile is disallowed there. */
export const simdModule: WebAssembly.Module = simdWasm;
