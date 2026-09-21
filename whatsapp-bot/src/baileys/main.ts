/**
 * The Baileys entry point. `npm run start:baileys`.
 *
 * ── What this is, and what it deliberately is not ───────────────────
 * Phase 1 of the migration in `MDs/baileys-migration-plan-2026-09-21.md`:
 * a socket, an auth state, a reconnect policy, and inbound message
 * receipt. It OBSERVES. It sends nothing, starts no scheduler, runs no
 * flush and calls no MatchTime endpoint.
 *
 * That restraint is not tidiness, it is the safety property. WhatsApp
 * allows about four linked devices per account, so running this beside the
 * live whatsapp-web.js bot means two devices, and BOTH receive every
 * message. If both could also send, both would reply to the same message.
 * A customer group once received 30+ copies of the same roster post from
 * duplicate processes (2026-07-19); two drivers writing at once is the
 * same failure with a nicer origin story. Exactly one writer, always.
 *
 * `src/index.ts` is untouched and remains the only thing systemd runs.
 *
 * ── The decisions are not in this file ──────────────────────────────
 * Everything that can be decided without a socket lives in the modules
 * beside this one and is unit-tested there: `jid.ts`, `inbound.ts`,
 * `connection.ts`, `logging.ts`, `config.ts`, `dedupe.ts`. This file is
 * wiring, and `main.source.test.ts` pins the wiring rules that only show
 * up in its source text.
 *
 * ── Two rules, never broken ─────────────────────────────────────────
 * We never call `logout()` and we never delete the auth folder. `logout()`
 * unlinks the device; deleting the folder destroys the Signal keys. Either
 * costs a re-pair, which needs a human with the phone in hand. The source
 * test asserts both.
 *
 * ── The measurement this build exists to take ───────────────────────
 * Every `messages.upsert` logs its `type` (`notify` or `append`). Whether
 * messages that arrived while the process was down come back on reconnect,
 * and with which type, is the open question in the plan (§2.15) and it
 * decides whether `recoverGroupMessages`'s two-hour replay can be retired
 * or has to be rebuilt. HomeTenant cannot answer it: its bot drops
 * everything that is not `notify`. So nothing is dropped here on `type`.
 */
import makeWASocket, {
  makeCacheableSignalKeyStore,
  // Aliased on purpose. The repo's eslint config runs the React plugin
  // across everything, and `rules-of-hooks` treats ANY `useX()` call as a
  // React hook, so importing this under its own name fails the lint with
  // "called in function main that is neither a React component nor a
  // custom Hook". It is a Baileys function that loads Signal keys off
  // disk, and there is no React within a mile of this file.
  useMultiFileAuthState as loadMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "baileys";
import qrcode from "qrcode-terminal";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { acquireInstanceLock } from "../instance-lock.js";
import {
  decidePairingAction,
  describeBaileysConfig,
  pairingCodeBanner,
  resolveBaileysConfig,
} from "./config.js";
import { decideOnClose } from "./connection.js";
import { createSeenIds } from "./dedupe.js";
import { mapInboundMessage } from "./inbound.js";
import { inboundDropReason, resolveInboundSender } from "./jid.js";
import { makeBaileysLogger } from "./logging.js";

const BOT_DIR = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Its OWN lock, not the live bot's.
 *
 * `instance-lock.ts` defaults to `/tmp/matchtime-bot.pid`, which the
 * running whatsapp-web.js bot holds. Sharing it would either refuse to
 * start beside the live bot (wrong: the whole point is to run beside it)
 * or, worse, make each look like the other's duplicate. A second path
 * gives this process the same protection against a second copy of ITSELF
 * without touching the first.
 */
const LOCK_PATH = process.env.MT_BAILEYS_LOCK_PATH ?? "/tmp/matchtime-baileys.pid";

async function main(): Promise<void> {
  const lock = acquireInstanceLock({ path: LOCK_PATH });
  if (!lock.acquired) {
    console.error(
      `CRITICAL: another Baileys observer is already running (pid ${lock.holderPid}). ` +
        `Two sockets on one auth folder evict each other in a 440 loop and churn creds.json.`,
    );
    process.exit(lock.exitCode);
  }

  const config = resolveBaileysConfig(process.env, BOT_DIR);
  console.log(describeBaileysConfig(config));

  // 0700: this directory is the whole session.
  await mkdir(config.authDir, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await loadMultiFileAuthState(config.authDir);
  const logger = makeBaileysLogger(config.logLevel);
  // An LRU in front of the multi-file store: without it every Signal
  // operation is a directory read on an SD card.
  const keys = makeCacheableSignalKeyStore(state.keys, logger);

  console.log(
    `Baileys auth: ${state.creds.registered ? "paired" : "NOT PAIRED YET, link the device below"}`,
  );

  const firstSighting = createSeenIds();

  let sock: WASocket | null = null;
  // Every reconnect builds a new socket, and the OLD one's handlers keep
  // firing. Without this guard a stale socket's `close` schedules another
  // connect and the process quietly ends up with several.
  let generation = 0;
  let failures = 0;

  function connect(): void {
    const gen = ++generation;
    let codeRequested = false;

    const s = makeWASocket({
      auth: { creds: state.creds, keys },
      logger,
      // Default is TRUE, and leaving it there makes WhatsApp believe a
      // device is in the foreground, so the bot's phone stops getting
      // push notifications.
      markOnlineOnConnect: false,
      // Default is also TRUE. A full history sync on a fresh pair pulls a
      // large payload onto a Raspberry Pi. Phase 1 wants none of it; the
      // question of whether we need some of it is Phase 5's (see header).
      syncFullHistory: false,
    });
    sock = s;

    s.ev.on("creds.update", () => void saveCreds());

    s.ev.on("connection.update", async (update) => {
      if (gen !== generation) return; // a stale socket talking
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const action = decidePairingAction({ pairPhone: config.pairPhone, codeRequested });
        if (action === "request-code") {
          // Once per socket. A loop here hammers WhatsApp's pairing
          // endpoint from one number and risks the number itself.
          codeRequested = true;
          try {
            const code = await s.requestPairingCode(config.pairPhone);
            console.log(pairingCodeBanner(config.pairPhone, code));
          } catch (err) {
            console.error("requestPairingCode failed, falling back to the QR:", err);
            qrcode.generate(qr, { small: true });
          }
        } else if (action === "show-qr") {
          console.log("\nScan this QR code with the MatchTime WhatsApp number:\n");
          qrcode.generate(qr, { small: true });
        }
      }

      if (connection === "open") {
        failures = 0;
        console.log(
          `\n[baileys] connected as ${s.user?.id ?? "?"} (lid ${s.user?.lid ?? "none"}). ` +
            `Observing only: nothing will be sent.\n`,
        );
      }

      if (connection === "close") {
        const status = (
          lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode;
        const decision = decideOnClose(status, failures);
        if (decision.action === "exit") {
          console.error(`[baileys] disconnected: ${decision.reason}`);
          process.exit(decision.code);
        }
        failures++;
        console.error(
          `[baileys] connection closed (status ${status ?? "unknown"}), ` +
            `reconnecting in ${decision.delayMs}ms (attempt ${failures})`,
        );
        setTimeout(() => {
          if (gen === generation) connect();
        }, decision.delayMs);
      }
    });

    s.ev.on("messages.upsert", ({ messages, type }) => {
      // Nothing is dropped on `type`. Which type a message that arrived
      // while we were down comes back as is the measurement this build
      // exists to take; see the file header.
      for (const m of messages) {
        void observe(s, m, type).catch((err) =>
          console.error("[baileys] observe failed:", err instanceof Error ? err.message : err),
        );
      }
    });
  }

  /**
   * Log one inbound message in the same shape `index.ts`'s `[msg]` line
   * uses, so a shadow run can be diffed against the live bot line for line.
   */
  async function observe(s: WASocket, msg: WAMessage, upsertType: string): Promise<void> {
    const drop = inboundDropReason(msg.key);
    if (drop) return;

    const mapped = mapInboundMessage(msg);
    if (!mapped) return;

    if (!firstSighting(mapped.id)) {
      console.log(`[baileys][msg] duplicate delivery of ${mapped.id} ignored`);
      return;
    }

    // A local store read. It has NO network fallback in Baileys and is not
    // a directory lookup: about 100 such lookups from a production account
    // got every linked device on HomeTenant's number unlinked on
    // 2026-09-17. Nothing in this file may ever ask WhatsApp about a number.
    const who = await resolveInboundSender(msg.key, (lid) =>
      s.signalRepository.lidMapping.getPNForLID(lid),
    );

    console.log(
      `[baileys][msg] upsert=${upsertType} chat=${mapped.chatJid} group=${mapped.isGroup} ` +
        `sender=${mapped.senderJid ?? "?"} phone=${who.phone ?? "?"}` +
        `${who.phone ? `(${who.source})` : ""} name=${mapped.pushName ?? "?"} ` +
        `type=${mapped.type} bodyLen=${mapped.body.length} media=${mapped.hasMedia} ` +
        `mentions=${mapped.mentionedJids.length} ts=${mapped.timestampSec} id=${mapped.id}`,
    );

    // `=== null` and not `!who.phone`: the resolved branch is typed
    // `phone: string`, which TypeScript cannot exclude on falsiness
    // because "" is a string. The explicit null is what narrows the union.
    if (who.phone === null) {
      // Said out loud rather than swallowed: under whatsapp-web.js an
      // unidentifiable sender reached the server, resolved to nobody, and
      // returned HTTP 200 while recording no attendance. Phase 4 adds the
      // group-participant path that should close most of this.
      console.warn(
        `[baileys][msg] sender UNRESOLVED for ${mapped.id}: ${who.reason}` +
          `${who.lid ? ` (lid ${who.lid})` : ""}`,
      );
    }
  }

  const shutdown = (signal: string): void => {
    // end(), never logout(). logout() unlinks the device and costs a
    // re-pair that needs a human with the phone.
    console.log(`\n${signal} received, closing the socket. The session is kept.`);
    try {
      sock?.end(undefined);
    } catch {
      /* already closed */
    }
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  connect();
}

main().catch((err) => {
  console.error("[baileys] failed to start:", err);
  process.exit(1);
});
