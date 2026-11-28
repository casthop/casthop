import { CAPTION_SHOW_MS } from "../../worker/captions";
import type { CaptionLine, CaptionSettings } from "../../worker/types";

export type CaptionView = { name: string; text: string };

/**
 * What the program should show right now. Burned captions only, and only for a few
 * seconds after a line arrives. Timing uses this page's clock, not the Worker's,
 * so a skewed clock cannot hide or pin a line.
 */
export class CaptionTracker {
  private key = "";
  private seenAt = 0;

  view(settings: CaptionSettings | undefined, line: CaptionLine | null | undefined, now: number): CaptionView | null {
    if (!settings?.on || !settings.burn || !line) return null;
    const key = `${line.at}|${line.text}`;
    if (key !== this.key) {
      this.key = key;
      this.seenAt = now;
    }
    return now - this.seenAt < CAPTION_SHOW_MS ? { name: line.name, text: line.text } : null;
  }
}
