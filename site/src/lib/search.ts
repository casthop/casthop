// Offline docs search. The index is inlined in the page, so no network is needed.
interface Entry { title: string; group: string; url: string; text: string; }

const dialog = document.getElementById("search") as HTMLDialogElement | null;
const input = document.getElementById("search-q") as HTMLInputElement | null;
const list = document.getElementById("search-results");
const raw = document.getElementById("search-index")?.textContent;
const openBtn = document.getElementById("search-open");

if (dialog && input && list && raw) {
  const index: Entry[] = JSON.parse(raw);
  let active = 0;

  const score = (e: Entry, terms: string[]): number => {
    const title = e.title.toLowerCase();
    const text = e.text.toLowerCase();
    let s = 0;
    for (const t of terms) {
      if (title.includes(t)) s += 10;
      else if (text.includes(t)) s += 1;
      else return 0;
    }
    return s;
  };

  const snippet = (e: Entry, term: string): string => {
    const at = e.text.toLowerCase().indexOf(term);
    if (at < 0) return e.text.slice(0, 90);
    const start = Math.max(0, at - 30);
    return (start > 0 ? "…" : "") + e.text.slice(start, start + 100) + "…";
  };

  const render = () => {
    const terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = terms.length
      ? index.map((e) => ({ e, s: score(e, terms) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)
      : index.map((e) => ({ e, s: 1 }));
    active = 0;
    list.replaceChildren(
      ...hits.map(({ e }, n) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(n === 0));
        const a = document.createElement("a");
        a.href = e.url;
        const t = document.createElement("strong");
        t.textContent = e.title;
        const g = document.createElement("span");
        g.textContent = terms.length ? snippet(e, terms[0]) : e.group;
        a.append(t, g);
        li.append(a);
        return li;
      }),
    );
    if (hits.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No results.";
      list.append(li);
    }
  };

  const move = (d: number) => {
    const items = Array.from(list.querySelectorAll("li[role=option]"));
    if (!items.length) return;
    active = (active + d + items.length) % items.length;
    items.forEach((li, n) => li.setAttribute("aria-selected", String(n === active)));
    items[active].scrollIntoView({ block: "nearest" });
  };

  const open = () => {
    if (!dialog.open) dialog.showModal();
    input.value = "";
    render();
    input.focus();
  };

  openBtn?.addEventListener("click", open);
  document.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      open();
    }
  });
  input.addEventListener("input", render);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); move(1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); move(-1); }
    else if (ev.key === "Enter") {
      ev.preventDefault();
      list.querySelectorAll<HTMLAnchorElement>("li[role=option] a")[active]?.click();
    }
  });
  dialog.addEventListener("click", (ev) => { if (ev.target === dialog) dialog.close(); });
}
