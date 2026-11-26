import type { ViewerRole } from "../../worker/types";
import type { Session } from "./session";

/** Hosts connect from /studio/:id. Guests only after /join/:id saved a session. */
export function canConnectToStudio(viewerRole: ViewerRole, session: Session | null): boolean {
  if (viewerRole === "owner" || viewerRole === "cohost") return true;
  return session !== null;
}
