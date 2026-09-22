/**
 * The pre-cutover phone gate, run against a REAL WhatsApp connection.
 *
 *   cd ~/matchtime-bot/whatsapp-bot
 *   node --env-file=.env --import tsx scripts/measure-group-phones.ts \
 *     --group=<group JID> --known-phones=<file>
 *
 * Connects with the Baileys session in BAILEYS_AUTH_DIR (the same one the
 * Phase 1 observer and the Baileys driver use; pair it first if it is not
 * paired, it will show a QR or a pairing code exactly as they do), waits
 * for the line to open, reads the group ONCE with `groupMetadata`, prints
 * the report from `src/baileys/phone-gate.ts`, ends the socket and exits.
 *
 * `--known-phones` is a text file of the org's phones, one per line, E.164
 * digits (a leading `+`, spaces or a `,name` after it are fine). Export it
 * with a READ-ONLY query of the org's members; this script never touches
 * the database itself.
 *
 * What it will not do, pinned by `drivers/baileys.source.test.ts`: send a
 * message, write a LID mapping, call the MatchTime API or the database,
 * list groups, or make any directory lookup. It also takes the Baileys
 * process lock, so it cannot run beside the Baileys observer or a
 * Baileys-driven bot on the same session (two sockets on one auth folder
 * evict each other in a 440 loop). Running it beside the live
 * whatsapp-web.js bot is safe: that is a different linked device, and this
 * one never sends. Baileys will still acknowledge what it receives while
 * connected, which is protocol, not a message.
 *
 * Exit codes: 0 report printed, 1 bad arguments or the group read failed,
 * 2 the line never opened.
 */
import makeWASocket, {
  makeCacheableSignalKeyStore,
  useMultiFileAuthState as loadMultiFileAuthState,
} from "baileys";
import qrcode from "qrcode-terminal";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireInstanceLock } from "../src/instance-lock.js";
import { resolveBaileysConfig } from "../src/baileys/config.js";
import { makeBaileysLogger } from "../src/baileys/logging.js";
import { createBaileysConnection, type LifecycleSocket } from "../src/baileys/lifecycle.js";
import { createSessionLedger, fileLedgerIO } from "../src/baileys/session-ledger.js";
import { formatPhoneGateReport, parseKnownPhones, runPhoneGate, type PhoneGateSocket } from "../src/baileys/phone-gate.js";

const BOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const OPEN_TIMEOUT_MS = 5 * 60 * 1000;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main(): Promise<void> {
  const group = arg("group");
  if (!group || !group.endsWith("@g.us")) {
    console.error("Usage: measure-group-phones.ts --group=<id>@g.us [--known-phones=<file>]");
    process.exit(1);
  }
  const knownFile = arg("known-phones");
  const knownPhones = knownFile ? parseKnownPhones(await readFile(knownFile, "utf8")) : [];

  const lock = acquireInstanceLock({ path: process.env.MT_BAILEYS_LOCK_PATH ?? "/tmp/matchtime-baileys.pid" });
  if (!lock.acquired) {
    console.error(`Another Baileys process holds this session (pid ${lock.holderPid}). Stop it first.`);
    process.exit(1);
  }

  const config = resolveBaileysConfig(process.env, BOT_DIR);
  const logger = makeBaileysLogger(config.logLevel);
  await mkdir(config.authDir, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await loadMultiFileAuthState(config.authDir);
  const keys = makeCacheableSignalKeyStore(state.keys, logger);

  const connection = createBaileysConnection<LifecycleSocket & PhoneGateSocket>({
    makeSocket: () => {
      const sock = makeWASocket({
        auth: { creds: state.creds, keys },
        logger,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        getMessage: async () => undefined,
      });
      sock.ev.on("creds.update", () => void saveCreds());
      return sock as unknown as LifecycleSocket & PhoneGateSocket;
    },
    pairPhone: config.pairPhone,
    ledger: createSessionLedger(fileLedgerIO(join(config.authDir, "matchtime-session-ledger.json"))),
    printQr: (qr) => qrcode.generate(qr, { small: true }),
  });

  const timer = setTimeout(() => {
    console.error(`The line did not open within ${OPEN_TIMEOUT_MS / 1000}s. Nothing was measured.`);
    void connection.close().finally(() => process.exit(2));
  }, OPEN_TIMEOUT_MS);

  let measured = false;
  connection.onOpen(async () => {
    if (measured) return; // one read, however many times the line opens
    measured = true;
    clearTimeout(timer);
    let code = 0;
    try {
      const sock = connection.openSocket();
      if (!sock) throw new Error("the socket closed before the group could be read");
      const summary = await runPhoneGate(sock, { groupJid: group, knownPhones });
      process.stdout.write(formatPhoneGateReport(summary));
    } catch (err) {
      console.error(`The group read failed, so there is no verdict: ${err instanceof Error ? err.message : String(err)}`);
      code = 1;
    }
    // end(), never logout(): logout would unlink the device.
    await connection.close();
    process.exit(code);
  });

  await connection.start();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
