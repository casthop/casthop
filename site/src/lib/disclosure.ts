export function bindDisclosures(): void {
  for (const root of document.querySelectorAll<HTMLElement>("[data-disclosure-root]")) {
    if (root.dataset.disclosureBound === "1") continue;
    root.dataset.disclosureBound = "1";
    const btn = root.querySelector<HTMLButtonElement>("[data-disclosure]");
    const panel = root.querySelector<HTMLElement>("[data-disclosure-panel]");
    if (!btn || !panel) continue;

    const items = () => [...panel.querySelectorAll<HTMLElement>("a, button")];

    const setOpen = (open: boolean) => {
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    };

    const closeOthers = () => {
      for (const other of document.querySelectorAll<HTMLElement>("[data-disclosure-root]")) {
        if (other === root) continue;
        const otherBtn = other.querySelector<HTMLButtonElement>("[data-disclosure]");
        const otherPanel = other.querySelector<HTMLElement>("[data-disclosure-panel]");
        if (otherBtn && otherPanel) {
          otherPanel.hidden = true;
          otherBtn.setAttribute("aria-expanded", "false");
        }
      }
    };

    btn.addEventListener("click", () => {
      const open = panel.hidden;
      if (open) closeOthers();
      setOpen(open);
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown") return;
      e.preventDefault();
      if (panel.hidden) {
        closeOthers();
        setOpen(true);
      }
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
