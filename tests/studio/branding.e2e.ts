import { describe } from "@e2e-dev/web";
import { expect } from "e2e";
import { test } from "./fixtures.ts";

describe("overlays and branding", { session: "host" }, () => {
  test("saves a lower third from Settings", async ({ app, screen, studio }) => {
    await app.open(`/studio/${studio.id}`);
    await expect(screen.getByRole("button", "Settings")).toBeVisible();

    await screen.getByRole("button", "Settings").click();
    await expect(screen.getByRole("heading", "Settings")).toBeVisible();
    await screen.getByLabel("Lower third").fill("Office hours");
    await screen.getByLabel("Lower third detail").fill("casthop.dev");
    await screen.getByRole("button", "Save").click();
    await expect(screen.getByRole("heading", "Settings")).not.toBeVisible();

    await app.open(`/studio/${studio.id}`);
    await expect(screen.getByRole("button", "Settings")).toBeVisible();
    await expect(screen.getByText("Office hours", { exact: false })).toBeVisible();
    await expect(screen.getByText("casthop.dev", { exact: false })).toBeVisible();
    await screen.getByRole("button", "Settings").click();
    await expect(screen.getByLabel("Lower third")).toHaveValue("Office hours");
    await expect(screen.getByLabel("Lower third detail")).toHaveValue("casthop.dev");
  });
});
