import type { Browser, WebApp } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";
import type { Page } from "playwright-core";

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}@example.com`;
}

type MagicLinkBody = {
  ok?: boolean;
  devLogin?: string;
};

function isMagicLinkBody(value: unknown): value is MagicLinkBody {
  return typeof value === "object" && value !== null;
}

/** Loopback magic-link: POST returns `devLogin`, confirm page sets the session cookie. */
export async function signInWithDevMagicLink(
  app: WebApp,
  screen: Screen,
  browser: Browser,
  email: string,
): Promise<void> {
  await app.open("/");
  await expect(screen.getByRole("heading", "Sign in")).toBeVisible();
  await screen.getByLabel("Email").fill(email);
  const pending = browser.waitForResponse({ method: "POST", url: "**/api/auth/magic-link" });
  await screen.getByRole("button", "Email me a link").click();
  const res = await pending;
  expect(res).toBeOK();
  const body: unknown = await res.json();
  if (!isMagicLinkBody(body) || !body.devLogin) {
    throw new Error("magic link did not return a local login path; set CASTHOP_DEV_LOGIN=1 in .dev.vars");
  }
  await app.open(body.devLogin);
  await screen.getByRole("button", "Sign in").click();
  await expect(screen.getByRole("heading", "Open a studio")).toBeVisible();
}

/** True when the named program tile has decoded video, not just a silhouette. */
export async function expectStageVideo(page: Page, name: string, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    (label) => {
      const tiles = Array.from(document.querySelectorAll(".program .tile"));
      for (const tile of tiles) {
        const tag = tile.querySelector(".name, .tag")?.textContent?.trim();
        if (tag !== label) continue;
        const video = tile.querySelector("video");
        return Boolean(video && video.readyState >= 2 && video.videoWidth > 0);
      }
      return false;
    },
    name,
    { timeout },
  );
}

/** Hold the studio page token mint so the guest is listed backstage before they connect to LiveKit. */
export async function holdStudioTokenAfterJoin(page: Page): Promise<() => void> {
  let tokens = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/studios/*/token", async (route) => {
    tokens += 1;
    if (tokens > 1) await gate;
    await route.continue();
  });
  return release;
}
