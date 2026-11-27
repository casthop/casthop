import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { test } from "node:test";
import { Q, SCHEMA } from "../worker/db.ts";

function plan(db: Database, sql: string): string {
  const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all("x") as { detail: string }[];
  return rows.map((r) => r.detail).join("\n");
}

test("account listing and invite lookup use indexes, not full scans", () => {
  const db = new Database(":memory:");
  for (const sql of SCHEMA) db.run(sql);
  for (const name of ["listStudios", "listReplaysForAccount", "listClipsForAccount"] as const) {
    const detail = plan(db, Q[name]);
    assert.doesNotMatch(detail, /SCAN (m|studio_members)\b/, `${name}:\n${detail}`);
    assert.match(detail, /studio_members_account/, `${name}:\n${detail}`);
  }
  const invites = plan(db, Q.invitesByEmail);
  assert.match(invites, /studio_invites_email/, invites);
});
