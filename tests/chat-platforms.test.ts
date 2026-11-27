import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backoffMs,
  kickAdapter,
  parseKick,
  parseTwitch,
  PlatformHub,
  platformsConfigured,
  twitchAdapter,
  type ChatSocket,
  type PlatformMessage,
} from "../worker/chat-platforms.ts";

const kickFrame = (data: Record<string, unknown>) =>
  JSON.stringify({ event: "App\\Events\\ChatMessageEvent", channel: "chatrooms.1.v2", data: JSON.stringify(data) });

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

test("kick: pong, other events and junk are safe", () => {
  assert.deepEqual(parseKick(JSON.stringify({ event: "pusher:ping", data: "{}" })).reply.length, 1);
  assert.equal(parseKick(JSON.stringify({ event: "pusher_internal:subscription_succeeded", data: "{}" })).messages.length, 0);
  assert.equal(parseKick("not json").messages.length, 0);
  assert.equal(parseKick(kickFrame({ id: "m", content: "  ", sender: {} })).messages.length, 0);
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

test("one platform failing does not stop the other, and it retries with backoff", async () => {
  const env = { TWITCH_CHANNEL: "chan", KICK_CHATROOM_ID: "9" };
  const got: PlatformMessage[] = [];
  const sockets = new Map<string, ReturnType<typeof fakeSocket>>();
  let twitchUp = false;
  const open = async (url: string) => {
    if (url === twitchAdapter.url && !twitchUp) throw new Error("twitch down");
    const s = fakeSocket();
    sockets.set(url, s);
    return s;
  };
  const hub = new PlatformHub(env, (m) => got.push(...m), open);

  const next = await hub.tick(1_000);
  assert.equal(next, 1_000 + 2_000);
  assert.equal(hub.connected("twitch"), false);
  assert.equal(hub.connected("kick"), true);
  assert.equal(sockets.get(kickAdapter.url)?.sent.length, 1);

  sockets.get(kickAdapter.url)?.onmessage?.(kickFrame({ id: "k1", content: "still here", sender: { id: 1, username: "k" } }));
  assert.equal(got[0]?.source, "kick");

  // Too early: no new attempt. Later: connects.
  assert.equal(await hub.tick(2_000), 3_000);
  twitchUp = true;
  assert.equal(await hub.tick(3_000), null);
  assert.equal(hub.connected("twitch"), true);
  sockets.get(twitchAdapter.url)?.onmessage?.("@id=t1 :a!a@a PRIVMSG #chan :hi");
  assert.deepEqual(got.map((m) => m.source), ["kick", "twitch"]);
});

test("a dropped socket reconnects while the other keeps running", async () => {
  const env = { TWITCH_CHANNEL: "chan", KICK_CHATROOM_ID: "9" };
  const sockets: Record<string, ReturnType<typeof fakeSocket>> = {};
  const hub = new PlatformHub(env, () => undefined, async (url) => (sockets[url] = fakeSocket()));
  await hub.tick(0);
  const kickBefore = sockets[kickAdapter.url];
  sockets[twitchAdapter.url]?.onclose?.();
  assert.equal(hub.connected("twitch"), false);
  assert.equal(hub.connected("kick"), true);
  await hub.tick(Date.now() + 5_000);
  assert.equal(hub.connected("twitch"), true);
  assert.equal(sockets[kickAdapter.url], kickBefore);
});

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
  const bad = { ...twitchAdapter, hello: () => { throw new Error("boom"); } };
  const hub = new PlatformHub({ TWITCH_CHANNEL: "c" }, () => undefined, async () => { const s = fakeSocket(); sockets.push(s); return s; }, [bad]);
  assert.equal(await hub.tick(0), 2_000);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0]?.closed, true);
  assert.equal(hub.connected("twitch"), false);
  // Retry opens exactly one new socket.
  await hub.tick(2_000);
  assert.equal(sockets.length, 2);
});

test("close drops every socket",async () => {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const hub = new PlatformHub({ TWITCH_CHANNEL: "c", KICK_CHATROOM_ID: "1" }, () => undefined, async () => { const s = fakeSocket(); sockets.push(s); return s; });
  await hub.tick(0);
  hub.close();
  assert.ok(sockets.every((s) => s.closed));
  assert.equal(hub.connected("kick"), false);
});
