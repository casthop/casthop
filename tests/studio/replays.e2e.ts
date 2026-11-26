import { describe } from "@e2e-dev/web";
import { expect } from "e2e";
import { test } from "./fixtures.ts";

const PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
seg0.m4s
#EXT-X-ENDLIST
`;

function replayFromBody(value: unknown): { id: string; title: string } {
  if (typeof value !== "object" || value === null) {
    throw new Error("create replay: empty body");
  }
  const id = "id" in value ? value.id : undefined;
  const title = "title" in value ? value.title : undefined;
  if (typeof id !== "string" || typeof title !== "string") {
    throw new Error("create replay: missing id or title");
  }
  return { id, title };
}

describe("replays", { session: "host" }, () => {
  test("lists a recording on home and opens the viewer", async ({ app, screen, browser, studio, request }) => {
    const cookies = await browser.cookies(`${app.baseUrl}/api/studios`);
    if (cookies.length === 0) throw new Error("not signed in: no session cookie");
    const title = `Office hours replay ${Date.now()}`;
    const created = await request.post(`/api/studios/${studio.id}/replays`, {
      json: {
        title,
        visibility: "private",
        files: [
          { name: "index.m3u8", content: PLAYLIST },
          { name: "init.mp4", content: "aW5pdA==", encoding: "base64" },
          { name: "seg0.m4s", content: "c2VnMA==", encoding: "base64" },
        ],
      },
      headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
    });
    expect(created.status).toBe(200);
    const replay = replayFromBody(await created.json());

    await app.open("/");
    await expect(screen.getByRole("heading", "Open a studio")).toBeVisible();
    await expect(screen.getByRole("link", title)).toBeVisible();
    await expect(screen.getByText("Private")).toBeVisible();

    await screen.getByRole("link", title).click();
    await expect(browser).toHaveURL(new RegExp(`/watch/${replay.id}`));
    await expect(screen.getByRole("heading", title)).toBeVisible();
    await expect(screen.getByRole("button", "Make public")).toBeVisible();
    await expect(screen.getByLabel(title)).toBeVisible();

    const playlist = await request.get(`/api/replays/${replay.id}/hls/index.m3u8`, {
      headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
    });
    expect(playlist.status).toBe(200);
    expect(await playlist.text()).toContain("#EXTM3U");
  });
});
