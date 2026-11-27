import { describe } from "@e2e-dev/web";
import { expect } from "e2e";
import { test } from "./fixtures.ts";

describe("studio shell", { session: "host" }, () => {
  test("rail opens Chat, Destinations, Lower third, and Settings one at a time", async ({ app, screen, studio }) => {
    await app.open(`/studio/${studio.id}`);
    await expect(screen.getByRole("button", "Chat")).toBeVisible();
    await expect(screen.getByRole("heading", "Chat")).not.toBeVisible();

    await screen.getByRole("button", "Chat").click();
    await expect(screen.getByRole("heading", "Chat")).toBeVisible();
    await expect(screen.getByLabel("Studio chat")).toBeVisible();

    await screen.getByRole("button", "Destinations").click();
    await expect(screen.getByRole("heading", "Destinations")).toBeVisible();
    await expect(screen.getByRole("heading", "Chat")).not.toBeVisible();
    await expect(screen.getByRole("button", "Disable YouTube")).toBeVisible();

    await screen.getByRole("button", "Lower third").click();
    await expect(screen.getByRole("heading", "Lower third")).toBeVisible();
    await expect(screen.getByRole("textbox", "Lower third")).toBeVisible();
    await expect(screen.getByRole("heading", "Destinations")).not.toBeVisible();

    await screen.getByRole("button", "Recordings").click();
    await expect(screen.getByRole("heading", "Recordings")).toBeVisible();
    await expect(screen.getByText("No separate recordings yet", { exact: false })).toBeVisible();
    await expect(screen.getByRole("heading", "Lower third")).not.toBeVisible();

    await screen.getByRole("button", "Settings").click();
    await expect(screen.getByRole("heading", "Settings")).toBeVisible();
    await expect(screen.getByLabel("Studio title")).toBeVisible();
    await expect(screen.getByRole("heading", "Lower third")).not.toBeVisible();

    await screen.getByRole("button", "Close panel").click();
    await expect(screen.getByRole("heading", "Settings")).not.toBeVisible();
  });

  test("Go live opens a destination dialog and close dismisses it", async ({ app, screen, studio }) => {
    await app.open(`/studio/${studio.id}`);
    await screen.getByRole("button", "Go live").click();
    await expect(screen.getByRole("heading", "Go live")).toBeVisible();
    await expect(screen.getByText("Stream the stage to these destinations.")).toBeVisible();
    await expect(screen.getByRole("button", "Disable YouTube")).toBeVisible();
    await expect(screen.getByRole("button", "Disable LinkedIn")).toBeVisible();
    await expect(screen.getByRole("button", "Disable X")).toBeVisible();
    await expect(screen.getByRole("button", /Go live on/)).toBeVisible();

    await screen.getByRole("button", "Disable YouTube").click();
    await expect(screen.getByRole("button", "Enable YouTube")).toBeVisible();
    await expect(screen.getByRole("button", /Go live on/)).toBeVisible();

    await screen.getByRole("button", "Close").click();
    await expect(screen.getByRole("heading", "Go live")).not.toBeVisible();
    await expect(screen.getByRole("button", "Go live")).toBeVisible();
  });
});
