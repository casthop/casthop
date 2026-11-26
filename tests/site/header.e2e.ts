/**
 * Marketing site header: no horizontal scroll on phones, CTA stays one line.
 * Needs the Astro site on SITE_URL (default http://127.0.0.1:4321).
 */
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright-core";

const site = process.env.SITE_URL || "http://127.0.0.1:4321";
const chrome = process.env.CHROME || process.env.CHROME_PATH || "/usr/local/bin/chrome";
const homes = ["/", "/pt-BR/", "/de/"] as const;
const overflowPaths = [
  "/",
  "/pt-BR/",
  "/es/",
  "/fr/",
  "/de/",
  "/ja/",
  "/docs/getting-started/",
  "/pt-BR/docs/getting-started/",
  "/de/docs/getting-started/",
] as const;
const phoneWidths = [375, 320] as const;

async function ready(): Promise<boolean> {
  try {
    const res = await fetch(site);
    return res.ok;
  } catch {
    return false;
  }
}

if (!(await ready())) {
  console.error(`site not up at ${site}; start with: cd site && bun run build && bun run preview --host 127.0.0.1 --port 4321`);
  process.exit(1);
}

async function open(page: Page, path: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(`${site}${path}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
}

async function pageWidth(page: Page): Promise<{ scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    innerWidth: window.innerWidth,
  }));
}

async function assertNoHScroll(page: Page, path: string, width: number): Promise<void> {
  const { scrollWidth, innerWidth } = await pageWidth(page);
  assert.ok(
    scrollWidth <= innerWidth,
    `${path} @${width}px: scrollWidth ${scrollWidth} > viewport ${innerWidth}`,
  );
}

async function assertCtaOneLine(page: Page, path: string, width: number): Promise<void> {
  const cta = page.locator("header .hv-nav-cta");
  assert.equal(await cta.count(), 1, `${path} @${width}px: missing header CTA`);
  const metrics = await cta.evaluate((el) => {
    const cs = getComputedStyle(el);
    const paddingY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const line = Number.parseFloat(cs.lineHeight);
    const height = el.getBoundingClientRect().height;
    const content = height - paddingY - borderY;
    return { whiteSpace: cs.whiteSpace, lines: content / line };
  });
  assert.equal(metrics.whiteSpace, "nowrap", `${path} @${width}px: CTA white-space is ${metrics.whiteSpace}`);
  assert.ok(metrics.lines < 1.35, `${path} @${width}px: CTA is ${metrics.lines.toFixed(2)} lines`);
}

const browser = await chromium.launch({
  executablePath: chrome,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();

  for (const width of phoneWidths) {
    for (const path of overflowPaths) {
      await open(page, path, width);
      await assertNoHScroll(page, path, width);
    }
    for (const path of homes) {
      await open(page, path, width);
      await assertCtaOneLine(page, path, width);
      assert.equal(await page.locator("header .hv-nav-sec").count(), 2);
      assert.ok(await page.locator("header .hv-nav-sec").first().isHidden(), `${path} @${width}px: Docs should be in the menu`);
      assert.ok(await page.locator("header .nav-more-btn").isVisible(), `${path} @${width}px: menu button missing`);
      assert.ok(await page.locator("header .lang-switch-code").isVisible(), `${path} @${width}px: compact language missing`);
      assert.ok(await page.locator("header .lang-switch-name").isHidden(), `${path} @${width}px: full language name should hide`);
    }
  }

  await open(page, "/", 1100);
  assert.ok(await page.locator("header a.hv-nav-sec").first().isVisible(), "desktop Docs link should stay visible");
  assert.ok(await page.locator("header .nav-more-btn").isHidden(), "desktop should not show the menu button");
  assert.ok(await page.locator("header .lang-switch-name").isVisible(), "desktop language should stay the full name");
  await assertCtaOneLine(page, "/", 1100);

  await open(page, "/pt-BR/", 375);
  const menu = page.locator("header .nav-more-btn");
  await menu.click();
  assert.equal(await menu.getAttribute("aria-expanded"), "true");
  const docsInMenu = page.locator("#site-nav-more a").first();
  assert.ok(await docsInMenu.isVisible());
  await page.keyboard.press("Escape");
  assert.equal(await menu.getAttribute("aria-expanded"), "false");

  const lang = page.locator("header [data-locale-switcher]");
  await lang.click();
  assert.equal(await lang.getAttribute("aria-expanded"), "true");
  assert.ok(await page.getByRole("option", { name: "Português" }).isVisible());
  await page.keyboard.press("Escape");
  assert.equal(await lang.getAttribute("aria-expanded"), "false");

  console.log("site header e2e ok");
} finally {
  await browser.close();
}
