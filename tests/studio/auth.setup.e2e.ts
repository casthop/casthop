import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { signInWithDevMagicLink, uniqueEmail } from "./helpers.ts";

test.setup("sign in as host with a local magic link", { sessions: ["host"] }, async ({ app, screen, browser, session }) => {
  await signInWithDevMagicLink(app, screen, browser, uniqueEmail("host"));
  await expect(screen.getByRole("button", "Sign out")).toBeVisible();
  await expect(browser).toHaveURL("/");
  await session.save("host");
});
