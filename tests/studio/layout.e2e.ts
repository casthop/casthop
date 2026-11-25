import { describe } from "@e2e-dev/web";
import { expect } from "e2e";
import { test } from "./fixtures.ts";

describe("scenes and layout", { session: "host" }, () => {
  test("switches Solo, Side by side, and Screen + cams", async ({ app, screen, studio }) => {
    await app.open(`/studio/${studio.id}`);
    await expect(screen.getByRole("button", "Side by side")).toHaveAttribute("aria-pressed", "true");

    await screen.getByRole("button", "Solo").click();
    await expect(screen.getByRole("button", "Solo")).toHaveAttribute("aria-pressed", "true");

    await screen.getByRole("button", "Screen + cams").click();
    await expect(screen.getByRole("button", "Screen + cams")).toHaveAttribute("aria-pressed", "true");

    await screen.getByRole("button", "Side by side").click();
    await expect(screen.getByRole("button", "Side by side")).toHaveAttribute("aria-pressed", "true");
  });
});
