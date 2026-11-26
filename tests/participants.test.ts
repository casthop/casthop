import assert from "node:assert/strict";
import { test } from "node:test";
import { backstageCount } from "../src/lib/participants.ts";

test("backstage count ignores people already on stage", () => {
  assert.equal(backstageCount([]), 0);
  assert.equal(
    backstageCount([
      { onStage: true },
      { onStage: true },
    ]),
    0,
  );
  assert.equal(
    backstageCount([
      { onStage: true },
      { onStage: false },
      { onStage: true },
      { onStage: false },
    ]),
    2,
  );
});
