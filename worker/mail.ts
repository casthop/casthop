import type { Env } from "./types";
import { allowDevLogin } from "./security";

export type MailSender = {
  send(opts: { to: string; subject: string; text: string }): Promise<void>;
};

export class MailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailSendError";
  }
}

/** Optional MAIL_WEBHOOK_URL POSTs JSON so a self-hosted sender can plug in. Console only in local/dev. */
export function mailerFor(env: Env): MailSender {
  const webhook = env.MAIL_WEBHOOK_URL?.trim();
  if (webhook) {
    const token = env.MAIL_WEBHOOK_TOKEN?.trim();
    return {
      async send(opts) {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        let res: Response;
        try {
          res = await fetch(webhook, { method: "POST", headers, body: JSON.stringify(opts) });
        } catch {
          throw new MailSendError("mail webhook failed");
        }
        if (!res.ok) {
          throw new MailSendError(`mail webhook failed: ${res.status}`);
        }
      },
    };
  }
  return {
    async send(opts) {
      if (allowDevLogin(env)) {
        console.log(`[casthop mail] to=${opts.to}\n${opts.subject}\n${opts.text}`);
        return;
      }
      throw new MailSendError("no mail sender configured; set MAIL_WEBHOOK_URL");
    },
  };
}
