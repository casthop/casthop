import { asIdentity, asName } from "./security";
import type { ChatMessage, Env } from "./types";

export type PlatformId = "twitch" | "kick";
export type PlatformEnv = Pick<Env, "TWITCH_CHANNEL" | "KICK_CHATROOM_ID">;
export type PlatformMessage = ChatMessage & { source: PlatformId };

export const PLATFORM_BACKOFF_MIN_MS = 2_000;
export const PLATFORM_BACKOFF_MAX_MS = 60_000;

const KICK_API = "https://web.kick.com/api/v1/realtime";
// Kick's realtime endpoints reject requests and upgrades without this Origin.
const KICK_ORIGIN = "https://kick.com";
const TWITCH_URL = "wss://irc-ws.chat.twitch.tv:443";
const MAX_TEXT = 400;

export type Parsed = { messages: PlatformMessage[]; reply: string[] };

/** Where to connect, which headers the upgrade needs, and what to send first. */
export type PlatformSession = { url: string; headers?: Record<string, string>; hello: string[] };

/** One adapter per platform: how to connect, what to say first, how to read frames. */
export type PlatformAdapter = {
  id: PlatformId;
  configured: (env: PlatformEnv) => boolean;
  prepare: (env: PlatformEnv) => Promise<PlatformSession>;
  parse: (frame: string) => Parsed;
};

function clean(text: string): string {
  return text.trim().slice(0, MAX_TEXT);
}

function message(source: PlatformId, rawId: string, userId: string, name: string, text: string, at: number): PlatformMessage | null {
  const body = clean(text);
  const id = `${source}:${rawId}`.slice(0, 80);
  if (!body || !rawId) return null;
  const from = asIdentity(`${source}:${userId || rawId}`) || id;
  return { id, from, name: asName(name, "Viewer"), text: body, at, source };
}

export function twitchChannel(env: PlatformEnv): string {
  const name = env.TWITCH_CHANNEL?.trim().replace(/^#/, "").toLowerCase() ?? "";
  return /^[a-z0-9_]{1,25}$/.test(name) ? name : "";
}

export function kickChatroomId(env: PlatformEnv): string {
  const id = env.KICK_CHATROOM_ID?.trim() ?? "";
  return /^\d{1,12}$/.test(id) ? id : "";
}

function ircTags(raw: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const pair of raw.split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0) tags.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return tags;
}

/** A websocket frame can hold several IRC lines. */
export function parseTwitch(frame: string): Parsed {
  const out: Parsed = { messages: [], reply: [] };
  for (const line of frame.split("\r\n")) {
    if (line.startsWith("PING")) {
      out.reply.push(`PONG${line.slice(4)}`);
      continue;
    }
    const tagged = line.startsWith("@");
    const space = tagged ? line.indexOf(" ") : 0;
    const tags = tagged && space > 0 ? ircTags(line.slice(1, space)) : new Map<string, string>();
    const rest = tagged ? line.slice(space + 1) : line;
    const m = /^:([^!\s]+)![^\s]* PRIVMSG #\S+ :(.*)$/.exec(rest);
    if (!m) continue;
    const sent = Number(tags.get("tmi-sent-ts"));
    const msg = message(
      "twitch",
      tags.get("id") ?? "",
      tags.get("user-id") ?? m[1],
      tags.get("display-name") || m[1],
      m[2],
      Number.isFinite(sent) && sent > 0 ? sent : 0,
    );
    if (msg) out.messages.push(msg);
  }
  return out;
}

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseJson(text: unknown): unknown {
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function kickChat(value: unknown): PlatformMessage | null {
  const data = asObj(parseJson(value));
  if (!data) return null;
  const sender = asObj(data.sender);
  const created = typeof data.created_at === "string" ? Date.parse(data.created_at) : NaN;
  return message(
    "kick",
    typeof data.id === "string" ? data.id : "",
    sender && typeof sender.id === "number" ? String(sender.id) : "",
    sender && typeof sender.username === "string" ? sender.username : "",
    typeof data.content === "string" ? data.content : "",
    Number.isFinite(created) ? created : 0,
  );
}

/** Centrifugo frames: `{}` is a server ping, pushes carry the chat event. A frame can hold several JSON lines. */
export function parseKick(frame: string): Parsed {
  const out: Parsed = { messages: [], reply: [] };
  for (const line of frame.split("\n")) {
    const obj = asObj(parseJson(line.trim()));
    if (!obj) continue;
    if (Object.keys(obj).length === 0) {
      out.reply.push("{}");
      continue;
    }
    const event = asObj(asObj(asObj(obj.push)?.pub)?.data);
    if (!event || event.event !== "App\\Events\\ChatMessageEvent") continue;
    const msg = kickChat(event.data);
    if (msg) out.messages.push(msg);
  }
  return out;
}

async function kickPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${KICK_API}${path}`, {
    method: "POST",
    headers: { Origin: KICK_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`kick ${path} ${res.status}`);
  const data = asObj(asObj(await res.json())?.data);
  if (!data) throw new Error(`kick ${path} bad response`);
  return data;
}

/**
 * Resolve the Centrifugo URL and a guest token. The token lasts ~45 min and is not
 * refreshed: the server then closes the socket and the hub reconnects with a new one.
 */
async function kickPrepare(env: PlatformEnv): Promise<PlatformSession> {
  const room = kickChatroomId(env);
  const clientId = crypto.randomUUID();
  const conn = await kickPost(`/channels/${room}/chat/connection`, {
    client: { id: clientId, type: "web" },
    capabilities: { accepted_providers: [{ provider: "pusher" }, { provider: "centrifugo" }] },
  });
  const centrifugo = Array.isArray(conn.connections)
    ? conn.connections.map(asObj).find((c) => c?.provider === "centrifugo")
    : undefined;
  const url = asObj(centrifugo?.credentials)?.url;
  if (typeof url !== "string" || !url.startsWith("wss://")) throw new Error("kick: no centrifugo url");
  const auth = await kickPost("/auth/connection", { client_id: clientId });
  if (typeof auth.token !== "string" || !auth.token) throw new Error("kick: no token");
  return {
    url,
    headers: { Origin: KICK_ORIGIN },
    hello: [
      JSON.stringify({ id: 1, connect: { token: auth.token, name: "js" } }),
      JSON.stringify({ id: 2, subscribe: { channel: `chatrooms.${room}.v2` } }),
    ],
  };
}

export const twitchAdapter: PlatformAdapter = {
  id: "twitch",
  configured: (env) => Boolean(twitchChannel(env)),
  // Anonymous read-only login. No token needed.
  prepare: async (env) => ({
    url: TWITCH_URL,
    hello: [
      "CAP REQ :twitch.tv/tags",
      "PASS SCHMOOPIIE",
      `NICK justinfan${Math.floor(10_000 + Math.random() * 80_000)}`,
      `JOIN #${twitchChannel(env)}`,
    ],
  }),
  parse: parseTwitch,
};

export const kickAdapter: PlatformAdapter = {
  id: "kick",
  configured: (env) => Boolean(kickChatroomId(env)),
  prepare: kickPrepare,
  parse: parseKick,
};

export const platformAdapters: PlatformAdapter[] = [twitchAdapter, kickAdapter];

export function platformsConfigured(env: PlatformEnv): { twitch: boolean; kick: boolean } {
  return { twitch: twitchAdapter.configured(env), kick: kickAdapter.configured(env) };
}

/** Minimal socket surface so tests can fake it. */
export type ChatSocket = {
  send: (data: string) => void;
  close: () => void;
  onmessage: ((frame: string) => void) | null;
  onclose: (() => void) | null;
};

export type OpenSocket = (url: string, headers?: Record<string, string>) => Promise<ChatSocket>;

export const openWorkerSocket: OpenSocket = async (url, headers) => {
  const res = await fetch(url.replace(/^wss:/, "https:"), { headers: { ...headers, Upgrade: "websocket" } });
  const ws = res.webSocket;
  if (!ws) throw new Error("no websocket");
  ws.accept();
  const sock: ChatSocket = {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onmessage: null,
    onclose: null,
  };
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") sock.onmessage?.(e.data);
  });
  ws.addEventListener("close", () => sock.onclose?.());
  ws.addEventListener("error", () => sock.onclose?.());
  return sock;
};

type Link = { socket: ChatSocket | null; failures: number; retryAt: number };

export function backoffMs(failures: number): number {
  return Math.min(PLATFORM_BACKOFF_MAX_MS, PLATFORM_BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1));
}

/**
 * Holds one socket per configured platform. Each link fails and retries on its own,
 * so a dead Twitch connection never touches Kick.
 */
export class PlatformHub {
  private links = new Map<PlatformId, Link>();

  constructor(
    private readonly env: PlatformEnv,
    private readonly onMessages: (msgs: PlatformMessage[]) => void,
    private readonly open: OpenSocket = openWorkerSocket,
    private readonly adapters: PlatformAdapter[] = platformAdapters,
  ) {}

  /** Connect what is due. Returns the next time a retry is needed, or null. */
  async tick(now: number): Promise<number | null> {
    let next: number | null = null;
    await Promise.all(
      this.adapters
        .filter((a) => a.configured(this.env))
        .map(async (adapter) => {
          const link = this.link(adapter.id);
          if (!link.socket && link.retryAt <= now) await this.connect(adapter, link, now);
          if (!link.socket && (next === null || link.retryAt < next)) next = link.retryAt;
        }),
    );
    return next;
  }

  close(): void {
    for (const link of this.links.values()) {
      const sock = link.socket;
      link.socket = null;
      link.failures = 0;
      link.retryAt = 0;
      try {
        sock?.close();
      } catch {
        /* already closed */
      }
    }
  }

  connected(id: PlatformId): boolean {
    return Boolean(this.links.get(id)?.socket);
  }

  private link(id: PlatformId): Link {
    let link = this.links.get(id);
    if (!link) {
      link = { socket: null, failures: 0, retryAt: 0 };
      this.links.set(id, link);
    }
    return link;
  }

  private fail(link: Link, now: number): void {
    link.socket = null;
    link.failures += 1;
    link.retryAt = now + backoffMs(link.failures);
  }

  private async connect(adapter: PlatformAdapter, link: Link, now: number): Promise<void> {
    let sock: ChatSocket | undefined;
    try {
      const session = await adapter.prepare(this.env);
      sock = await this.open(session.url, session.headers);
      const opened = sock;
      link.socket = opened;
      opened.onmessage = (frame) => this.receive(adapter, link, opened, frame);
      opened.onclose = () => {
        if (link.socket === opened) this.fail(link, Date.now());
      };
      for (const line of session.hello) opened.send(line);
    } catch (err) {
      console.warn(`${adapter.id} chat connect`, err);
      // Unlink first so a synchronous onclose does not count a second failure.
      link.socket = null;
      try {
        sock?.close();
      } catch {
        /* already closed */
      }
      this.fail(link, now);
    }
  }

  private receive(adapter: PlatformAdapter, link: Link, sock: ChatSocket, frame: string): void {
    try {
      const parsed = adapter.parse(frame);
      for (const line of parsed.reply) sock.send(line);
      if (parsed.messages.length) {
        // Only real chat proves the link works. A greeting followed by a drop (bad login,
        // rate limit) must keep growing the backoff.
        link.failures = 0;
        this.onMessages(parsed.messages);
      }
    } catch (err) {
      console.warn(`${adapter.id} chat frame`, err);
    }
  }
}
