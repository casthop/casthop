/** Tiny IO fallback when animation-timeline: view() is not available. */
export function enhanceScroll(): void {
  if (!document.documentElement.classList.contains("js-io")) return;
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
  document.querySelectorAll(".hv-reveal, .hv-shot-stage").forEach((el) => io.observe(el));
}
