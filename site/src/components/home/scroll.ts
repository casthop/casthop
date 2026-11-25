/** Fallbacks when CSS scroll-driven animations are missing. */
export function enhanceScroll(): void {
  const root = document.documentElement;

  if (root.classList.contains("js-scroll")) {
    const stage = document.querySelector(".hv-shot-stage");
    if (stage instanceof HTMLElement) {
      const apply = (): void => {
        const vh = window.innerHeight || 1;
        const p = Math.min(1, Math.max(0, window.scrollY / (vh * 0.5)));
        stage.style.transform = `perspective(1800px) rotateX(${22 * (1 - p)}deg) scale(${0.92 + 0.08 * p})`;
      };
      apply();
      window.addEventListener("scroll", () => requestAnimationFrame(apply), { passive: true });
    }
  }

  if (!root.classList.contains("js-io")) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.15 },
  );
  document.querySelectorAll(".hv-reveal").forEach((el) => io.observe(el));
}
