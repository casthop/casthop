import assert from "node:assert/strict";
import { test } from "node:test";
import { canConnectToStudio } from "../src/lib/studio-entry.ts";
import type { Session } from "../src/lib/session.ts";

const guestSession: Session = {
  studioId: "abc",
  identity: "g-1",
  name: "Ada",
  role: "guest",
  guestSecret: "secret",
};

test("unsigned visitors cannot connect to the studio", () => {
  assert.equal(canConnectToStudio("guest", null), false);
});

test("owners and co-hosts connect without a guest session", () => {
  assert.equal(canConnectToStudio("owner", null), true);
  assert.equal(canConnectToStudio("cohost", null), true);
});

test("a guest session from Join backstage can connect", () => {
  assert.equal(canConnectToStudio("guest", guestSession), true);
  assert.equal(canConnectToStudio("owner", guestSession), true);
});
