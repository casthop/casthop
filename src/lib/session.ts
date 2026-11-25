export type Session = {
  studioId: string;
  identity: string;
  name: string;
  role: "host" | "guest";
  hostKey?: string;
};

const key = (studioId: string) => `casthop.session.${studioId}`;

export function saveSession(session: Session): void {
  sessionStorage.setItem(key(session.studioId), JSON.stringify(session));
}

export function loadSession(studioId: string): Session | null {
  const raw = sessionStorage.getItem(key(studioId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}
