import type { Env } from "./types";

export type MailSender = {
  send(opts: { to: string; subject: string; text: string }): Promise<void>;
};

/** Default: print the link. Optional MAIL_WEBHOOK_URL POSTs JSON so a self-hosted sender can plug in. */
export function mailerFor(env: Env): MailSender {
  const webhook = env.MAIL_WEBHOOK_URL?.trim();
  if (webhook) {
    const token = env.MAIL_WEBHOOK_TOKEN?.trim();
    return {
      async send(opts) {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(webhook, { method: "POST", headers, body: JSON.stringify(opts) });
        if (!res.ok) {
          console.warn("[casthop] mail webhook failed", res.status);
        }
      },
    };
  }
  return {
    async send(opts) {
      console.log(`[casthop mail] to=${opts.to}\n${opts.subject}\n${opts.text}`);
    },
  };
}
