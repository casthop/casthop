import { describe } from "@e2e-dev/web";
import { expect } from "e2e";
import { test } from "./fixtures.ts";

describe("overlays and branding", { session: "host" }, () => {
  test("saves a lower third from Settings", async ({ app, screen, studio }) => {
    await app.open(`/studio/${studio.id}`);
    await expect(screen.getByRole("button", "Lower third")).toBeVisible();

    await screen.getByRole("button", "Lower third").click();
    await expect(screen.getByRole("heading", "Lower third")).toBeVisible();
    await screen.getByRole("textbox", "Lower third").fill("Office hours");
    await screen.getByRole("textbox", "Lower third detail").fill("casthop.dev");
    await screen.getByRole("button", "Save").click();
    await screen.getByRole("button", "Close panel").click();
    await expect(screen.getByRole("heading", "Lower third")).not.toBeVisible();

    await app.open(`/studio/${studio.id}`);
    await expect(screen.getByRole("button", "Lower third")).toBeVisible();
    await expect(screen.getByText("Office hours", { exact: false })).toBeVisible();
    await expect(screen.getByText("casthop.dev", { exact: false })).toBeVisible();
    await screen.getByRole("button", "Lower third").click();
    await expect(screen.getByRole("textbox", "Lower third")).toHaveValue("Office hours");
    await expect(screen.getByRole("textbox", "Lower third detail")).toHaveValue("casthop.dev");
  });
});
