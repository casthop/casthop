import { describe } from "@e2e-dev/web";
import { expect } from "e2e";
import { test } from "./fixtures.ts";

describe("clips", { session: "host" }, () => {
  test("Clip is hidden until live and shows with the 30/60 control while live", async ({ app, screen, studio }) => {
    await app.open(`/studio/${studio.id}`);
    await expect(screen.getByRole("button", "Go live")).toBeVisible();
    await expect(screen.getByRole("button", /Clip last/)).not.toBeVisible();

    await app.open(`/studio/${studio.id}?shot=chat`);
    await expect(screen.getByRole("button", "Clip last 60s")).toBeVisible();
    await expect(screen.getByRole("button", "60s")).toBeVisible();
    await expect(screen.getByRole("button", "30s")).toBeVisible();

    await screen.getByRole("button", "30s").click();
    await expect(screen.getByRole("button", "Clip last 30s")).toBeVisible();
  });
});
