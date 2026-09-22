/**
 * The two things about a Baileys session that must survive a restart.
 *
 * 1. How often we have asked WhatsApp for a pairing code. A crash loop
 *    that asks on every start hammers the pairing endpoint from one number,
 *    and losing the number is far worse than being down for an hour
 *    (`MDs/whatsapp-outage-2026-09-16-runbook.md` §5). "Once per socket"
 *    bounds one process; only something on disk bounds the next one.
 * 2. That WhatsApp logged this device out. A `401` cannot be fixed by
 *    reconnecting, so a process that restarts and tries again anyway is a
 *    loop through systemd with a dead session.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PAIRING_MAX_PER_HOUR,
  PAIRING_MIN_GAP_MS,
  createSessionLedger,
  fileLedgerIO,
  type LedgerIO,
  type LedgerState,
} from "./session-ledger.js";

function memoryIO(initial: LedgerState | null = null): LedgerIO & { saved: LedgerState[] } {
  let state = initial;
  const saved: LedgerState[] = [];
  return {
    saved,
    load: () => (state ? structuredClone(state) : null),
    save: (s) => {
      state = structuredClone(s);
      saved.push(structuredClone(s));
    },
  };
}

function clock(start = 1_000_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("the pairing-code budget", () => {
  it("allows the first request and records it on disk", () => {
    const io = memoryIO();
    const c = clock();
    const ledger = createSessionLedger(io, c.now);
    expect(ledger.tryPairingRequest()).toEqual({ ok: true });
    expect(io.saved.at(-1)?.pairingRequestsMs).toEqual([c.now()]);
  });

  it("refuses a second request within the minimum gap", () => {
    const c = clock();
    const ledger = createSessionLedger(memoryIO(), c.now);
    ledger.tryPairingRequest();
    c.advance(PAIRING_MIN_GAP_MS - 1);
    const second = ledger.tryPairingRequest();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.retryAfterMs).toBe(1);
    c.advance(1);
    expect(ledger.tryPairingRequest().ok).toBe(true);
  });

  it(`allows at most ${PAIRING_MAX_PER_HOUR} in any hour, however they are spaced`, () => {
    const c = clock();
    const ledger = createSessionLedger(memoryIO(), c.now);
    for (let i = 0; i < PAIRING_MAX_PER_HOUR; i++) {
      expect(ledger.tryPairingRequest().ok, `request ${i + 1}`).toBe(true);
      c.advance(PAIRING_MIN_GAP_MS);
    }
    const over = ledger.tryPairingRequest();
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toMatch(/hour/);
    // The window rolls: an hour after the first, one more is allowed.
    c.advance(60 * 60_000 - PAIRING_MAX_PER_HOUR * PAIRING_MIN_GAP_MS);
    expect(ledger.tryPairingRequest().ok).toBe(true);
  });

  it("carries the count across a restart, which is the whole point", () => {
    const io = memoryIO();
    const c = clock();
    for (let i = 0; i < PAIRING_MAX_PER_HOUR; i++) {
      // A NEW ledger each time: a process that crashed and came back.
      expect(createSessionLedger(io, c.now).tryPairingRequest().ok).toBe(true);
      c.advance(PAIRING_MIN_GAP_MS);
    }
    expect(createSessionLedger(io, c.now).tryPairingRequest().ok).toBe(false);
  });

  it("still bounds the process when the ledger cannot be written", () => {
    const c = clock();
    const broken: LedgerIO = {
      load: () => null,
      save: () => {
        throw new Error("read-only filesystem");
      },
    };
    const ledger = createSessionLedger(broken, c.now);
    expect(ledger.tryPairingRequest().ok).toBe(true);
    expect(ledger.tryPairingRequest().ok).toBe(false);
  });

  it("forgets requests older than an hour, so the file cannot grow for ever", () => {
    const io = memoryIO();
    const c = clock();
    const ledger = createSessionLedger(io, c.now);
    ledger.tryPairingRequest();
    c.advance(2 * 60 * 60_000);
    ledger.tryPairingRequest();
    expect(io.saved.at(-1)?.pairingRequestsMs).toEqual([c.now()]);
  });
});

describe("the logged-out latch", () => {
  it("is clear on a fresh session", () => {
    expect(createSessionLedger(memoryIO()).loggedOut()).toBeNull();
  });

  it("records a logout and still reports it after a restart", () => {
    const io = memoryIO();
    const c = clock();
    createSessionLedger(io, c.now).recordLoggedOut(401);
    const after = createSessionLedger(io, c.now).loggedOut();
    expect(after).toEqual({ status: 401, atIso: new Date(c.now()).toISOString() });
  });

  it("keeps the pairing history when the latch is written", () => {
    const io = memoryIO();
    const ledger = createSessionLedger(io);
    ledger.tryPairingRequest();
    ledger.recordLoggedOut(401);
    expect(io.saved.at(-1)?.pairingRequestsMs).toHaveLength(1);
  });
});

describe("fileLedgerIO", () => {
  it("round-trips through a file, and a missing file is an empty ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "mt-ledger-"));
    const io = fileLedgerIO(join(dir, "ledger.json"));
    expect(io.load()).toBeNull();
    io.save({ pairingRequestsMs: [1, 2] });
    expect(io.load()).toEqual({ pairingRequestsMs: [1, 2] });
    expect(JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"))).toEqual({
      pairingRequestsMs: [1, 2],
    });
  });

  it("reads a corrupt file as empty rather than throwing at startup", () => {
    const dir = mkdtempSync(join(tmpdir(), "mt-ledger-"));
    const path = join(dir, "ledger.json");
    writeFileSync(path, "{not json");
    expect(fileLedgerIO(path).load()).toBeNull();
    // And never deletes it: the operator may want to read it.
    expect(existsSync(path)).toBe(true);
  });

  it("drops fields of the wrong type instead of trusting them", () => {
    const dir = mkdtempSync(join(tmpdir(), "mt-ledger-"));
    const path = join(dir, "ledger.json");
    writeFileSync(path, JSON.stringify({ pairingRequestsMs: ["x", 5], loggedOut: "yes" }));
    expect(fileLedgerIO(path).load()).toEqual({ pairingRequestsMs: [5] });
  });
});
