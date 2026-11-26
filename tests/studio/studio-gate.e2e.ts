import { describe, surfaceOf } from "@e2e-dev/web";
import { expect } from "e2e";
import type { BrowserContext, Page } from "playwright-core";
import { studioEngine } from "../../e2e.config.ts";
import { test } from "./fixtures.ts";

let guestContext: BrowserContext | undefined;

test.afterEach(async () => {
  await guestContext?.close();
  guestContext = undefined;
});

describe("studio without a session", { session: "host" }, () => {
  test("unsigned /studio visit does not auto-join and offers guest join or sign-in", async ({ app, screen, studio }) => {
    await app.open(`/studio/${studio.id}`);
    await expect(screen.getByRole("button", "Settings")).toBeVisible();
    await expect(screen.getByRole("button", "Noise")).toBeVisible();

    const live = surfaceOf(studioEngine);
    if (!live) throw new Error("studio engine has no Playwright surface");
    const chrome = live.context().browser();
    if (!chrome) throw new Error("host context has no browser");
    guestContext = await chrome.newContext({ permissions: ["camera", "microphone"] });
    const guest: Page = await guestContext.newPage();
    const tokenPosts: string[] = [];
    guest.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/token")) tokenPosts.push(req.url());
    });
    await guest.goto(`${new URL(app.baseUrl).origin}/studio/${studio.id}`);
    await guest.getByRole("heading", { name: "Join as a guest" }).waitFor();
    await guest.getByRole("button", { name: "Join as guest" }).waitFor();
    await guest.getByRole("button", { name: "Sign in" }).waitFor();
    if (tokenPosts.length) throw new Error(`unsigned visit minted a token: ${tokenPosts.join(", ")}`);
    await expect(screen.getByRole("button", "Guest")).not.toBeVisible();

    await guest.getByRole("button", { name: "Join as guest" }).click();
    await guest.getByRole("heading", { name: "Join the studio" }).waitFor();
    await guest.getByRole("button", { name: "Noise removal" }).waitFor();
    await guest.getByLabel("Your name").fill("Ada");
    await guest.getByRole("button", { name: "Join backstage" }).click();
    await guest.getByText("Backstage — waiting for the host").waitFor({ timeout: 60_000 });
    await expect(screen.getByRole("button", "Add Ada to stage")).toBeVisible({ timeout: 30_000 });
  });
});
