/**
 * The Baileys connection's lifecycle, against fake sockets.
 *
 * whatsapp-web.js owned its own reconnection; Baileys hands every close
 * back to the caller. So this module is new behaviour, and each test is a
 * rule the Pi will live by: which closes reconnect, which exit, that a
 * logout never loops, that pairing codes are rationed, and that a stale
 * socket cannot speak. No socket is ever opened (see `fake-socket.ts`).
 */
import { describe, it, expect } from "vitest";
import { FakeSocket, manualScheduler } from "./fake-socket.js";
import { createBaileysConnection } from "./lifecycle.js";
import { MAX_RECONNECT_FAILURES } from "./connection.js";
import { createSessionLedger, type LedgerState } from "./session-ledger.js";

function memoryLedger(initial: LedgerState | null = null) {
  let state = initial;
  return createSessionLedger({
    load: () => (state ? structuredClone(state) : null),
    save: (s) => {
      state = structuredClone(s);
    },
  });
}

function setup(opts: { pairPhone?: string; ledger?: ReturnType<typeof memoryLedger> } = {}) {
  const sockets: FakeSocket[] = [];
  const scheduler = manualScheduler();
  const exits: number[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const qrs: string[] = [];
  const conn = createBaileysConnection<FakeSocket>({
    makeSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    pairPhone: opts.pairPhone ?? "",
    ledger: opts.ledger ?? memoryLedger(),
    printQr: (qr) => qrs.push(qr),
    schedule: scheduler.schedule,
    exit: (code) => {
      exits.push(code);
    },
    log: (l) => logs.push(l),
    error: (l) => errors.push(l),
  });
  const latest = () => sockets[sockets.length - 1];
  return { conn, sockets, latest, scheduler, exits, logs, errors, qrs };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("start", () => {
  it("makes one socket and resolves before it is open, as the contract says", async () => {
    const t = setup();
    let opened = 0;
    t.conn.onOpen(() => {
      opened++;
    });
    await t.conn.start();
    expect(t.sockets).toHaveLength(1);
    expect(opened).toBe(0);
    expect(t.conn.openSocket()).toBeNull();
    t.latest().open();
    expect(opened).toBe(1);
    expect(t.conn.openSocket()).toBe(t.latest());
  });

  it("is a no-op the second time rather than building a second socket on one auth folder", async () => {
    // Two sockets on one folder evict each other in a 440 loop.
    const t = setup();
    await t.conn.start();
    await t.conn.start();
    expect(t.sockets).toHaveLength(1);
  });

  it("rejects when the socket cannot be built, so index.ts sees it", async () => {
    const conn = createBaileysConnection({
      makeSocket: () => {
        throw new Error("auth folder unreadable");
      },
      pairPhone: "",
      ledger: memoryLedger(),
      printQr: () => {},
      exit: () => {},
      log: () => {},
      error: () => {},
    });
    await expect(conn.start()).rejects.toThrow("auth folder unreadable");
  });
});

describe("onOpen and onClose", () => {
  it("fires onOpen on EVERY open, because index.ts restarts its timers there", async () => {
    // index.ts's onClose stops the scheduler, the flush timer and the org
    // refresh; its onOpen is the only thing that starts them again. So a
    // reconnect that did not fire onOpen would leave the bot connected and
    // deaf, which looks exactly like healthy.
    const t = setup();
    let opened = 0;
    t.conn.onOpen(() => {
      opened++;
    });
    await t.conn.start();
    t.latest().open();
    t.latest().closeWith(428);
    await t.scheduler.runAll();
    expect(t.sockets).toHaveLength(2);
    t.latest().open();
    expect(opened).toBe(2);
  });

  it("fires onClose on every close with a readable reason", async () => {
    const t = setup();
    const reasons: string[] = [];
    t.conn.onClose((r) => reasons.push(r));
    await t.conn.start();
    t.latest().open();
    t.latest().closeWith(428);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/428/);
    expect(reasons[0]).toMatch(/reconnecting/);
    expect(t.conn.openSocket()).toBeNull();
  });

  it("keeps going when an onOpen handler throws or rejects", async () => {
    const t = setup();
    let second = 0;
    t.conn.onOpen(() => {
      throw new Error("handler bug");
    });
    t.conn.onOpen(async () => {
      throw new Error("async handler bug");
    });
    t.conn.onOpen(() => {
      second++;
    });
    await t.conn.start();
    t.latest().open();
    await tick();
    expect(second).toBe(1);
    expect(t.errors.join("\n")).toMatch(/handler bug/);
  });
});

describe("the reconnect policy (plan §2.8, Phase 1's decideOnClose)", () => {
  it("backs off exponentially on an ordinary close", async () => {
    const t = setup();
    await t.conn.start();
    t.latest().closeWith(428);
    expect(t.scheduler.delays()).toEqual([1000]);
    await t.scheduler.runAll();
    t.latest().closeWith(408);
    expect(t.scheduler.delays()).toEqual([2000]);
    await t.scheduler.runAll();
    expect(t.sockets).toHaveLength(3);
  });

  it("reconnects at once on 515, which WhatsApp sends straight after pairing", async () => {
    const t = setup();
    await t.conn.start();
    t.latest().closeWith(515);
    expect(t.scheduler.delays()).toEqual([0]);
  });

  it("resets the failure count once a socket actually opens", async () => {
    const t = setup();
    await t.conn.start();
    t.latest().closeWith(428);
    await t.scheduler.runAll();
    t.latest().closeWith(428);
    await t.scheduler.runAll();
    t.latest().open();
    t.latest().closeWith(428);
    expect(t.scheduler.delays()).toEqual([1000]);
  });

  it(`exits after ${MAX_RECONNECT_FAILURES} closes in a row rather than flapping for ever`, async () => {
    const t = setup();
    await t.conn.start();
    for (let i = 0; i < MAX_RECONNECT_FAILURES; i++) {
      t.latest().closeWith(428);
      await t.scheduler.runAll();
    }
    expect(t.exits).toEqual([]);
    t.latest().closeWith(428);
    expect(t.exits).toEqual([1]);
    expect(t.scheduler.delays()).toEqual([]);
  });

  it("exits on 440 (another process has this session) and does not reconnect", async () => {
    const t = setup();
    await t.conn.start();
    t.latest().open();
    t.latest().closeWith(440);
    expect(t.exits).toEqual([1]);
    expect(t.scheduler.delays()).toEqual([]);
    expect(t.errors.join("\n")).toMatch(/deploy-pi\.sh/);
  });
});

describe("a logout never loops", () => {
  it("does not reconnect on 401, exits, and latches the session as logged out", async () => {
    const ledger = memoryLedger();
    const t = setup({ ledger });
    const reasons: string[] = [];
    t.conn.onClose((r) => reasons.push(r));
    await t.conn.start();
    t.latest().open();
    t.latest().closeWith(401);
    expect(t.scheduler.delays()).toEqual([]);
    expect(t.sockets).toHaveLength(1);
    expect(t.exits).toEqual([1]);
    expect(reasons[0]).toMatch(/logged out/);
    expect(ledger.loggedOut()?.status).toBe(401);
    // And it never unlinks or deletes anything on the way out.
    expect(t.latest().loggedOut).toBe(0);
  });

  it("refuses to start at all with a latched session, without touching WhatsApp", async () => {
    // Without this, every systemd restart would open a socket on a dead
    // session, get 401, exit, and go round again.
    const ledger = memoryLedger();
    ledger.recordLoggedOut(401);
    const t = setup({ ledger });
    await expect(t.conn.start()).rejects.toThrow(/logged out/);
    expect(t.sockets).toHaveLength(0);
  });

  it("says how to recover without ever suggesting deleting the session", async () => {
    const ledger = memoryLedger();
    ledger.recordLoggedOut(401);
    const t = setup({ ledger });
    const err = (await t.conn.start().catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/aside/);
    expect(err.message).not.toMatch(/\bdelete\b|\brm\b|\bremove the\b/i);
  });
});

describe("pairing is rationed", () => {
  it("asks for a code once per socket however many QR refreshes arrive", async () => {
    const t = setup({ pairPhone: "447700900001" });
    await t.conn.start();
    t.latest().qr();
    t.latest().qr();
    t.latest().qr();
    await tick();
    expect(t.latest().pairingRequests).toEqual(["447700900001"]);
    expect(t.logs.join("\n")).toMatch(/ABCD1234/);
  });

  it("shows the QR, and never asks for a code, when no pair phone is set", async () => {
    const t = setup();
    await t.conn.start();
    t.latest().qr("ref-1");
    t.latest().qr("ref-2");
    await tick();
    expect(t.qrs).toEqual(["ref-1", "ref-2"]);
    expect(t.latest().pairingRequests).toEqual([]);
  });

  it("stops asking across reconnects once the budget is spent, and falls back to the QR", async () => {
    // The loop that matters: an unpaired socket's QR refs expire (408), we
    // reconnect, the new socket asks again. Once per socket alone would
    // allow ten codes per process and ten more per restart.
    const t = setup({ pairPhone: "447700900001" });
    await t.conn.start();
    t.latest().qr();
    await tick();
    for (let i = 0; i < 4; i++) {
      t.latest().closeWith(408);
      await t.scheduler.runAll();
      t.latest().qr();
      await tick();
    }
    const asked = t.sockets.reduce((n, s) => n + s.pairingRequests.length, 0);
    // The minimum gap alone stops the second one: all of this took no time.
    expect(asked).toBe(1);
    expect(t.qrs.length).toBeGreaterThanOrEqual(4);
    expect(t.errors.join("\n")).toMatch(/pairing code NOT requested/);
  });

  it("falls back to the QR when WhatsApp refuses the code request", async () => {
    const t = setup({ pairPhone: "447700900001" });
    await t.conn.start();
    t.latest().pairingCode = new Error("rate-overlimit");
    t.latest().qr("ref-x");
    await tick();
    expect(t.qrs).toEqual(["ref-x"]);
    expect(t.errors.join("\n")).toMatch(/rate-overlimit/);
  });
});

describe("a stale socket cannot speak", () => {
  it("ignores open and close from a socket that has been replaced", async () => {
    const t = setup();
    let opened = 0;
    const reasons: string[] = [];
    t.conn.onOpen(() => {
      opened++;
    });
    t.conn.onClose((r) => reasons.push(r));
    await t.conn.start();
    const first = t.latest();
    first.closeWith(428);
    await t.scheduler.runAll();
    // The old socket wakes up late.
    first.open();
    first.closeWith(428);
    expect(opened).toBe(0);
    expect(reasons).toHaveLength(1);
    expect(t.scheduler.delays()).toEqual([]);
  });

  it("forwards subscribed events from the current socket only, and re-attaches on reconnect", async () => {
    const t = setup();
    const seen: Array<[unknown, FakeSocket]> = [];
    t.conn.on("messages.upsert", (arg, sock) => seen.push([arg, sock]));
    await t.conn.start();
    const first = t.latest();
    first.emit("messages.upsert", { messages: [], type: "notify" });
    first.closeWith(428);
    await t.scheduler.runAll();
    const second = t.latest();
    first.emit("messages.upsert", { messages: [], type: "stale" });
    second.emit("messages.upsert", { messages: [], type: "append" });
    expect(seen.map(([a]) => (a as { type: string }).type)).toEqual(["notify", "append"]);
    expect(seen[1][1]).toBe(second);
  });

  it("attaches a subscription made after start to the socket that already exists", async () => {
    const t = setup();
    await t.conn.start();
    const seen: unknown[] = [];
    t.conn.on("messages.reaction", (arg) => seen.push(arg));
    t.latest().emit("messages.reaction", []);
    expect(seen).toHaveLength(1);
  });
});

describe("close", () => {
  it("ends the socket with end(undefined) and never logs out", async () => {
    const t = setup();
    await t.conn.start();
    t.latest().open();
    await t.conn.close();
    expect(t.latest().ended).toEqual([undefined]);
    expect(t.latest().loggedOut).toBe(0);
  });

  it("does not reconnect or exit on the close that end() itself causes", async () => {
    const t = setup();
    await t.conn.start();
    t.latest().open();
    await t.conn.close();
    t.latest().closeWith(428);
    expect(t.scheduler.delays()).toEqual([]);
    expect(t.exits).toEqual([]);
  });

  it("cancels a reconnect that was already scheduled", async () => {
    const t = setup();
    await t.conn.start();
    t.latest().closeWith(428);
    await t.conn.close();
    await t.scheduler.runAll();
    expect(t.sockets).toHaveLength(1);
  });

  it("is safe before start and safe twice", async () => {
    const t = setup();
    await expect(t.conn.close()).resolves.toBeUndefined();
    await t.conn.start();
    await t.conn.close();
    await expect(t.conn.close()).resolves.toBeUndefined();
  });
});

describe("user", () => {
  it("is the open socket's user, remembered across a reconnect gap", async () => {
    const t = setup();
    expect(t.conn.user()).toBeNull();
    await t.conn.start();
    t.latest().open();
    expect(t.conn.user()?.id).toBe("447700900001:12@s.whatsapp.net");
    t.latest().closeWith(428);
    // Between sockets the identity has not changed, and the mention check
    // on a message that was already in flight still needs it.
    expect(t.conn.user()?.lid).toBe("158000000000001:12@lid");
  });
});
