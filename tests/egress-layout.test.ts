import assert from "node:assert/strict";
import { test } from "node:test";
import { egressLayoutMode, shouldWriteLiveBuffer } from "../src/lib/egress-layout.ts";

test("portrait layouts do not write the live buffer", () => {
  for (const l of ["portrait", "vertical", "9:16", "Portrait"]) {
    assert.equal(shouldWriteLiveBuffer(l), false, l);
    assert.equal(egressLayoutMode(l), "portrait");
  }
});

test("landscape layouts write the live buffer", () => {
  for (const l of ["grid", "solo", "side", "screen", ""]) {
    assert.equal(shouldWriteLiveBuffer(l), true, l);
  }
});
