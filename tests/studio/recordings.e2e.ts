import { describe } from "@e2e-dev/web";
import { expect } from "e2e";
import { test } from "./fixtures.ts";

describe("recordings", { session: "host" }, () => {
  test("Go live can turn on separate recordings", async ({ app, screen, studio }) => {
    await app.open(`/studio/${studio.id}`);
    await screen.getByRole("button", "Go live").click();
    await expect(screen.getByRole("heading", "Go live")).toBeVisible();
    await expect(screen.getByRole("button", "Enable separate recordings")).toBeVisible();

    await screen.getByRole("button", "Enable separate recordings").click();
    await expect(screen.getByRole("button", "Disable separate recordings")).toBeVisible();

    await screen.getByRole("button", "Close").click();
    await screen.getByRole("button", "Go live").click();
    await expect(screen.getByRole("button", "Disable separate recordings")).toBeVisible();
  });

  test("Recordings panel is empty before a show", async ({ app, screen, studio }) => {
    await app.open(`/studio/${studio.id}`);
    await screen.getByRole("button", "Recordings").click();
    await expect(screen.getByRole("heading", "Recordings")).toBeVisible();
    await expect(screen.getByText("No separate recordings yet", { exact: false })).toBeVisible();
  });
});
