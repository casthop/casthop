#!/usr/bin/env node
// Fail if the committed WASM module grows past the MEASUREMENTS.md budget
// or starts importing JS (AudioWorklet-unsafe).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 500 * 1024;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "src/wasm/casthop_media.wasm");
const buf = readFileSync(path);

if (buf.length < 8 || buf.subarray(0, 4).toString() !== "\0asm") {
  console.error("not a wasm module:", path);
  process.exit(1);
}

function leb(view, start) {
  let n = 0;
  let shift = 0;
  let i = start;
  while (i < view.length) {
    const b = view[i++];
    n |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { n, i };
    shift += 7;
  }
  return { n: 0, i };
}

let imports = 0;
let offset = 8;
while (offset < buf.length) {
  const id = buf[offset++];
  const size = leb(buf, offset);
  offset = size.i;
  const end = offset + size.n;
  if (id === 2) {
    const count = leb(buf, offset);
    imports = count.n;
  }
  offset = end;
}

const kib = (buf.length / 1024).toFixed(1);
console.log(`${path} ${buf.length} bytes (${kib} KiB), imports=${imports}`);
if (buf.length > MAX_BYTES) {
  console.error(`wasm budget ${MAX_BYTES} bytes exceeded`);
  process.exit(1);
}
if (imports !== 0) {
  console.error("wasm must have zero imports (AudioWorklet-safe)");
  process.exit(1);
}
