import type { Account, MemberRole, ReplayRecord, ReplayVisibility, StudioMember, StudioRecord } from "./types";
import { SIGNIN_WINDOW_MS } from "./security";

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT,
    name TEXT NOT NULL,
    github_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS accounts_email ON accounts(email)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS accounts_github ON accounts(github_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prev_token_hash TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    rotated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_prev ON sessions(prev_token_hash)`,
  `CREATE TABLE IF NOT EXISTS magic_links (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS studios (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    owner_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS studio_members (
    studio_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (studio_id, account_id)
  )`,
  `CREATE TABLE IF NOT EXISTS studio_invites (
    id TEXT PRIMARY KEY,
    studio_id TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (studio_id, email)
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    window_start INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS replays (
    id TEXT PRIMARY KEY,
    studio_id TEXT NOT NULL,
    title TEXT NOT NULL,
    visibility TEXT NOT NULL,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    bytes INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS replays_studio ON replays(studio_id, created_at)`,
] as const;

export const LIST_REPLAYS_PER_STUDIO = 20;

export const Q = {
  insertAccount: "INSERT INTO accounts (id, email, name, github_id, created_at) VALUES (?, ?, ?, ?, ?)",
  accountById: "SELECT id, email, name, github_id, created_at FROM accounts WHERE id = ?",
  accountByEmail: "SELECT id, email, name, github_id, created_at FROM accounts WHERE email = ?",
  accountByGithub: "SELECT id, email, name, github_id, created_at FROM accounts WHERE github_id = ?",
  updateAccountGithub: "UPDATE accounts SET github_id = ?, name = ? WHERE id = ?",
  updateAccountName: "UPDATE accounts SET name = ? WHERE id = ?",
  insertSession:
    "INSERT INTO sessions (id, account_id, token_hash, prev_token_hash, expires_at, created_at, rotated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  sessionByToken: "SELECT * FROM sessions WHERE token_hash = ? OR prev_token_hash = ?",
  deleteSession: "DELETE FROM sessions WHERE id = ?",
  deleteExpiredSessions: "DELETE FROM sessions WHERE expires_at < ?",
  deleteExpiredMagic: "DELETE FROM magic_links WHERE expires_at < ?",
  deleteExpiredOauth: "DELETE FROM oauth_states WHERE expires_at < ?",
  deleteStaleRates: "DELETE FROM rate_limits WHERE window_start < ?",
  rotateSession: "UPDATE sessions SET token_hash = ?, prev_token_hash = ?, rotated_at = ?, expires_at = ? WHERE id = ? AND token_hash = ?",
  insertMagic: "INSERT INTO magic_links (token_hash, email, expires_at, consumed_at, created_at) VALUES (?, ?, ?, NULL, ?)",
  magicByHash: "SELECT token_hash, email, expires_at, consumed_at, created_at FROM magic_links WHERE token_hash = ?",
  consumeMagic: "UPDATE magic_links SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL",
  insertOauth: "INSERT INTO oauth_states (state, expires_at) VALUES (?, ?)",
  oauthByState: "SELECT state, expires_at FROM oauth_states WHERE state = ?",
  deleteOauth: "DELETE FROM oauth_states WHERE state = ?",
  insertStudio: "INSERT INTO studios (id, title, created_at, owner_id) VALUES (?, ?, ?, ?)",
  studioById: "SELECT id, title, created_at, owner_id FROM studios WHERE id = ?",
  listStudios:
    "SELECT s.id, s.title, s.owner_id, s.created_at, m.role FROM studios s INNER JOIN studio_members m ON m.studio_id = s.id WHERE m.account_id = ? ORDER BY s.created_at DESC",
  insertMember: "INSERT INTO studio_members (studio_id, account_id, role, created_at) VALUES (?, ?, ?, ?)",
  memberByStudioAccount: "SELECT studio_id, account_id, role, created_at FROM studio_members WHERE studio_id = ? AND account_id = ?",
  membersByStudio:
    "SELECT m.account_id, m.role, a.email, a.name FROM studio_members m INNER JOIN accounts a ON a.id = m.account_id WHERE m.studio_id = ?",
  deleteCohost: "DELETE FROM studio_members WHERE studio_id = ? AND account_id = ? AND role = 'cohost'",
  insertInvite: "INSERT INTO studio_invites (id, studio_id, email, created_at) VALUES (?, ?, ?, ?)",
  invitesByStudio: "SELECT id, studio_id, email, created_at FROM studio_invites WHERE studio_id = ?",
  invitesByEmail: "SELECT id, studio_id, email, created_at FROM studio_invites WHERE email = ?",
  deleteInvite: "DELETE FROM studio_invites WHERE studio_id = ? AND email = ?",
  bumpRate:
    "INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN ? - window_start > ? THEN 1 ELSE count + 1 END, window_start = CASE WHEN ? - window_start > ? THEN ? ELSE window_start END RETURNING count",
  insertReplay:
    "INSERT INTO replays (id, studio_id, title, visibility, duration_ms, created_at, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
  replayById: "SELECT id, studio_id, title, visibility, duration_ms, created_at, bytes FROM replays WHERE id = ?",
  listReplaysByStudio:
    "SELECT id, studio_id, title, visibility, duration_ms, created_at, bytes FROM replays WHERE studio_id = ? ORDER BY created_at DESC",
  listReplaysForAccount: `SELECT id, studio_id, title, visibility, duration_ms, created_at, bytes FROM (SELECT r.id, r.studio_id, r.title, r.visibility, r.duration_ms, r.created_at, r.bytes, ROW_NUMBER() OVER (PARTITION BY r.studio_id ORDER BY r.created_at DESC) AS rn FROM replays r INNER JOIN studio_members m ON m.studio_id = r.studio_id WHERE m.account_id = ?) WHERE rn <= ${LIST_REPLAYS_PER_STUDIO} ORDER BY studio_id, created_at DESC`,
  updateReplayVisibility: "UPDATE replays SET visibility = ? WHERE id = ?",
  addReplayBytes: "UPDATE replays SET bytes = MAX(0, bytes + ?) WHERE id = ? RETURNING bytes",
} as const;

const migrated = new WeakSet<object>();
const lastSweep = new WeakMap<object, number>();
const SWEEP_EVERY_MS = 60 * 60 * 1000;

type AccountRow = {
  id: string;
  email: string | null;
  name: string;
  github_id: string | null;
  created_at: number;
};

type SessionRow = {
  id: string;
  account_id: string;
  token_hash: string;
  prev_token_hash: string | null;
  expires_at: number;
  created_at: number;
  rotated_at: number;
};

type MagicRow = {
  token_hash: string;
  email: string;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
};

type ReplayRow = {
  id: string;
  studio_id: string;
  title: string;
  visibility: ReplayVisibility;
  duration_ms: number | null;
  created_at: number;
  bytes: number;
};

function mapReplay(row: ReplayRow): ReplayRecord {
  return {
    id: row.id,
    studioId: row.studio_id,
    title: row.title,
    visibility: row.visibility,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    bytes: row.bytes,
  };
}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    githubId: row.github_id,
    createdAt: row.created_at,
  };
}

export async function ensureDb(db: D1Database): Promise<void> {
  if (!migrated.has(db)) {
    await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
    try {
      await db.prepare("ALTER TABLE studios ADD COLUMN owner_id TEXT").run();
    } catch {
      /* already present */
    }
    migrated.add(db);
  }
  const now = Date.now();
  const prevSweep = lastSweep.get(db) ?? 0;
  if (prevSweep && now - prevSweep < SWEEP_EVERY_MS) return;
  lastSweep.set(db, now);
  await db.batch([
    db.prepare(Q.deleteExpiredSessions).bind(now),
    db.prepare(Q.deleteExpiredMagic).bind(now),
    db.prepare(Q.deleteExpiredOauth).bind(now),
    db.prepare(Q.deleteStaleRates).bind(now - SIGNIN_WINDOW_MS),
  ]);
}

export async function first<T>(db: D1Database, sql: string, ...bind: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...bind).first<T>()) ?? null;
}

export async function all<T>(db: D1Database, sql: string, ...bind: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...bind).all<T>();
  return res.results ?? [];
}

export async function run(db: D1Database, sql: string, ...bind: unknown[]): Promise<void> {
  await db.prepare(sql).bind(...bind).run();
}

export async function insertAccount(
  db: D1Database,
  account: { id: string; email: string | null; name: string; githubId: string | null; createdAt: number },
): Promise<void> {
  await run(db, Q.insertAccount, account.id, account.email, account.name, account.githubId, account.createdAt);
}

export async function accountById(db: D1Database, id: string): Promise<Account | null> {
  const row = await first<AccountRow>(db, Q.accountById, id);
  return row ? mapAccount(row) : null;
}

export async function accountByEmail(db: D1Database, email: string): Promise<Account | null> {
  const row = await first<AccountRow>(db, Q.accountByEmail, email);
  return row ? mapAccount(row) : null;
}

export async function accountByGithub(db: D1Database, githubId: string): Promise<Account | null> {
  const row = await first<AccountRow>(db, Q.accountByGithub, githubId);
  return row ? mapAccount(row) : null;
}

export async function updateAccountGithub(db: D1Database, id: string, githubId: string, name: string): Promise<void> {
  await run(db, Q.updateAccountGithub, githubId, name, id);
}

export type DbSession = SessionRow;

export async function insertSession(db: D1Database, row: SessionRow): Promise<void> {
  await run(
    db,
    Q.insertSession,
    row.id,
    row.account_id,
    row.token_hash,
    row.prev_token_hash,
    row.expires_at,
    row.created_at,
    row.rotated_at,
  );
}

export async function sessionByTokenHash(db: D1Database, tokenHash: string): Promise<SessionRow | null> {
  return first<SessionRow>(db, Q.sessionByToken, tokenHash, tokenHash);
}

export async function deleteSession(db: D1Database, id: string): Promise<void> {
  await run(db, Q.deleteSession, id);
}

export async function rotateSession(
  db: D1Database,
  id: string,
  next: { tokenHash: string; prevHash: string; rotatedAt: number; expiresAt: number },
  expectedTokenHash: string,
): Promise<boolean> {
  const res = await db.prepare(Q.rotateSession).bind(next.tokenHash, next.prevHash, next.rotatedAt, next.expiresAt, id, expectedTokenHash).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function insertMagic(db: D1Database, tokenHash: string, email: string, expiresAt: number, createdAt: number): Promise<void> {
  await run(db, Q.insertMagic, tokenHash, email, expiresAt, createdAt);
}

export async function magicByHash(db: D1Database, tokenHash: string): Promise<MagicRow | null> {
  return first<MagicRow>(db, Q.magicByHash, tokenHash);
}

export async function consumeMagic(db: D1Database, tokenHash: string, at: number): Promise<boolean> {
  const res = await db.prepare(Q.consumeMagic).bind(at, tokenHash).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function insertOauth(db: D1Database, state: string, expiresAt: number): Promise<void> {
  await run(db, Q.insertOauth, state, expiresAt);
}

export async function oauthByState(db: D1Database, state: string): Promise<{ state: string; expires_at: number } | null> {
  return first(db, Q.oauthByState, state);
}

export async function deleteOauth(db: D1Database, state: string): Promise<void> {
  await run(db, Q.deleteOauth, state);
}

export async function insertStudioRow(db: D1Database, id: string, title: string, createdAt: number, ownerId: string): Promise<void> {
  await run(db, Q.insertStudio, id, title, createdAt, ownerId);
}

export async function studioById(db: D1Database, id: string): Promise<{ id: string; title: string; created_at: number; owner_id: string | null } | null> {
  return first(db, Q.studioById, id);
}

export async function listStudiosFor(db: D1Database, accountId: string): Promise<StudioRecord[]> {
  const rows = await all<{ id: string; title: string; owner_id: string; created_at: number; role: MemberRole }>(db, Q.listStudios, accountId);
  const replayRows = await all<ReplayRow>(db, Q.listReplaysForAccount, accountId);
  const byStudio = new Map<string, ReplayRecord[]>();
  for (const row of replayRows) {
    const list = byStudio.get(row.studio_id) ?? [];
    if (list.length >= LIST_REPLAYS_PER_STUDIO) continue;
    list.push(mapReplay(row));
    byStudio.set(row.studio_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    ownerId: r.owner_id,
    createdAt: r.created_at,
    role: r.role,
    replays: byStudio.get(r.id) ?? [],
  }));
}

export async function insertMember(db: D1Database, studioId: string, accountId: string, role: MemberRole, createdAt: number): Promise<void> {
  await run(db, Q.insertMember, studioId, accountId, role, createdAt);
}

export async function memberFor(db: D1Database, studioId: string, accountId: string): Promise<{ role: MemberRole } | null> {
  const row = await first<{ role: MemberRole }>(db, Q.memberByStudioAccount, studioId, accountId);
  return row ? { role: row.role } : null;
}

export async function membersOf(db: D1Database, studioId: string): Promise<StudioMember[]> {
  const rows = await all<{ account_id: string; role: MemberRole; email: string | null; name: string }>(db, Q.membersByStudio, studioId);
  return rows.map((r) => ({
    accountId: r.account_id,
    email: r.email,
    name: r.name,
    role: r.role,
  }));
}

export async function deleteCohost(db: D1Database, studioId: string, accountId: string): Promise<void> {
  await run(db, Q.deleteCohost, studioId, accountId);
}

export async function insertInvite(db: D1Database, id: string, studioId: string, email: string, createdAt: number): Promise<void> {
  await run(db, Q.insertInvite, id, studioId, email, createdAt);
}

export async function invitesForStudio(db: D1Database, studioId: string): Promise<{ id: string; email: string }[]> {
  return all(db, Q.invitesByStudio, studioId);
}

export async function invitesForEmail(db: D1Database, email: string): Promise<{ id: string; studio_id: string; email: string }[]> {
  return all(db, Q.invitesByEmail, email);
}

export async function deleteInvite(db: D1Database, studioId: string, email: string): Promise<void> {
  await run(db, Q.deleteInvite, studioId, email);
}

export async function applyInvites(db: D1Database, account: Account): Promise<void> {
  if (!account.email) return;
  const invites = await invitesForEmail(db, account.email);
  const now = Date.now();
  for (const invite of invites) {
    const existing = await memberFor(db, invite.studio_id, account.id);
    if (!existing) {
      await insertMember(db, invite.studio_id, account.id, "cohost", now);
    }
    await deleteInvite(db, invite.studio_id, account.email);
  }
}

export async function allowRate(db: D1Database, key: string, max: number, windowMs: number, now = Date.now()): Promise<boolean> {
  const row = await first<{ count: number }>(db, Q.bumpRate, key, now, now, windowMs, now, windowMs, now);
  return (row?.count ?? 0) <= max;
}

export async function insertReplay(db: D1Database, row: ReplayRecord): Promise<void> {
  await run(db, Q.insertReplay, row.id, row.studioId, row.title, row.visibility, row.durationMs, row.createdAt, row.bytes);
}

export async function replayById(db: D1Database, id: string): Promise<ReplayRecord | null> {
  const row = await first<ReplayRow>(db, Q.replayById, id);
  return row ? mapReplay(row) : null;
}

export async function listReplaysForStudio(db: D1Database, studioId: string): Promise<ReplayRecord[]> {
  const rows = await all<ReplayRow>(db, Q.listReplaysByStudio, studioId);
  return rows.map(mapReplay);
}

export async function updateReplayVisibility(db: D1Database, id: string, visibility: ReplayVisibility): Promise<void> {
  await run(db, Q.updateReplayVisibility, visibility, id);
}

export async function addReplayBytes(db: D1Database, id: string, delta: number): Promise<number> {
  const row = await first<{ bytes: number }>(db, Q.addReplayBytes, delta, id);
  return row?.bytes ?? 0;
}
