import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backoffMs,
  parseKick,
  parseTwitch,
  PlatformHub,
  platformsConfigured,
  twitchAdapter,
  type ChatSocket,
  type PlatformMessage,
} from "../worker/chat-platforms.ts";

const KICK_URL = "wss://realtime.us-west-2.platform.kick.com/connection/websocket";
const TWITCH_URL = "wss://irc-ws.chat.twitch.tv:443";

const kickFrame = (data: Record<string, unknown>) => {
  const event = "App\\Events\\ChatMessageEvent";
  return JSON.stringify({
    push: { channel: "chatrooms.1.v2", pub: { data: { event, data: JSON.stringify(data) }, tags: { event } } },
  });
};

type Call = { url: string; body: unknown; origin: string | null; signal: AbortSignal | null };

/** Mock Kick's two discovery POSTs. Restores fetch when done. */
async function withKickApi(run: (calls: Call[]) => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body)), origin: new Headers(init?.headers).get("Origin"), signal: init?.signal ?? null });
    const data = url.endsWith("/auth/connection")
      ? { token: "test-token" }
      : { connections: [{ credentials: { url: KICK_URL }, provider: "centrifugo" }], mode: "websocket" };
    return Response.json({ data, message: "success" });
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = real;
  }
}

test("twitch: normalizes PRIVMSG with tags and answers PING", () => {
  const line =
    "@display-name=Ana;id=abc-1;tmi-sent-ts=1700000000000;user-id=42 :ana!ana@ana.tmi.twitch.tv PRIVMSG #chan :hello world\r\n" +
    "PING :tmi.twitch.tv\r\n";
  const out = parseTwitch(line);
  assert.equal(out.messages.length, 1);
  assert.deepEqual(out.messages[0], {
    id: "twitch:abc-1",
    from: "twitch:42",
    name: "Ana",
    text: "hello world",
    at: 1700000000000,
    source: "twitch",
  });
  assert.deepEqual(out.reply, ["PONG :tmi.twitch.tv"]);
});

test("twitch: ignores joins, empty text and lines without an id", () => {
  const out = parseTwitch(
    ":tmi.twitch.tv 001 justinfan1 :Welcome\r\n" +
      "@id=x :a!a@a PRIVMSG #c : \r\n" +
      ":a!a@a PRIVMSG #c :no id\r\n",
  );
  assert.equal(out.messages.length, 0);
});

test("twitch: caps long text", () => {
  const out = parseTwitch(`@id=1 :a!a@a PRIVMSG #c :${"x".repeat(900)}`);
  assert.equal(out.messages[0]?.text.length, 400);
});

test("kick: normalizes a chat event", () => {
  const out = parseKick(
    kickFrame({ id: "m-1", content: "gg", created_at: "2026-01-02T00:00:00.000Z", sender: { id: 7, username: "kai" } }),
  );
  assert.deepEqual(out.messages[0], {
    id: "kick:m-1",
    from: "kick:7",
    name: "kai",
    text: "gg",
    at: Date.parse("2026-01-02T00:00:00.000Z"),
    source: "kick",
  });
});

test("kick: pong, acks, other events and junk are safe", () => {
  assert.deepEqual(parseKick("{}"), { messages: [], reply: ["{}"] });
  const connect = parseKick('{"id":1,"connect":{"client":"c","version":"6.9.7 PRO","expires":true,"ttl":2700,"ping":25,"pong":true}}');
  assert.deepEqual(connect, { messages: [], reply: [] });
  assert.deepEqual(parseKick('{"id":2,"subscribe":{}}'), { messages: [], reply: [] });
  const other = JSON.stringify({ push: { channel: "c", pub: { data: { event: "App\\Events\\Other", data: "{}" } } } });
  assert.equal(parseKick(other).messages.length, 0);
  assert.equal(parseKick("not json").messages.length, 0);
  assert.equal(parseKick(kickFrame({ id: "m", content: "  ", sender: {} })).messages.length, 0);
});

test("kick: a frame with several lines yields every message and pong", () => {
  const out = parseKick(
    [kickFrame({ id: "a", content: "one", sender: { id: 1, username: "x" } }), "{}", kickFrame({ id: "b", content: "two", sender: { id: 2, username: "y" } })].join("\n"),
  );
  assert.deepEqual(out.messages.map((m) => m.text), ["one", "two"]);
  assert.deepEqual(out.reply, ["{}"]);
});

test("kick: connect resolves the url and token, sets Origin, then connects and subscribes", async () => {
  await withKickApi(async (calls) => {
    const opened: { url: string; headers?: Record<string, string> }[] = [];
    const sock = fakeSocket();
    const hub = new PlatformHub({ KICK_CHATROOM_ID: "55" }, () => undefined, async (url, headers) => {
      opened.push({ url, headers });
      return sock;
    });
    await hub.tick(0);
    assert.equal(hub.connected("kick"), true);
    assert.equal(calls.length, 2);
    assert.ok(calls[0]?.url.endsWith("/channels/55/chat/connection"));
    assert.ok(calls[1]?.url.endsWith("/auth/connection"));
    assert.ok(calls.every((c) => c.origin === "https://kick.com"));
    assert.ok(calls.every((c) => c.signal !== null), "discovery calls carry a timeout signal");
    const clientId = (calls[1]?.body as { client_id: string }).client_id;
    assert.equal((calls[0]?.body as { client: { id: string } }).client.id, clientId);
    assert.deepEqual(opened, [{ url: KICK_URL, headers: { Origin: "https://kick.com" } }]);
    assert.deepEqual(sock.sent.map((s) => JSON.parse(s)), [
      { id: 1, connect: { token: "test-token", name: "js" } },
      { id: 2, subscribe: { channel: "chatrooms.55.v2" } },
    ]);
    sock.onmessage?.("{}");
    assert.equal(sock.sent.at(-1), "{}");
  });
});

test("kick: a failed discovery backs off without opening a socket", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
  try {
    let opens = 0;
    const hub = new PlatformHub({ KICK_CHATROOM_ID: "55" }, () => undefined, async () => {
      opens += 1;
      return fakeSocket();
    });
    assert.equal(await hub.tick(0), 2_000);
    assert.equal(opens, 0);
    assert.equal(hub.connected("kick"), false);
  } finally {
    globalThis.fetch = real;
  }
});

test("twitch: upgrade carries no Origin", async () => {
  let seen: Record<string, string> | undefined = { Origin: "x" };
  const hub = new PlatformHub({ TWITCH_CHANNEL: "c" }, () => undefined, async (_url, headers) => {
    seen = headers;
    return fakeSocket();
  });
  await hub.tick(0);
  assert.equal(seen, undefined);
});

test("unconfigured or invalid platforms stay hidden", () => {
  assert.deepEqual(platformsConfigured({}), { twitch: false, kick: false });
  assert.deepEqual(platformsConfigured({ TWITCH_CHANNEL: "bad name!", KICK_CHATROOM_ID: "abc" }), {
    twitch: false,
    kick: false,
  });
  assert.deepEqual(platformsConfigured({ TWITCH_CHANNEL: "#Casthop", KICK_CHATROOM_ID: "123" }), {
    twitch: true,
    kick: true,
  });
});

test("backoff doubles and caps", () => {
  assert.deepEqual([1, 2, 3, 20].map(backoffMs), [2000, 4000, 8000, 60000]);
});

function fakeSocket(): ChatSocket & { sent: string[]; closed: boolean } {
  return { sent: [], closed: false, send(d) { this.sent.push(d); }, close() { this.closed = true; }, onmessage: null, onclose: null };
}

test("one platform failing does not stop the other, and it retries with backoff", () => withKickApi(async () => {
  const env = { TWITCH_CHANNEL: "chan", KICK_CHATROOM_ID: "9" };
  const got: PlatformMessage[] = [];
  const sockets = new Map<string, ReturnType<typeof fakeSocket>>();
  let twitchUp = false;
  const open = async (url: string) => {
    if (url === TWITCH_URL && !twitchUp) throw new Error("twitch down");
    const s = fakeSocket();
    sockets.set(url, s);
    return s;
  };
  const hub = new PlatformHub(env, (m) => got.push(...m), open);

  const next = await hub.tick(1_000);
  assert.equal(next, 1_000 + 2_000);
  assert.equal(hub.connected("twitch"), false);
  assert.equal(hub.connected("kick"), true);
  assert.equal(sockets.get(KICK_URL)?.sent.length, 2);

  sockets.get(KICK_URL)?.onmessage?.(kickFrame({ id: "k1", content: "still here", sender: { id: 1, username: "k" } }));
  assert.equal(got[0]?.source, "kick");

  // Too early: no new attempt. Later: connects.
  assert.equal(await hub.tick(2_000), 3_000);
  twitchUp = true;
  assert.equal(await hub.tick(3_000), null);
  assert.equal(hub.connected("twitch"), true);
  sockets.get(TWITCH_URL)?.onmessage?.("@id=t1 :a!a@a PRIVMSG #chan :hi");
  assert.deepEqual(got.map((m) => m.source), ["kick", "twitch"]);
}));

test("a dropped socket reconnects while the other keeps running", () => withKickApi(async () => {
  const env = { TWITCH_CHANNEL: "chan", KICK_CHATROOM_ID: "9" };
  const sockets: Record<string, ReturnType<typeof fakeSocket>> = {};
  const hub = new PlatformHub(env, () => undefined, async (url) => (sockets[url] = fakeSocket()));
  await hub.tick(0);
  const kickBefore = sockets[KICK_URL];
  sockets[TWITCH_URL]?.onclose?.();
  assert.equal(hub.connected("twitch"), false);
  assert.equal(hub.connected("kick"), true);
  await hub.tick(Date.now() + 5_000);
  assert.equal(hub.connected("twitch"), true);
  assert.equal(sockets[KICK_URL], kickBefore);
}));

test("a parser that throws is contained", async () => {
  const bad = { ...twitchAdapter, parse: () => { throw new Error("boom"); } };
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const hub = new PlatformHub({ TWITCH_CHANNEL: "c" }, () => undefined, async () => { const s = fakeSocket(); sockets.push(s); return s; }, [bad]);
  await hub.tick(0);
  assert.doesNotThrow(() => sockets[0]?.onmessage?.("x"));
  assert.equal(hub.connected("twitch"), true);
});

test("a hello that throws closes the socket and backs off", async () => {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const bad = { ...twitchAdapter, prepare: async () => ({ url: TWITCH_URL, hello: ["hi"] }) };
  const open = async () => {
    const s = fakeSocket();
    s.send = () => { throw new Error("boom"); };
    sockets.push(s);
    return s;
  };
  const hub = new PlatformHub({ TWITCH_CHANNEL: "c" }, () => undefined, open, [bad]);
  assert.equal(await hub.tick(0), 2_000);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0]?.closed, true);
  assert.equal(hub.connected("twitch"), false);
  // Retry opens exactly one new socket.
  await hub.tick(2_000);
  assert.equal(sockets.length, 2);
});

test("greeting then drop keeps growing the backoff until real chat arrives", async () => {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const hub = new PlatformHub({ TWITCH_CHANNEL: "c" }, () => undefined, async () => { const s = fakeSocket(); sockets.push(s); return s; });
  const far = Date.now() + 10 * 60_000;
  const dropAfter = async (frame: string, attempt: number): Promise<number> => {
    await hub.tick(far * attempt);
    sockets.at(-1)?.onmessage?.(frame);
    sockets.at(-1)?.onclose?.();
    const retryAt = await hub.tick(0);
    return (retryAt ?? 0) - Date.now();
  };
  const greeting = ":tmi.twitch.tv 001 justinfan1 :Welcome\r\n";
  const delays = [await dropAfter(greeting, 1), await dropAfter(greeting, 2), await dropAfter(greeting, 3)];
  [2_000, 4_000, 8_000].forEach((want, i) => {
    assert.ok((delays[i] ?? 0) > want - 500 && (delays[i] ?? 0) <= want, `drop ${i + 1}: ${delays[i]}`);
  });
  // A real chat message resets it.
  const reset = await dropAfter("@id=t1 :a!a@a PRIVMSG #c :hi", 4);
  assert.ok(reset > 1_500 && reset <= 2_000, `after chat: ${reset}`);
});

test("close drops every socket", () => withKickApi(async () => {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const hub = new PlatformHub({ TWITCH_CHANNEL: "c", KICK_CHATROOM_ID: "1" }, () => undefined, async () => { const s = fakeSocket(); sockets.push(s); return s; });
  await hub.tick(0);
  hub.close();
  assert.ok(sockets.every((s) => s.closed));
  assert.equal(hub.connected("kick"), false);
}));
