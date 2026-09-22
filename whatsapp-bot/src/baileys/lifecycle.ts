/**
 * The Baileys socket's lifecycle: build it, pair it, watch it, rebuild it.
 *
 * ── Why this is new work ────────────────────────────────────────────
 * whatsapp-web.js owned its own reconnection; the bot only ever heard
 * `ready` and `disconnected`. Baileys hands every close back to the caller
 * and expects a NEW socket (plan §1.1 item 8). Phase 1's observer
 * (`main.ts`) proved the shape; this module is that shape made reusable
 * and testable, so the driver can own it. Same rules, same tests' spirit:
 *
 *   - the close decision is `decideOnClose` (`connection.ts`), the
 *     HomeTenant policy, unchanged: fatal codes exit, 515 reconnects at
 *     once, everything else backs off to a minute, ten in a row exits;
 *   - a GENERATION COUNTER guards every event, because a replaced
 *     socket's handlers keep firing and a stale `close` would otherwise
 *     schedule a second connect, and then there are two sockets on one
 *     auth folder, evicting each other in a 440 loop;
 *   - `end(undefined)` to close, never `logout()`.
 *
 * ── Two things added on top of Phase 1 ──────────────────────────────
 * Both live in `session-ledger.ts`, because both must survive a restart:
 *
 *   1. A 401 (logged out) exits WITHOUT reconnecting, as before, and now
 *      also latches the session, so the next start refuses instead of
 *      looping through systemd with a dead session.
 *   2. Pairing codes are rationed across sockets and processes, not just
 *      once per socket. Past the budget the QR is shown instead.
 *
 * ── What the driver sees ────────────────────────────────────────────
 * `onOpen` fires on EVERY open, and `onClose` on every close. That matches
 * what `index.ts` relies on: its close handler stops the scheduler, the
 * flush timer and the org refresh, and its open handler is the only thing
 * that starts them again (all three restart cleanly after a stop). A
 * reconnect that did not re-fire `onOpen` would leave the bot connected
 * and deaf, which looks exactly like healthy.
 *
 * Socket events the driver cares about (`messages.upsert`,
 * `messages.reaction`, `contacts.*`) are subscribed through `on()`, which
 * re-attaches them to every new socket behind the same generation guard.
 *
 * No Baileys runtime import: the socket is built by an injected factory, so
 * every line here runs in a test against `fake-socket.ts`.
 */
import type { BaileysEventMap } from "baileys";
import { decideOnClose } from "./connection.js";
import { pairingCodeBanner } from "./config.js";
import type { SessionLedger } from "./session-ledger.js";

/** The part of `WASocket` the lifecycle touches. */
export interface LifecycleSocket {
  ev: {
    on<K extends keyof BaileysEventMap>(event: K, listener: (arg: BaileysEventMap[K]) => void): void;
  };
  user?: { id?: string | null; lid?: string | null } | null;
  requestPairingCode(phone: string): Promise<string>;
  end(error: Error | undefined): void;
}

export interface LifecycleDeps<S extends LifecycleSocket> {
  /** Build a socket. Building one CONNECTS it: never call this in a test with the real factory. */
  makeSocket(): S | Promise<S>;
  /** Digits only, or "" for the QR route. */
  pairPhone: string;
  ledger: SessionLedger;
  /** Render a QR for a human. */
  printQr(qr: string): void;
  schedule?(fn: () => void, ms: number): { cancel(): void };
  /** Defaults to process.exit. Injected so a test can watch it. */
  exit?(code: number): void;
  log?(line: string): void;
  error?(line: string): void;
}

export type SocketEventHandler<S, K extends keyof BaileysEventMap> = (
  arg: BaileysEventMap[K],
  sock: S,
) => void;

export interface BaileysConnection<S extends LifecycleSocket> {
  /** Build the first socket. Resolves once it exists, NOT once it is open. */
  start(): Promise<void>;
  /** Stop reconnecting and end the socket. Never logs out. */
  close(): Promise<void>;
  /** The socket, only while it is open. What sends use. */
  openSocket(): S | null;
  /** The newest socket in any state. What `close` and local store reads use. */
  latestSocket(): S | null;
  /** Our own ids as the last open socket reported them. */
  user(): { id?: string | null; lid?: string | null } | null;
  onOpen(handler: () => void | Promise<void>): void;
  onClose(handler: (reason: string) => void): void;
  /** Subscribe to a socket event on the current socket and every future one. */
  on<K extends keyof BaileysEventMap>(event: K, handler: SocketEventHandler<S, K>): void;
}

function statusOf(update: Partial<BaileysEventMap["connection.update"]>): number | undefined {
  const err = update.lastDisconnect?.error as { output?: { statusCode?: unknown } } | undefined;
  const code = err?.output?.statusCode;
  return typeof code === "number" ? code : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createBaileysConnection<S extends LifecycleSocket>(
  deps: LifecycleDeps<S>,
): BaileysConnection<S> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const error = deps.error ?? ((l: string) => console.error(l));
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(t) };
    });
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  const openHandlers: Array<() => void | Promise<void>> = [];
  const closeHandlers: Array<(reason: string) => void> = [];
  const subscriptions: Array<{ event: keyof BaileysEventMap; handler: SocketEventHandler<S, never> }> =
    [];

  let current: S | null = null;
  let isOpen = false;
  let lastUser: { id?: string | null; lid?: string | null } | null = null;
  let generation = 0;
  let failures = 0;
  let started = false;
  let closing = false;
  let pendingReconnect: { cancel(): void } | null = null;

  function fireOpen(): void {
    for (const h of openHandlers) {
      try {
        void Promise.resolve(h()).catch((err) =>
          error(`[baileys] an onOpen handler failed: ${errorText(err)}`),
        );
      } catch (err) {
        error(`[baileys] an onOpen handler failed: ${errorText(err)}`);
      }
    }
  }

  function fireClose(reason: string): void {
    for (const h of closeHandlers) {
      try {
        h(reason);
      } catch (err) {
        error(`[baileys] an onClose handler failed: ${errorText(err)}`);
      }
    }
  }

  function attach<K extends keyof BaileysEventMap>(
    s: S,
    gen: number,
    event: K,
    handler: SocketEventHandler<S, K>,
  ): void {
    s.ev.on(event, (arg) => {
      if (gen !== generation) return; // a replaced socket talking
      try {
        handler(arg, s);
      } catch (err) {
        error(`[baileys] ${String(event)} handler failed: ${errorText(err)}`);
      }
    });
  }

  async function onQr(s: S, qr: string, state: { codeRequested: boolean }): Promise<void> {
    if (!deps.pairPhone) {
      log("\nScan this QR code with the MatchTime WhatsApp number:\n");
      deps.printQr(qr);
      return;
    }
    // Once per socket, whatever else happens: Baileys refreshes the QR
    // several times per socket, and each refresh is not a new request.
    if (state.codeRequested) return;
    state.codeRequested = true;

    const budget = deps.ledger.tryPairingRequest();
    if (!budget.ok) {
      error(
        `CRITICAL: [baileys] pairing code NOT requested: ${budget.reason}. Asking again this ` +
          `soon risks the bot's number (runbook §5). Showing the QR instead; the next code ` +
          `may be requested in ${Math.ceil(budget.retryAfterMs / 1000)}s.`,
      );
      deps.printQr(qr);
      return;
    }
    try {
      const code = await s.requestPairingCode(deps.pairPhone);
      log(pairingCodeBanner(deps.pairPhone, code));
    } catch (err) {
      error(`[baileys] requestPairingCode failed (${errorText(err)}); showing the QR instead`);
      deps.printQr(qr);
    }
  }

  function onUpdate(
    s: S,
    gen: number,
    update: Partial<BaileysEventMap["connection.update"]>,
    state: { codeRequested: boolean },
  ): void {
    if (gen !== generation || closing) return;
    const { connection, qr } = update;

    if (qr) void onQr(s, qr, state);

    if (connection === "open") {
      isOpen = true;
      failures = 0;
      lastUser = s.user ? { ...s.user } : lastUser;
      log(`[baileys] connected as ${s.user?.id ?? "?"} (lid ${s.user?.lid ?? "none"})`);
      fireOpen();
    }

    if (connection === "close") {
      isOpen = false;
      const status = statusOf(update);
      const decision = decideOnClose(status, failures);
      if (decision.action === "exit") {
        if (status === 401) deps.ledger.recordLoggedOut(401);
        const reason = `disconnected: ${decision.reason}`;
        fireClose(reason);
        error(`CRITICAL: [baileys] ${reason} Exiting; not reconnecting.`);
        exit(decision.code);
        return;
      }
      failures++;
      const reason =
        `connection closed (status ${status ?? "unknown"}), reconnecting in ` +
        `${decision.delayMs}ms (attempt ${failures})`;
      error(`[baileys] ${reason}`);
      fireClose(reason);
      pendingReconnect = schedule(() => {
        pendingReconnect = null;
        if (gen !== generation || closing) return;
        void connect().catch((err) => {
          // A factory that throws on a reconnect is a failed attempt, not
          // a reason to go quiet: count it and try again by the policy.
          error(`[baileys] could not rebuild the socket: ${errorText(err)}`);
          onUpdate(s, gen, { connection: "close" }, state);
        });
      }, decision.delayMs);
    }
  }

  async function connect(): Promise<void> {
    const s = await deps.makeSocket();
    if (closing) {
      s.end(undefined);
      return;
    }
    const gen = ++generation;
    current = s;
    isOpen = false;
    const state = { codeRequested: false };
    s.ev.on("connection.update", (update) => onUpdate(s, gen, update, state));
    for (const sub of subscriptions) attach(s, gen, sub.event, sub.handler as never);
  }

  return {
    async start() {
      if (started) {
        log("[baileys] start() called twice; the socket already exists, ignoring");
        return;
      }
      const latched = deps.ledger.loggedOut();
      if (latched) {
        throw new Error(
          `[baileys] this session was logged out by WhatsApp (status ${latched.status}) at ` +
            `${latched.atIso}, so it will not connect again: that would only get the same answer. ` +
            "Re-pair per MDs/baileys-migration-plan-2026-09-21.md Phase 6: stop the bot, move the " +
            "auth folder aside (keep it), start, and link the device afresh.",
        );
      }
      started = true;
      try {
        await connect();
      } catch (err) {
        started = false;
        throw err;
      }
    },

    async close() {
      closing = true;
      pendingReconnect?.cancel();
      pendingReconnect = null;
      isOpen = false;
      const s = current;
      if (!s) return;
      try {
        // end(), never logout(): logout unlinks the device (§2.10).
        s.end(undefined);
      } catch {
        /* already closed */
      }
    },

    openSocket() {
      return isOpen ? current : null;
    },

    latestSocket() {
      return current;
    },

    user() {
      // Live first: Baileys updates `sock.user` in place when the creds
      // change (a LID can arrive after pairing). The remembered copy covers
      // the gap between a close and the next socket.
      const live = current?.user;
      return live && (live.id || live.lid) ? { ...live } : lastUser;
    },

    onOpen(handler) {
      openHandlers.push(handler);
    },

    onClose(handler) {
      closeHandlers.push(handler);
    },

    on(event, handler) {
      subscriptions.push({ event, handler: handler as SocketEventHandler<S, never> });
      if (current) attach(current, generation, event, handler);
    },
  };
}
