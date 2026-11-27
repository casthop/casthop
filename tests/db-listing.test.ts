import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { test } from "node:test";
import { LIST_STUDIOS_MAX, Q, SCHEMA } from "../worker/db.ts";

test("the studio list returns at most LIST_STUDIOS_MAX rows, newest first", () => {
  const db = new Database(":memory:");
  for (const sql of SCHEMA) db.run(sql);
  db.run("ALTER TABLE studios ADD COLUMN tenant_id TEXT");
  const studio = db.prepare(Q.insertStudio);
  const member = db.prepare(Q.insertMember);
  for (let i = 0; i < LIST_STUDIOS_MAX + 25; i++) {
    studio.run(`s${i}`, `S${i}`, i, "someone", null);
    member.run(`s${i}`, "acct", "cohost", i);
  }
  const rows = db.query(Q.listStudios).all("acct") as { id: string }[];
  assert.equal(rows.length, LIST_STUDIOS_MAX);
  assert.equal(rows[0]?.id, `s${LIST_STUDIOS_MAX + 24}`);
});

test("owner insert adds no row when the account is at the studio cap", () => {
  const db = new Database(":memory:");
  for (const sql of SCHEMA) db.run(sql);
  db.run("ALTER TABLE studios ADD COLUMN tenant_id TEXT");
  const studio = db.prepare(Q.insertStudio);
  const owner = db.prepare(Q.insertOwnerIfUnderCap);
  for (let i = 0; i < 8; i++) {
    studio.run(`s${i}`, `S${i}`, i, "acct", null);
    owner.run(`s${i}`, "acct", i, "acct", 3);
  }
  const row = db.query(Q.countOwnedStudios).get("acct") as { n: number };
  assert.equal(row.n, 3);
});
