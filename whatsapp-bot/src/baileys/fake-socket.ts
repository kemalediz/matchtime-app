/**
 * A stand-in for Baileys' `WASocket`, for tests. NEVER used in production.
 *
 * No test in this repo may open a socket: about a hundred directory
 * lookups from HomeTenant's production account got every linked device on
 * the number unlinked on 2026-09-17 (`main.source.test.ts`). So the
 * lifecycle, the inbound path and the reaction path are all driven through
 * this object instead: an event emitter shaped like `sock.ev`, a `user`,
 * and the handful of methods the driver calls, each of which records what
 * it was asked rather than doing it.
 *
 * `sendMessage` builds its return value with Baileys' OWN
 * `generateWAMessage`, so a sent key has exactly the shape a real send
 * returns, as in `drivers/baileys.test.ts`.
 *
 * It lives beside the code rather than in a `.test.ts` file so several
 * test files can share it; `tsc` checks it like everything else.
 */
import { generateWAMessage, type AnyMessageContent, type WAMessage } from "baileys";

type Listener = (arg: unknown) => void;

export const FAKE_ME_PN = "447700900001:12@s.whatsapp.net";
export const FAKE_ME_LID = "158000000000001:12@lid";

export class FakeSocket {
  private readonly listeners = new Map<string, Listener[]>();

  user: { id?: string | null; lid?: string | null } | null | undefined = {
    id: FAKE_ME_PN,
    lid: FAKE_ME_LID,
  };

  readonly sent: Array<{ jid: string; content: unknown; options?: unknown }> = [];
  readonly ended: Array<Error | undefined> = [];
  loggedOut = 0;
  readonly pairingRequests: string[] = [];
  pairingCode: string | Error = "ABCD1234";
  /** Full LID JID to phone JID, standing in for Baileys' local mapping store. */
  readonly storedPnForLid = new Map<string, string>();
  readonly pnLookups: string[] = [];

  readonly ev = {
    on: (event: string, listener: Listener): void => {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
    },
  };

  readonly signalRepository = {
    lidMapping: {
      getPNForLID: async (lid: string): Promise<string | null> => {
        this.pnLookups.push(lid);
        return this.storedPnForLid.get(lid) ?? null;
      },
    },
  };

  emit(event: string, arg: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(arg);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  // ── connection.update shorthands ───────────────────────────────────
  open(): void {
    this.emit("connection.update", { connection: "open" });
  }

  closeWith(statusCode?: number): void {
    const error =
      statusCode === undefined
        ? new Error("socket closed")
        : Object.assign(new Error(`closed ${statusCode}`), { output: { statusCode } });
    this.emit("connection.update", { connection: "close", lastDisconnect: { error, date: new Date() } });
  }

  qr(value = "2@fake-qr-ref"): void {
    this.emit("connection.update", { qr: value });
  }

  // ── what the driver calls ──────────────────────────────────────────
  async requestPairingCode(phone: string): Promise<string> {
    this.pairingRequests.push(phone);
    if (this.pairingCode instanceof Error) throw this.pairingCode;
    return this.pairingCode;
  }

  end(error: Error | undefined): void {
    this.ended.push(error);
  }

  /** Present so a test can prove it is never called. */
  async logout(): Promise<void> {
    this.loggedOut++;
  }

  async sendMessage(jid: string, content: AnyMessageContent, options?: unknown): Promise<WAMessage> {
    this.sent.push({ jid, content, options });
    return generateWAMessage(jid, structuredClone(content) as never, {
      ...(options as object),
      userJid: FAKE_ME_PN,
      upload: async () => {
        throw new Error("no test may upload media");
      },
      getUrlInfo: async () => {
        throw new Error("a link preview was requested: the Pi would have fetched our URL");
      },
    } as never);
  }
}

/** A scheduler the test drives by hand, so reconnect delays are observable. */
export function manualScheduler() {
  const pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  return {
    pending,
    schedule(fn: () => void, ms: number) {
      const entry = { fn, ms, cancelled: false };
      pending.push(entry);
      return {
        cancel() {
          entry.cancelled = true;
        },
      };
    },
    /** Run everything scheduled so far, in order, and forget it. */
    async runAll(): Promise<void> {
      const due = pending.splice(0);
      for (const e of due) if (!e.cancelled) e.fn();
      // Let the async connect() that a timer kicks off settle.
      await new Promise((r) => setImmediate(r));
    },
    delays(): number[] {
      return pending.filter((e) => !e.cancelled).map((e) => e.ms);
    },
  };
}
