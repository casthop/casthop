import { describe } from "@e2e-dev/web";
import { expect } from "e2e";
import { test } from "./fixtures.ts";

describe("destinations", { session: "host" }, () => {
  test("toggles YouTube off and on", async ({ app, screen, studio }) => {
    await app.open(`/studio/${studio.id}`);
    await screen.getByRole("button", "Go live").click();
    await expect(screen.getByRole("button", "Disable YouTube")).toBeVisible();

    await screen.getByRole("button", "Disable YouTube").click();
    await expect(screen.getByRole("button", "Enable YouTube")).toBeVisible();

    await screen.getByRole("button", "Enable YouTube").click();
    await expect(screen.getByRole("button", "Disable YouTube")).toBeVisible();
  });

  test("adds a loopback Custom RTMP URL and enables it", async ({ app, screen, studio }) => {
    await app.open(`/studio/${studio.id}`);
    await screen.getByRole("button", "Destinations").click();
    await expect(screen.getByRole("heading", "Destinations")).toBeVisible();
    await screen.getByLabel("Custom RTMP RTMP URL").fill("rtmp://127.0.0.1:1935/live/custom");
    await screen.getByRole("button", "Save").click();

    await screen.getByRole("button", "Enable Custom RTMP").click();
    await expect(screen.getByRole("button", "Disable Custom RTMP")).toBeVisible();
  });

  test("marks a destination 9:16 without changing 16:9", async ({ app, screen, studio }) => {
    await app.open(`/studio/${studio.id}`);
    await screen.getByRole("button", "Destinations").click();
    await expect(screen.getByRole("heading", "Destinations")).toBeVisible();
    await expect(screen.getByRole("button", "YouTube 16:9 widescreen")).toBeVisible();
    await screen.getByRole("button", "YouTube 9:16 vertical").click();
    await expect(screen.getByRole("button", "YouTube 9:16 vertical")).toHaveAttribute("aria-pressed", "true");
    await expect(screen.getByRole("button", "LinkedIn 16:9 widescreen")).toHaveAttribute("aria-pressed", "true");
  });
});
