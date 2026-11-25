//! Browser media helpers compiled to WebAssembly.
//!
//! Default build is a C ABI so the same module can load in an `AudioWorklet`, a
//! Worker, or Node without wasm-bindgen glue. Handles live in thread-local
//! storage (one WASM instance per worklet/worker).
//!
//! `--features gpu --no-default-features` builds the WebGPU compositor as a
//! second artifact (`casthop_gpu_bg.wasm`) with JS imports.

mod layout;

#[cfg(feature = "gpu")]
mod gpu;

#[cfg(all(feature = "gpu", target_arch = "wasm32"))]
mod gpu_web;

#[cfg(feature = "media")]
mod compose;
#[cfg(feature = "media")]
mod denoise;
#[cfg(feature = "media")]
mod meter;

#[cfg(feature = "media")]
mod media_abi;

#[cfg(feature = "media")]
pub use media_abi::*;
