import { asIdentity, asName } from "./security";
import type { ChatMessage, Env } from "./types";

export type PlatformId = "twitch" | "kick";
export type PlatformEnv = Pick<Env, "TWITCH_CHANNEL" | "KICK_CHATROOM_ID">;
export type PlatformMessage = ChatMessage & { source: PlatformId };

export const PLATFORM_BACKOFF_MIN_MS = 2_000;
export const PLATFORM_BACKOFF_MAX_MS = 60_000;

// Kick's public web-client Pusher app key. It is not a secret.
const KICK_PUSHER_URL = "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false";
const TWITCH_URL = "wss://irc-ws.chat.twitch.tv:443";
const MAX_TEXT = 400;

export type Parsed = { messages: PlatformMessage[]; reply: string[] };

/** One adapter per platform: how to connect, what to say first, how to read frames. */
export type PlatformAdapter = {
  id: PlatformId;
  configured: (env: PlatformEnv) => boolean;
  url: string;
  hello: (env: PlatformEnv) => string[];
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

export function parseKick(frame: string): Parsed {
  const out: Parsed = { messages: [], reply: [] };
  const env = asObj(parseJson(frame));
  if (!env) return out;
  if (env.event === "pusher:ping") {
    out.reply.push(JSON.stringify({ event: "pusher:pong", data: {} }));
    return out;
  }
  if (env.event !== "App\\Events\\ChatMessageEvent") return out;
  const data = asObj(parseJson(env.data));
  if (!data) return out;
  const sender = asObj(data.sender);
  const created = typeof data.created_at === "string" ? Date.parse(data.created_at) : NaN;
  const msg = message(
    "kick",
    typeof data.id === "string" ? data.id : "",
    sender && typeof sender.id === "number" ? String(sender.id) : "",
    sender && typeof sender.username === "string" ? sender.username : "",
    typeof data.content === "string" ? data.content : "",
    Number.isFinite(created) ? created : 0,
  );
  if (msg) out.messages.push(msg);
  return out;
}

export const twitchAdapter: PlatformAdapter = {
  id: "twitch",
  configured: (env) => Boolean(twitchChannel(env)),
  url: TWITCH_URL,
  // Anonymous read-only login. No token needed.
  hello: (env) => [
    "CAP REQ :twitch.tv/tags",
    "PASS SCHMOOPIIE",
    `NICK justinfan${Math.floor(10_000 + Math.random() * 80_000)}`,
    `JOIN #${twitchChannel(env)}`,
  ],
  parse: parseTwitch,
};

export const kickAdapter: PlatformAdapter = {
  id: "kick",
  configured: (env) => Boolean(kickChatroomId(env)),
  url: KICK_PUSHER_URL,
  hello: (env) => [
    JSON.stringify({ event: "pusher:subscribe", data: { auth: "", channel: `chatrooms.${kickChatroomId(env)}.v2` } }),
  ],
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

export type OpenSocket = (url: string) => Promise<ChatSocket>;

export const openWorkerSocket: OpenSocket = async (url) => {
  const res = await fetch(url.replace(/^wss:/, "https:"), { headers: { Upgrade: "websocket" } });
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
    try {
      const sock = await this.open(adapter.url);
      link.socket = sock;
      sock.onmessage = (frame) => this.receive(adapter, link, sock, frame);
      sock.onclose = () => {
        if (link.socket === sock) this.fail(link, Date.now());
      };
      for (const line of adapter.hello(this.env)) sock.send(line);
    } catch (err) {
      console.warn(`${adapter.id} chat connect`, err);
      this.fail(link, now);
    }
  }

  private receive(adapter: PlatformAdapter, link: Link, sock: ChatSocket, frame: string): void {
    link.failures = 0; // the server is talking, so the next drop starts at the short delay
    try {
      const parsed = adapter.parse(frame);
      for (const line of parsed.reply) sock.send(line);
      if (parsed.messages.length) this.onMessages(parsed.messages);
    } catch (err) {
      console.warn(`${adapter.id} chat frame`, err);
    }
  }
}
