/**
 * Account warnings the Baileys driver can SEE, handed to `onAccountWarning`
 * so the DM pacer drops to one a minute at once (slice L5a, 24 Oct 2026).
 *
 * Every signal here is one Baileys 7.0.0-rc14 actually emits:
 *   - `connection.update` with `reachoutTimeLock.isActive` (messages-recv.js
 *     handleReachoutTimelockNotification; socket.js fetchAccountReachoutTimelock)
 *   - `messages.update` status ERROR on our own message with the ack error
 *     463 (messages-recv.js handleBadAck: "account restricted")
 *   - a close with 401 (logged out) or 403 (forbidden). The lifecycle exits
 *     straight after a fatal close, so the warning fires BEFORE the exit.
 *   - a send that throws rate-overlimit / 429 / 463 / spam.
 */
import { describe, it, expect } from "vitest";
import { FakeSocket, manualScheduler } from "../baileys/fake-socket.js";
import { createBaileysConnection } from "../baileys/lifecycle.js";
import { createSessionLedger } from "../baileys/session-ledger.js";
import { makeBaileysDriver } from "./baileys.js";
import type { AccountWarning } from "../dm-pacing.js";

function setup() {
  const sockets: FakeSocket[] = [];
  const order: string[] = [];
  const connection = createBaileysConnection<FakeSocket>({
    makeSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    pairPhone: "",
    ledger: createSessionLedger({ load: () => null, save: () => {} }),
    printQr: () => {},
    schedule: manualScheduler().schedule,
    exit: (code) => void order.push(`exit:${code}`),
    log: () => {},
    error: () => {},
  });
  const driver = makeBaileysDriver({ connection: connection as never, log: () => {}, error: () => {} });
  const warnings: AccountWarning[] = [];
  driver.onAccountWarning!((w) => {
    warnings.push(w);
    order.push(`warning:${w.source}`);
  });
  const sock = () => sockets[sockets.length - 1];
  return { driver, sock, warnings, order };
}

async function started() {
  const t = setup();
  await t.driver.start();
  t.sock().open();
  return t;
}

describe("Baileys account warnings", () => {
  it("an active reach-out timelock is a warning; a lifted one is not", async () => {
    const t = await started();
    t.sock().emit("connection.update", { reachoutTimeLock: { isActive: false } });
    expect(t.warnings).toEqual([]);
    t.sock().emit("connection.update", {
      reachoutTimeLock: { isActive: true, enforcementType: "DEFAULT", timeEnforcementEnds: new Date() },
    });
    expect(t.warnings.map((w) => w.source)).toEqual(["baileys:reachout-timelock"]);
  });

  it("a 463 bad ack on our own message is a warning; another error, or someone else's message, is not", async () => {
    const t = await started();
    const upd = (fromMe: boolean, code: string) => ({
      key: { remoteJid: "447700900123@s.whatsapp.net", fromMe, id: "X" },
      update: { status: 0, messageStubParameters: [code] },
    });
    t.sock().emit("messages.update", [upd(true, "479"), upd(false, "463")]);
    expect(t.warnings).toEqual([]);
    t.sock().emit("messages.update", [upd(true, "463")]);
    expect(t.warnings.map((w) => w.source)).toEqual(["baileys:ack-463"]);
  });

  it("a 403 close fires the warning BEFORE the process exits", async () => {
    const t = await started();
    t.sock().closeWith(403);
    expect(t.order).toEqual(["warning:baileys:close", "exit:1"]);
  });

  it("a 401 (logged out) close is a warning; a network blip is not", async () => {
    const t = await started();
    t.sock().closeWith(428);
    expect(t.warnings).toEqual([]);
    t.sock().closeWith(401);
    expect(t.warnings.map((w) => w.detail)).toEqual([expect.stringContaining("401")]);
  });

  it("a send that throws rate-overlimit is a warning, and the error still reaches the caller", async () => {
    const t = await started();
    t.sock().sendMessage = async () => {
      throw Object.assign(new Error("rate-overlimit"), { output: { statusCode: 429 } });
    };
    await expect(t.driver.sendDirectText("447700900123", "hi")).rejects.toThrow("rate-overlimit");
    expect(t.warnings.map((w) => w.source)).toEqual(["baileys:send"]);
  });

  it("an ordinary send failure is not a warning", async () => {
    const t = await started();
    t.sock().sendMessage = async () => {
      throw new Error("not on WhatsApp");
    };
    await expect(t.driver.sendDirectText("447700900123", "hi")).rejects.toThrow();
    expect(t.warnings).toEqual([]);
  });
});
