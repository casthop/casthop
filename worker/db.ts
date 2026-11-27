import type { Account, ClipRecord, MemberRole, ReplayRecord, ReplayVisibility, StudioMember, StudioRecord } from "./types";
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
    window_start INTEGER NOT NULL,
    last_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS replays (
    id TEXT PRIMARY KEY,
    studio_id TEXT NOT NULL,
    title TEXT NOT NULL,
    visibility TEXT NOT NULL,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    files INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS replays_studio ON replays(studio_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS clips (
    id TEXT PRIMARY KEY,
    studio_id TEXT NOT NULL,
    title TEXT NOT NULL,
    visibility TEXT NOT NULL,
    duration_ms INTEGER,
    seconds INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    files INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS clips_studio ON clips(studio_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS used_jtis (
    jti TEXT PRIMARY KEY,
    exp INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS service_nonces (
    nonce TEXT PRIMARY KEY,
    exp INTEGER NOT NULL
  )`,
] as const;

export const LIST_REPLAYS_PER_STUDIO = 20;
export const LIST_CLIPS_PER_STUDIO = 20;

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
  insertStudio: "INSERT INTO studios (id, title, created_at, owner_id, tenant_id) VALUES (?, ?, ?, ?, ?)",
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
  claimInboxRate:
    "INSERT INTO rate_limits (key, count, window_start, last_at) VALUES (?, 1, ?, ?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN excluded.last_at - window_start > ? THEN 1 ELSE count + 1 END, window_start = CASE WHEN excluded.last_at - window_start > ? THEN excluded.last_at ELSE window_start END, last_at = excluded.last_at WHERE excluded.last_at - window_start > ? OR count < ? OR excluded.last_at - last_at >= ? RETURNING count",
  refundRate: "UPDATE rate_limits SET count = count - 1, last_at = 0 WHERE key = ? AND ? - window_start <= ? AND count > 0",
  insertReplay:
    "INSERT INTO replays (id, studio_id, title, visibility, duration_ms, created_at, bytes, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  replayById: "SELECT id, studio_id, title, visibility, duration_ms, created_at, bytes, files FROM replays WHERE id = ?",
  listReplaysByStudio:
    "SELECT id, studio_id, title, visibility, duration_ms, created_at, bytes, files FROM replays WHERE studio_id = ? ORDER BY created_at DESC",
  listReplaysForAccount: `SELECT id, studio_id, title, visibility, duration_ms, created_at, bytes, files FROM (SELECT r.id, r.studio_id, r.title, r.visibility, r.duration_ms, r.created_at, r.bytes, r.files, ROW_NUMBER() OVER (PARTITION BY r.studio_id ORDER BY r.created_at DESC) AS rn FROM replays r INNER JOIN studio_members m ON m.studio_id = r.studio_id WHERE m.account_id = ?) WHERE rn <= ${LIST_REPLAYS_PER_STUDIO} ORDER BY studio_id, created_at DESC`,
  updateReplayVisibility: "UPDATE replays SET visibility = ? WHERE id = ?",
  countReplaysByStudio: "SELECT COUNT(*) AS n FROM replays WHERE studio_id = ?",
  addReplayUsage: "UPDATE replays SET bytes = MAX(0, bytes + ?), files = MAX(0, files + ?) WHERE id = ? RETURNING bytes, files",
  addReplayUsageIfUnderCap:
    "UPDATE replays SET bytes = MAX(0, bytes + ?), files = MAX(0, files + ?) WHERE id = ? AND bytes + ? <= ? AND files + ? <= ? RETURNING bytes, files",
  insertClip:
    "INSERT INTO clips (id, studio_id, title, visibility, duration_ms, seconds, created_at, bytes, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  clipById:
    "SELECT id, studio_id, title, visibility, duration_ms, seconds, created_at, bytes, files FROM clips WHERE id = ?",
  listClipsByStudio:
    "SELECT id, studio_id, title, visibility, duration_ms, seconds, created_at, bytes, files FROM clips WHERE studio_id = ? ORDER BY created_at DESC",
  listClipsForAccount: `SELECT id, studio_id, title, visibility, duration_ms, seconds, created_at, bytes, files FROM (SELECT c.id, c.studio_id, c.title, c.visibility, c.duration_ms, c.seconds, c.created_at, c.bytes, c.files, ROW_NUMBER() OVER (PARTITION BY c.studio_id ORDER BY c.created_at DESC) AS rn FROM clips c INNER JOIN studio_members m ON m.studio_id = c.studio_id WHERE m.account_id = ?) WHERE rn <= ${LIST_CLIPS_PER_STUDIO} ORDER BY studio_id, created_at DESC`,
  updateClipVisibility: "UPDATE clips SET visibility = ? WHERE id = ?",
  countClipsByStudio: "SELECT COUNT(*) AS n FROM clips WHERE studio_id = ?",
  studioTenant: "SELECT tenant_id FROM studios WHERE id = ?",
  studiosByTenant: "SELECT id, title, owner_id, created_at FROM studios WHERE tenant_id = ? ORDER BY created_at",
  deleteStudioMembers: "DELETE FROM studio_members WHERE studio_id = ?",
  deleteStudioInvites: "DELETE FROM studio_invites WHERE studio_id = ?",
  deleteStudioReplays: "DELETE FROM replays WHERE studio_id = ?",
  deleteStudioClips: "DELETE FROM clips WHERE studio_id = ?",
  deleteStudio: "DELETE FROM studios WHERE id = ?",
  insertJti: "INSERT INTO used_jtis (jti, exp) VALUES (?, ?)",
  deleteExpiredJtis: "DELETE FROM used_jtis WHERE exp < ?",
  insertNonce: "INSERT INTO service_nonces (nonce, exp) VALUES (?, ?)",
  deleteExpiredNonces: "DELETE FROM service_nonces WHERE exp < ?",
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
  files: number;
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
    files: row.files ?? 0,
  };
}

type ClipRow = ReplayRow & { seconds: number };

function mapClip(row: ClipRow): ClipRecord {
  return {
    ...mapReplay(row),
    seconds: row.seconds === 30 ? 30 : 60,
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
    try {
      await db.prepare("ALTER TABLE replays ADD COLUMN files INTEGER NOT NULL DEFAULT 0").run();
    } catch {
      /* already present */
    }
    try {
      await db.prepare("ALTER TABLE studios ADD COLUMN tenant_id TEXT").run();
    } catch {
      /* already present */
    }
    try {
      await db.prepare("ALTER TABLE rate_limits ADD COLUMN last_at INTEGER NOT NULL DEFAULT 0").run();
    } catch {
      /* already present */
    }
    await db.prepare("CREATE INDEX IF NOT EXISTS studios_tenant ON studios(tenant_id)").run();
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

export async function insertStudioRow(db: D1Database, id: string, title: string, createdAt: number, ownerId: string, tenantId?: string): Promise<void> {
  // Tenant goes in the same write so a studio never exists without it.
  await run(db, Q.insertStudio, id, title, createdAt, ownerId, tenantId ?? null);
}

export async function studioById(db: D1Database, id: string): Promise<{ id: string; title: string; created_at: number; owner_id: string | null } | null> {
  return first(db, Q.studioById, id);
}

export async function listStudiosFor(db: D1Database, accountId: string): Promise<StudioRecord[]> {
  const rows = await all<{ id: string; title: string; owner_id: string; created_at: number; role: MemberRole }>(db, Q.listStudios, accountId);
  const replayRows = await all<ReplayRow>(db, Q.listReplaysForAccount, accountId);
  const clipRows = await all<ClipRow>(db, Q.listClipsForAccount, accountId);
  const byStudio = new Map<string, ReplayRecord[]>();
  for (const row of replayRows) {
    const list = byStudio.get(row.studio_id) ?? [];
    if (list.length >= LIST_REPLAYS_PER_STUDIO) continue;
    list.push(mapReplay(row));
    byStudio.set(row.studio_id, list);
  }
  const clipsByStudio = new Map<string, ClipRecord[]>();
  for (const row of clipRows) {
    const list = clipsByStudio.get(row.studio_id) ?? [];
    if (list.length >= LIST_CLIPS_PER_STUDIO) continue;
    list.push(mapClip(row));
    clipsByStudio.set(row.studio_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    ownerId: r.owner_id,
    createdAt: r.created_at,
    role: r.role,
    replays: byStudio.get(r.id) ?? [],
    clips: clipsByStudio.get(r.id) ?? [],
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

export async function allowRate(db: D1Database, key: string, max: number, windowMs: number, now = Date.now()): Promise<boolean> {
  const row = await first<{ count: number }>(db, Q.bumpRate, key, now, now, windowMs, now, windowMs, now);
  return (row?.count ?? 0) <= max;
}

/** Take one inbox send: burst up to max per window, then one more if the last send was at least gapMs ago. */
export async function allowInboxRate(
  db: D1Database,
  key: string,
  max: number,
  windowMs: number,
  gapMs: number,
  now = Date.now(),
): Promise<boolean> {
  const row = await first<{ count: number }>(db, Q.claimInboxRate, key, now, now, windowMs, windowMs, windowMs, max, gapMs);
  return row !== null;
}

/** Give back a slot taken by allowRate or allowInboxRate when the counted work did not happen. */
export async function refundRate(db: D1Database, key: string, windowMs: number, now = Date.now()): Promise<void> {
  await run(db, Q.refundRate, key, now, windowMs);
}

export async function insertReplay(db: D1Database, row: ReplayRecord): Promise<void> {
  await run(
    db,
    Q.insertReplay,
    row.id,
    row.studioId,
    row.title,
    row.visibility,
    row.durationMs,
    row.createdAt,
    row.bytes,
    row.files,
  );
}

export async function replayById(db: D1Database, id: string): Promise<ReplayRecord | null> {
  const row = await first<ReplayRow>(db, Q.replayById, id);
  return row ? mapReplay(row) : null;
}

export async function listReplaysForStudio(db: D1Database, studioId: string): Promise<ReplayRecord[]> {
  const rows = await all<ReplayRow>(db, Q.listReplaysByStudio, studioId);
  return rows.map(mapReplay);
}

export async function countReplaysForStudio(db: D1Database, studioId: string): Promise<number> {
  const row = await first<{ n: number }>(db, Q.countReplaysByStudio, studioId);
  return Number(row?.n ?? 0);
}

export async function updateReplayVisibility(db: D1Database, id: string, visibility: ReplayVisibility): Promise<void> {
  await run(db, Q.updateReplayVisibility, visibility, id);
}

export async function addReplayUsage(
  db: D1Database,
  id: string,
  bytesDelta: number,
  filesDelta: number,
): Promise<{ bytes: number; files: number }> {
  const row = await first<{ bytes: number; files: number }>(db, Q.addReplayUsage, bytesDelta, filesDelta, id);
  return { bytes: row?.bytes ?? 0, files: row?.files ?? 0 };
}

export async function addReplayBytes(db: D1Database, id: string, delta: number): Promise<number> {
  return (await addReplayUsage(db, id, delta, 0)).bytes;
}

export async function addReplayUsageIfUnderCap(
  db: D1Database,
  id: string,
  bytesDelta: number,
  filesDelta: number,
  maxBytes: number,
  maxFiles: number,
): Promise<{ bytes: number; files: number } | null> {
  return first<{ bytes: number; files: number }>(
    db,
    Q.addReplayUsageIfUnderCap,
    bytesDelta,
    filesDelta,
    id,
    bytesDelta,
    maxBytes,
    filesDelta,
    maxFiles,
  );
}

export async function insertClip(db: D1Database, row: ClipRecord): Promise<void> {
  await run(
    db,
    Q.insertClip,
    row.id,
    row.studioId,
    row.title,
    row.visibility,
    row.durationMs,
    row.seconds,
    row.createdAt,
    row.bytes,
    row.files,
  );
}

export async function clipById(db: D1Database, id: string): Promise<ClipRecord | null> {
  const row = await first<ClipRow>(db, Q.clipById, id);
  return row ? mapClip(row) : null;
}

export async function listClipsForStudio(db: D1Database, studioId: string): Promise<ClipRecord[]> {
  const rows = await all<ClipRow>(db, Q.listClipsByStudio, studioId);
  return rows.map(mapClip);
}

export async function countClipsForStudio(db: D1Database, studioId: string): Promise<number> {
  const row = await first<{ n: number }>(db, Q.countClipsByStudio, studioId);
  return Number(row?.n ?? 0);
}

export async function updateClipVisibility(db: D1Database, id: string, visibility: ReplayVisibility): Promise<void> {
  await run(db, Q.updateClipVisibility, visibility, id);
}

export async function studioTenantId(db: D1Database, studioId: string): Promise<string | null> {
  const row = await first<{ tenant_id: string | null }>(db, Q.studioTenant, studioId);
  return row?.tenant_id ?? null;
}

export type TenantStudioRow = { id: string; title: string; owner_id: string | null; created_at: number };

export async function studiosOfTenant(db: D1Database, tenantId: string): Promise<TenantStudioRow[]> {
  return all<TenantStudioRow>(db, Q.studiosByTenant, tenantId);
}

export async function deleteStudioRows(db: D1Database, studioId: string): Promise<void> {
  await db.batch([
    db.prepare(Q.deleteStudioMembers).bind(studioId),
    db.prepare(Q.deleteStudioInvites).bind(studioId),
    db.prepare(Q.deleteStudioReplays).bind(studioId),
    db.prepare(Q.deleteStudioClips).bind(studioId),
    db.prepare(Q.deleteStudio).bind(studioId),
  ]);
}

/** True the first time a one-time value is seen, false on reuse. Expired rows are pruned on the way. */
async function claimOnce(db: D1Database, prune: string, insert: string, value: string, expMs: number): Promise<boolean> {
  await run(db, prune, Date.now());
  try {
    await run(db, insert, value, expMs);
    return true;
  } catch {
    return false;
  }
}

export function claimJti(db: D1Database, jti: string, expSeconds: number): Promise<boolean> {
  return claimOnce(db, Q.deleteExpiredJtis, Q.insertJti, jti, expSeconds * 1000);
}

export function claimNonce(db: D1Database, nonce: string, expMs: number): Promise<boolean> {
  return claimOnce(db, Q.deleteExpiredNonces, Q.insertNonce, nonce, expMs);
}
