import { log } from './logger.js';

/**
 * Optional Telegram alerts. Deliberately best-effort: a failed notification must
 * never interrupt trading, so every error is swallowed after logging.
 */
export class Notifier {
  constructor(private readonly token?: string, private readonly chatId?: string) {}

  get enabled(): boolean { return Boolean(this.token && this.chatId); }

  async send(text: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log.warn('Telegram rejected the message', { status: res.status });
    } catch (err) {
      log.warn('Telegram notification failed', { error: String(err) });
    }
  }
}
