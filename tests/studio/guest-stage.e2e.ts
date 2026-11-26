import { describe, surfaceOf } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";
import type { BrowserContext, Page } from "playwright-core";
import { studioEngine } from "../../e2e.config.ts";
import { test } from "./fixtures.ts";
import { expectStageVideo, holdStudioTokenAfterJoin } from "./helpers.ts";

let guestContext: BrowserContext | undefined;

test.afterEach(async () => {
  await guestContext?.close();
  guestContext = undefined;
});

function hostPage(): Page {
  const live = surfaceOf(studioEngine);
  if (!live) throw new Error("studio engine has no Playwright surface");
  return live.page();
}

async function openGuest(joinUrl: string): Promise<Page> {
  const live = surfaceOf(studioEngine);
  if (!live) throw new Error("studio engine has no Playwright surface");
  const chrome = live.context().browser();
  if (!chrome) throw new Error("host context has no browser");
  guestContext = await chrome.newContext({ permissions: ["camera", "microphone"] });
  const guest = await guestContext.newPage();
  await guest.goto(joinUrl);
  await guest.getByRole("heading", { name: "Join the studio" }).waitFor();
  return guest;
}

async function inviteUrl(screen: Screen): Promise<string> {
  await expect(screen.getByRole("button", "Settings")).toBeVisible();
  await screen.getByRole("button", "Invite guest").click();
  await expect(screen.getByRole("heading", "Invite guest")).toBeVisible();
  const joinUrl = await screen.getByDisplayValue(/\/join\//).inputValue();
  await screen.getByRole("button", "Done").click();
  return joinUrl;
}

describe("guest invite and stage", { session: "host" }, () => {
  test("invites a guest in a second browser and puts them on stage", async ({ app, screen, studio }) => {
    await app.open(`/studio/${studio.id}`);
    const joinUrl = await inviteUrl(screen);

    const guest = await openGuest(joinUrl);
    await guest.getByLabel("Your name").fill("Ada");
    await guest.getByRole("button", { name: "Join backstage" }).click();
    await guest.getByText("Backstage — waiting for the host").waitFor({ timeout: 60_000 });

    await expect(screen.getByRole("button", "Add Ada to stage")).toBeVisible({ timeout: 30_000 });
    await expect(screen.getByText("Backstage")).toBeVisible();
    await screen.getByRole("button", "Add Ada to stage").click();

    await expect(screen.getByRole("button", "Add Ada to stage")).not.toBeVisible({ timeout: 30_000 });
    await expect(screen.getByText("Ada")).toBeVisible();
    await guest.getByText("You are on stage").waitFor({ timeout: 30_000 });
    await expectStageVideo(hostPage(), "Host");
    await expectStageVideo(hostPage(), "Ada");
  });

  test("adding a guest to stage before they connect still shows their video", async ({ app, screen, studio }) => {
    await app.open(`/studio/${studio.id}`);
    const joinUrl = await inviteUrl(screen);

    const guest = await openGuest(joinUrl);
    const releaseToken = await holdStudioTokenAfterJoin(guest);
    await guest.getByLabel("Your name").fill("Ada");
    await guest.getByRole("button", { name: "Join backstage" }).click();
    await guest.waitForURL(/\/studio\//, { timeout: 30_000 });

    await expect(screen.getByRole("button", "Add Ada to stage")).toBeVisible({ timeout: 30_000 });
    await screen.getByRole("button", "Add Ada to stage").click();
    await expect(screen.getByRole("button", "Add Ada to stage")).not.toBeVisible({ timeout: 30_000 });
    await expect(screen.getByText("Ada")).toBeVisible();

    releaseToken();
    await guest.getByText("You are on stage").waitFor({ timeout: 60_000 });
    await expectStageVideo(hostPage(), "Ada");
  });
});
