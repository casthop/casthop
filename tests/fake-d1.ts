import { LIST_CLIPS_PER_STUDIO, LIST_REPLAYS_PER_STUDIO, Q, SCHEMA } from "../worker/db.ts";

type Row = Record<string, unknown>;

function clone<T>(v: T): T {
  return structuredClone(v);
}

function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

export class FakeD1 implements D1Database {
  private tables = new Map<string, Row[]>();
  private schema = new Set<string>();

  constructor() {
    for (const name of [
      "accounts",
      "sessions",
      "magic_links",
      "oauth_states",
      "studios",
      "studio_members",
      "studio_invites",
      "rate_limits",
      "replays",
      "clips",
      "used_jtis",
      "service_nonces",
    ]) {
      this.tables.set(name, []);
    }
  }

  prepare(query: string): D1PreparedStatement {
    return new FakeStmt(this, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const out: D1Result<T>[] = [];
    for (const stmt of statements) {
      out.push((await stmt.run()) as D1Result<T>);
    }
    return out;
  }

  async exec(query: string): Promise<D1ExecResult> {
    for (const part of query.split(";")) {
      if (part.trim()) await this.prepare(part).run();
    }
    return { count: 0, duration: 0 };
  }

  dump(): Promise<ArrayBuffer> {
    return Promise.resolve(new ArrayBuffer(0));
  }

  withSession(): D1Database {
    return this;
  }

  rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }

  expireAllSessions(): void {
    for (const row of this.rows("sessions")) {
      row.expires_at = 1;
    }
  }

  setSessionRotatedAt(at: number): void {
    for (const row of this.rows("sessions")) {
      row.rotated_at = at;
    }
  }

  runSql(sql: string, binds: unknown[]): { results: Row[]; changes: number } {
    const q = norm(sql);
    if (SCHEMA.some((s) => norm(s) === q) || q.startsWith("CREATE TABLE") || q.startsWith("CREATE UNIQUE INDEX") || q.startsWith("CREATE INDEX")) {
      this.schema.add(q);
      return { results: [], changes: 0 };
    }
    if (q.startsWith("ALTER TABLE")) {
      return { results: [], changes: 0 };
    }
    if (q === norm(Q.insertAccount)) {
      const [id, email, name, github_id, created_at] = binds;
      if (email && this.rows("accounts").some((r) => r.email === email)) throw new Error("UNIQUE email");
      if (github_id && this.rows("accounts").some((r) => r.github_id === github_id)) throw new Error("UNIQUE github");
      this.rows("accounts").push({ id, email, name, github_id, created_at });
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.accountById)) {
      return { results: this.rows("accounts").filter((r) => r.id === binds[0]).map(clone), changes: 0 };
    }
    if (q === norm(Q.accountByEmail)) {
      return { results: this.rows("accounts").filter((r) => r.email === binds[0]).map(clone), changes: 0 };
    }
    if (q === norm(Q.accountByGithub)) {
      return { results: this.rows("accounts").filter((r) => r.github_id === binds[0]).map(clone), changes: 0 };
    }
    if (q === norm(Q.updateAccountGithub)) {
      const [github_id, name, id] = binds;
      for (const r of this.rows("accounts")) {
        if (r.id === id) {
          r.github_id = github_id;
          r.name = name;
        }
      }
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.updateAccountName)) {
      const [name, id] = binds;
      for (const r of this.rows("accounts")) if (r.id === id) r.name = name;
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.insertSession)) {
      const [id, account_id, token_hash, prev_token_hash, expires_at, created_at, rotated_at] = binds;
      this.rows("sessions").push({ id, account_id, token_hash, prev_token_hash, expires_at, created_at, rotated_at });
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.sessionByToken)) {
      const hash = binds[0];
      return {
        results: this.rows("sessions")
          .filter((r) => r.token_hash === hash || r.prev_token_hash === hash)
          .map(clone),
        changes: 0,
      };
    }
    if (q === norm(Q.deleteSession)) {
      const next = this.rows("sessions").filter((r) => r.id !== binds[0]);
      this.tables.set("sessions", next);
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.deleteExpiredSessions)) {
      const next = this.rows("sessions").filter((r) => Number(r.expires_at) >= Number(binds[0]));
      this.tables.set("sessions", next);
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.deleteExpiredMagic)) {
      this.tables.set(
        "magic_links",
        this.rows("magic_links").filter((r) => Number(r.expires_at) >= Number(binds[0])),
      );
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.deleteExpiredOauth)) {
      this.tables.set(
        "oauth_states",
        this.rows("oauth_states").filter((r) => Number(r.expires_at) >= Number(binds[0])),
      );
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.deleteStaleRates)) {
      this.tables.set(
        "rate_limits",
        this.rows("rate_limits").filter((r) => Number(r.window_start) >= Number(binds[0])),
      );
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.rotateSession)) {
      const [token_hash, prev_token_hash, rotated_at, expires_at, id, expected_hash] = binds;
      const row = this.rows("sessions").find((r) => r.id === id && r.token_hash === expected_hash);
      if (!row) return { results: [], changes: 0 };
      row.token_hash = token_hash;
      row.prev_token_hash = prev_token_hash;
      row.rotated_at = rotated_at;
      row.expires_at = expires_at;
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.insertMagic)) {
      const [token_hash, email, expires_at, created_at] = binds;
      this.rows("magic_links").push({ token_hash, email, expires_at, consumed_at: null, created_at });
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.magicByHash)) {
      return { results: this.rows("magic_links").filter((r) => r.token_hash === binds[0]).map(clone), changes: 0 };
    }
    if (q === norm(Q.consumeMagic)) {
      const [consumed_at, token_hash] = binds;
      const row = this.rows("magic_links").find((r) => r.token_hash === token_hash && r.consumed_at == null);
      if (!row) return { results: [], changes: 0 };
      row.consumed_at = consumed_at;
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.insertOauth)) {
      this.rows("oauth_states").push({ state: binds[0], expires_at: binds[1] });
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.oauthByState)) {
      return { results: this.rows("oauth_states").filter((r) => r.state === binds[0]).map(clone), changes: 0 };
    }
    if (q === norm(Q.deleteOauth)) {
      this.tables.set(
        "oauth_states",
        this.rows("oauth_states").filter((r) => r.state !== binds[0]),
      );
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.insertStudio)) {
      const [id, title, created_at, owner_id, tenant_id] = binds;
      this.rows("studios").push({ id, title, created_at, owner_id, tenant_id });
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.studioById)) {
      return { results: this.rows("studios").filter((r) => r.id === binds[0]).map(clone), changes: 0 };
    }
    if (q === norm(Q.listStudios)) {
      const accountId = binds[0];
      const results: Row[] = [];
      for (const m of this.rows("studio_members")) {
        if (m.account_id !== accountId) continue;
        const s = this.rows("studios").find((row) => row.id === m.studio_id);
        if (!s) continue;
        results.push({ id: s.id, title: s.title, owner_id: s.owner_id, created_at: s.created_at, role: m.role });
      }
      results.sort((a, b) => Number(b.created_at) - Number(a.created_at));
      return { results, changes: 0 };
    }
    if (q === norm(Q.insertMember)) {
      const [studio_id, account_id, role, created_at] = binds;
      this.rows("studio_members").push({ studio_id, account_id, role, created_at });
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.memberByStudioAccount)) {
      return {
        results: this.rows("studio_members")
          .filter((r) => r.studio_id === binds[0] && r.account_id === binds[1])
          .map(clone),
        changes: 0,
      };
    }
    if (q === norm(Q.membersByStudio)) {
      const results: Row[] = [];
      for (const m of this.rows("studio_members")) {
        if (m.studio_id !== binds[0]) continue;
        const a = this.rows("accounts").find((row) => row.id === m.account_id);
        if (!a) continue;
        results.push({ account_id: m.account_id, role: m.role, email: a.email, name: a.name });
      }
      return { results, changes: 0 };
    }
    if (q === norm(Q.deleteCohost)) {
      this.tables.set(
        "studio_members",
        this.rows("studio_members").filter(
          (r) => !(r.studio_id === binds[0] && r.account_id === binds[1] && r.role === "cohost"),
        ),
      );
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.insertInvite)) {
      const [id, studio_id, email, created_at] = binds;
      this.rows("studio_invites").push({ id, studio_id, email, created_at });
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.invitesByStudio)) {
      return { results: this.rows("studio_invites").filter((r) => r.studio_id === binds[0]).map(clone), changes: 0 };
    }
    if (q === norm(Q.invitesByEmail)) {
      return { results: this.rows("studio_invites").filter((r) => r.email === binds[0]).map(clone), changes: 0 };
    }
    if (q === norm(Q.deleteInvite)) {
      this.tables.set(
        "studio_invites",
        this.rows("studio_invites").filter((r) => !(r.studio_id === binds[0] && r.email === binds[1])),
      );
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.insertReplay)) {
      const [id, studio_id, title, visibility, duration_ms, created_at, bytes, files] = binds;
      this.rows("replays").push({
        id,
        studio_id,
        title,
        visibility,
        duration_ms,
        created_at,
        bytes,
        files: files ?? 0,
      });
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.replayById)) {
      return { results: this.rows("replays").filter((r) => r.id === binds[0]).map(clone), changes: 0 };
    }
    if (q === norm(Q.listReplaysByStudio)) {
      const results = this.rows("replays")
        .filter((r) => r.studio_id === binds[0])
        .map(clone)
        .sort((a, b) => Number(b.created_at) - Number(a.created_at));
      return { results, changes: 0 };
    }
    if (q === norm(Q.listReplaysForAccount)) {
      const studioIds = new Set(
        this.rows("studio_members").filter((m) => m.account_id === binds[0]).map((m) => m.studio_id),
      );
      const grouped = new Map<string, Row[]>();
      const sorted = this.rows("replays")
        .filter((r) => studioIds.has(r.studio_id))
        .sort((a, b) => {
          const studios = String(a.studio_id).localeCompare(String(b.studio_id));
          if (studios !== 0) return studios;
          return Number(b.created_at) - Number(a.created_at);
        });
      for (const row of sorted) {
        const list = grouped.get(String(row.studio_id)) ?? [];
        if (list.length >= LIST_REPLAYS_PER_STUDIO) continue;
        list.push(clone(row));
        grouped.set(String(row.studio_id), list);
      }
      return { results: [...grouped.values()].flat(), changes: 0 };
    }
    if (q === norm(Q.updateReplayVisibility)) {
      const [visibility, id] = binds;
      for (const r of this.rows("replays")) {
        if (r.id === id) r.visibility = visibility;
      }
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.countReplaysByStudio)) {
      const n = this.rows("replays").filter((r) => r.studio_id === binds[0]).length;
      return { results: [{ n }], changes: 0 };
    }
    if (q === norm(Q.addReplayUsage)) {
      const [bytesDelta, filesDelta, id] = binds;
      const row = this.rows("replays").find((r) => r.id === id);
      if (!row) return { results: [], changes: 0 };
      row.bytes = Math.max(0, Number(row.bytes) + Number(bytesDelta));
      row.files = Math.max(0, Number(row.files ?? 0) + Number(filesDelta));
      return { results: [{ bytes: row.bytes, files: row.files }], changes: 1 };
    }
    if (q === norm(Q.addReplayUsageIfUnderCap)) {
      const [bytesDelta, filesDelta, id, bytesCheck, maxBytes, filesCheck, maxFiles] = binds;
      const row = this.rows("replays").find((r) => r.id === id);
      if (!row) return { results: [], changes: 0 };
      if (Number(row.bytes) + Number(bytesCheck) > Number(maxBytes)) return { results: [], changes: 0 };
      if (Number(row.files ?? 0) + Number(filesCheck) > Number(maxFiles)) return { results: [], changes: 0 };
      row.bytes = Math.max(0, Number(row.bytes) + Number(bytesDelta));
      row.files = Math.max(0, Number(row.files ?? 0) + Number(filesDelta));
      return { results: [{ bytes: row.bytes, files: row.files }], changes: 1 };
    }
    if (q === norm(Q.insertClip)) {
      const [id, studio_id, title, visibility, duration_ms, seconds, created_at, bytes, files] = binds;
      this.rows("clips").push({
        id,
        studio_id,
        title,
        visibility,
        duration_ms,
        seconds,
        created_at,
        bytes,
        files: files ?? 0,
      });
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.clipById)) {
      return { results: this.rows("clips").filter((r) => r.id === binds[0]).map(clone), changes: 0 };
    }
    if (q === norm(Q.listClipsByStudio)) {
      const results = this.rows("clips")
        .filter((r) => r.studio_id === binds[0])
        .map(clone)
        .sort((a, b) => Number(b.created_at) - Number(a.created_at));
      return { results, changes: 0 };
    }
    if (q === norm(Q.listClipsForAccount)) {
      const studioIds = new Set(
        this.rows("studio_members").filter((m) => m.account_id === binds[0]).map((m) => m.studio_id),
      );
      const grouped = new Map<string, Row[]>();
      const sorted = this.rows("clips")
        .filter((r) => studioIds.has(r.studio_id))
        .sort((a, b) => {
          const studios = String(a.studio_id).localeCompare(String(b.studio_id));
          if (studios !== 0) return studios;
          return Number(b.created_at) - Number(a.created_at);
        });
      for (const row of sorted) {
        const list = grouped.get(String(row.studio_id)) ?? [];
        if (list.length >= LIST_CLIPS_PER_STUDIO) continue;
        list.push(clone(row));
        grouped.set(String(row.studio_id), list);
      }
      return { results: [...grouped.values()].flat(), changes: 0 };
    }
    if (q === norm(Q.updateClipVisibility)) {
      const [visibility, id] = binds;
      for (const r of this.rows("clips")) {
        if (r.id === id) r.visibility = visibility;
      }
      return { results: [], changes: 1 };
    }
    if (q === norm(Q.countClipsByStudio)) {
      const n = this.rows("clips").filter((r) => r.studio_id === binds[0]).length;
      return { results: [{ n }], changes: 0 };
    }
    if (q === norm(Q.studioTenant)) {
      const rows = this.rows("studios").filter((r) => r.id === binds[0]);
      return { results: rows.map((r) => ({ tenant_id: r.tenant_id ?? null })), changes: 0 };
    }
    if (q === norm(Q.studiosByTenant)) {
      const results = this.rows("studios")
        .filter((r) => r.tenant_id === binds[0])
        .map((r) => ({ id: r.id, title: r.title, owner_id: r.owner_id, created_at: r.created_at }))
        .sort((a, b) => Number(a.created_at) - Number(b.created_at));
      return { results, changes: 0 };
    }
    const byStudio: [string, string, string][] = [
      [Q.deleteStudioMembers, "studio_members", "studio_id"],
      [Q.deleteStudioInvites, "studio_invites", "studio_id"],
      [Q.deleteStudioReplays, "replays", "studio_id"],
      [Q.deleteStudioClips, "clips", "studio_id"],
      [Q.deleteStudio, "studios", "id"],
    ];
    for (const [sqlText, table, col] of byStudio) {
      if (q !== norm(sqlText)) continue;
      this.tables.set(
        table,
        this.rows(table).filter((r) => r[col] !== binds[0]),
      );
      return { results: [], changes: 1 };
    }
    for (const [insertSql, pruneSql, table, col] of [
      [Q.insertJti, Q.deleteExpiredJtis, "used_jtis", "jti"],
      [Q.insertNonce, Q.deleteExpiredNonces, "service_nonces", "nonce"],
    ] as const) {
      if (q === norm(insertSql)) {
        if (this.rows(table).some((r) => r[col] === binds[0])) throw new Error(`UNIQUE ${col}`);
        this.rows(table).push({ [col]: binds[0], exp: binds[1] });
        return { results: [], changes: 1 };
      }
      if (q === norm(pruneSql)) {
        this.tables.set(
          table,
          this.rows(table).filter((r) => Number(r.exp) >= Number(binds[0])),
        );
        return { results: [], changes: 1 };
      }
    }
    if (q === norm(Q.bumpRate)) {
      const [key, nowBind, , windowBind] = binds;
      const now = Number(nowBind);
      const windowMs = Number(windowBind);
      let row = this.rows("rate_limits").find((r) => r.key === key);
      if (!row) {
        row = { key, count: 1, window_start: now };
        this.rows("rate_limits").push(row);
      } else if (now - Number(row.window_start) > windowMs) {
        row.count = 1;
        row.window_start = now;
      } else {
        row.count = Number(row.count) + 1;
      }
      return { results: [{ count: row.count }], changes: 1 };
    }
    throw new Error(`unhandled sql: ${q}`);
  }
}

class FakeStmt implements D1PreparedStatement {
  private binds: unknown[] = [];

  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.binds = values;
    return this;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const { results } = this.db.runSql(this.sql, this.binds);
    const row = results[0];
    if (!row) return null;
    if (colName) return (row[colName] as T) ?? null;
    return row as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const { changes } = this.db.runSql(this.sql, this.binds);
    return { success: true, meta: { changes, duration: 0, size_after: 0, rows_read: 0, rows_written: changes, last_row_id: 0, changed_db: changes > 0 } as D1Meta, results: [] };
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const { results } = this.db.runSql(this.sql, this.binds);
    return { success: true, meta: { changes: 0, duration: 0, size_after: 0, rows_read: results.length, rows_written: 0, last_row_id: 0, changed_db: false } as D1Meta, results: results as T[] };
  }

  raw<T = unknown[]>(): Promise<T[]> {
    return Promise.resolve([]);
  }
}
