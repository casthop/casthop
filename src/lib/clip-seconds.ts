const KEY = "casthop.clipSeconds";

export type ClipSeconds = 30 | 60;

export function loadClipSeconds(): ClipSeconds {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "30" || raw === "60") return Number(raw) as ClipSeconds;
  } catch {
    /* private mode */
  }
  return 60;
}

export function saveClipSeconds(seconds: ClipSeconds): void {
  try {
    localStorage.setItem(KEY, String(seconds));
  } catch {
    /* quota / private mode */
  }
}