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

describe("guest invite and stage", { session: "host" }, () => {
  test("invites a guest in a second browser and puts them on stage", async ({ app, screen, studio }) => {
    await app.open(`/studio/${studio.id}`);
    await expect(screen.getByRole("button", "Settings")).toBeVisible();

    await screen.getByRole("button", "+ Invite guest").click();
    await expect(screen.getByRole("heading", "Invite guest")).toBeVisible();
    const joinUrl = await screen.getByDisplayValue(/\/join\//).inputValue();
    await screen.getByRole("button", "Done").click();

    const live = surfaceOf(studioEngine);
    if (!live) throw new Error("studio engine has no Playwright surface");
    const chrome = live.context().browser();
    if (!chrome) throw new Error("host context has no browser");
    guestContext = await chrome.newContext({ permissions: ["camera", "microphone"] });
    const guest: Page = await guestContext.newPage();
    await guest.goto(joinUrl);
    await guest.getByRole("heading", { name: "Join the studio" }).waitFor();
    await guest.getByLabel("Your name").fill("Ada");
    await guest.getByRole("button", { name: "Join backstage" }).click();
    await guest.getByText("Backstage — waiting for the host").waitFor({ timeout: 60_000 });

    await expect(screen.getByRole("button", "Ada")).toBeVisible({ timeout: 30_000 });
    await expect(screen.getByRole("heading", "Backstage · 1")).toBeVisible();
    await screen.getByRole("button", "Ada").click();

    await expect(screen.getByRole("button", "Ada · on stage")).toBeVisible({ timeout: 30_000 });
    await expect(screen.getByRole("heading", "Backstage · 0")).toBeVisible();
    await guest.getByText("You are on stage").waitFor({ timeout: 30_000 });
  });
});
