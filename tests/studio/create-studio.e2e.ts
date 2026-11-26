import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

describe("create studio", { session: "host" }, () => {
  test("opens a new studio from the home page", async ({ app, screen, browser }) => {
    const title = `Office hours ${Date.now()}`;
    await app.open("/");
    await expect(screen.getByRole("heading", "Open a studio")).toBeVisible();

    await screen.getByLabel("Studio title").fill(title);
    await screen.getByRole("button", "Open studio").click();

    await expect(browser).toHaveURL(/\/studio\//);
    await expect(screen.getByRole("heading", title)).toBeVisible();
    await expect(screen.getByRole("button", "Go live")).toBeVisible();
  });
});
