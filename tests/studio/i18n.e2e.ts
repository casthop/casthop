import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

describe("language switcher", () => {
  test("switching to Portuguese updates the home UI", async ({ app, screen }) => {
    await app.open("/");
    await expect(screen.getByRole("button", "Language")).toBeVisible();
    await screen.getByRole("button", "Language").click();
    await screen.getByRole("button", "Português").click();
    await expect(screen.getByText("🌐 Português")).toBeVisible();
    await expect(screen.getByRole("heading", /Entrar|Abrir um estúdio/)).toBeVisible();

    await screen.getByRole("button", "Idioma").click();
    await screen.getByRole("button", "English").click();
    await expect(screen.getByText("🌐 English")).toBeVisible();
  });
});
