function closeRoot(root: HTMLElement): void {
  const btn = root.querySelector<HTMLButtonElement>("[data-disclosure]");
  const panel = root.querySelector<HTMLElement>("[data-disclosure-panel]");
  if (!btn || !panel) return;
  panel.hidden = true;
  btn.setAttribute("aria-expanded", "false");
}

function closeOthers(root: HTMLElement): void {
  for (const other of document.querySelectorAll<HTMLElement>("[data-disclosure-root]")) {
    if (other !== root) closeRoot(other);
  }
}

export function bindDisclosures(): void {
  for (const root of document.querySelectorAll<HTMLElement>("[data-disclosure-root]")) {
    if (root.dataset.disclosureBound === "1") continue;
    root.dataset.disclosureBound = "1";
    const btn = root.querySelector<HTMLButtonElement>("[data-disclosure]");
    const panel = root.querySelector<HTMLElement>("[data-disclosure-panel]");
    if (!btn || !panel) continue;

    const items = () => [...panel.querySelectorAll<HTMLElement>("a, button")];

    const setOpen = (open: boolean) => {
      if (open) closeOthers(root);
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    };

    btn.addEventListener("click", () => {
      setOpen(panel.hidden);
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown") return;
      e.preventDefault();
      setOpen(true);
      items()[0]?.focus();
    });
    panel.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const list = items();
      const i = list.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      e.preventDefault();
      const next = e.key === "ArrowDown" ? list[(i + 1) % list.length] : list[(i - 1 + list.length) % list.length];
      next?.focus();
    });
    document.addEventListener("pointerdown", (e) => {
      if (!root.contains(e.target as Node)) setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || panel.hidden) return;
      setOpen(false);
      btn.focus();
    });
  }
}
