import { describe } from "@e2e-dev/web";
import { expect } from "e2e";
import { test } from "./fixtures.ts";

describe("studio chat", { session: "host" }, () => {
  test("sends a studio comment and pins it on the preview", async ({ app, screen, studio }) => {
    await app.open(`/studio/${studio.id}`);
    await screen.getByRole("button", "Chat").click();
    await expect(screen.getByRole("heading", "Chat")).toBeVisible();

    await screen.getByLabel("Studio chat").fill("hello booth");
    await screen.getByRole("button", "Send chat").click();
    await expect(screen.getByText("hello booth")).toBeVisible();

    await screen.getByText("hello booth").hover();
    await screen.getByRole("button", "Pin this comment").click();
    await expect(screen.getByRole("button", "Unpin comment")).toBeVisible();
    await expect(screen.getByRole("status", "Pinned comment from Host")).toBeVisible();
  });
});
