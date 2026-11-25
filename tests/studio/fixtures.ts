import { test as base } from "@e2e-dev/web";
import { expect } from "e2e";

export type OpenedStudio = {
  id: string;
  title: string;
};

function studioFromBody(value: unknown): OpenedStudio {
  if (typeof value !== "object" || value === null) {
    throw new Error("create studio: empty body");
  }
  const id = "id" in value ? value.id : undefined;
  const title = "title" in value ? value.title : undefined;
  if (typeof id !== "string" || typeof title !== "string") {
    throw new Error("create studio: missing id or title");
  }
  return { id, title };
}

export const test = base.extend<{ studio: OpenedStudio }>({
  studio: async ({ app, browser, request }, use) => {
    const cookies = await browser.cookies(`${app.baseUrl}/api/studios`);
    if (cookies.length === 0) throw new Error("not signed in: no session cookie");
    const title = `Studio ${Date.now()}`;
    const created = await request.post("/api/studios", {
      json: { title },
      headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
    });
    expect(created.status).toBe(200);
    await use(studioFromBody(await created.json()));
  },
});
