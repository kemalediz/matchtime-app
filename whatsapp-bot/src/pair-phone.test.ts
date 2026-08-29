import { describe, it, expect } from "vitest";
import {
  normalisePairPhone,
  resolvePairingOptions,
  formatPairingCodeBanner,
  pairingCodeLogLine,
  describePairingOptions,
  PAIRING_CODE_LOG_PREFIX,
  DEFAULT_PAIRING_INTERVAL_MS,
} from "./pair-phone.js";

describe("normalisePairPhone", () => {
  it("accepts a plain international number, digits only", () => {
    expect(normalisePairPhone("447700900123")).toEqual({
      ok: true,
      phoneNumber: "447700900123",
    });
  });

  it("strips a leading +, spaces, dashes, dots and brackets", () => {
    for (const raw of [
      "+447700900123",
      "+44 7700 900123",
      "44-7700-900123",
      " 44 (7700) 900-123 ",
      "44.7700.900123",
    ]) {
      expect(normalisePairPhone(raw)).toEqual({
        ok: true,
        phoneNumber: "447700900123",
      });
    }
  });

  it("rejects letters anywhere in the number", () => {
    const r = normalisePairPhone("44770O900123");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/digit/i);
  });

  it("rejects an interior + (only a single leading + is a separator)", () => {
    expect(normalisePairPhone("447+700900123").ok).toBe(false);
  });

  it("treats unset / empty / whitespace-only as not configured", () => {
    for (const raw of [undefined, "", "   "]) {
      const r = normalisePairPhone(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.configured).toBe(false);
    }
  });

  it("flags a malformed value as CONFIGURED but invalid, so it can be shouted about", () => {
    const r = normalisePairPhone("not-a-number");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.configured).toBe(true);
  });

  it("rejects too short (<10 digits) and too long (>15 digits)", () => {
    expect(normalisePairPhone("123456789").ok).toBe(false); // 9
    expect(normalisePairPhone("1234567890").ok).toBe(true); // 10
    expect(normalisePairPhone("123456789012345").ok).toBe(true); // 15
    expect(normalisePairPhone("1234567890123456").ok).toBe(false); // 16
  });

  it("rejects a leading 00 international prefix — WhatsApp wants the bare country code", () => {
    const r = normalisePairPhone("00447700900123");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/00/);
  });

  it("rejects a national leading 0 (07700…) — country code is required", () => {
    const r = normalisePairPhone("07700900123");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/country code/i);
  });
});

describe("resolvePairingOptions", () => {
  it("env unset → QR only, no client option, nothing to shout about", () => {
    const d = resolvePairingOptions({});
    expect(d.mode).toBe("qr");
    expect(d.clientOptions).toEqual({});
    expect(d.criticalLog).toBeUndefined();
  });

  it("env valid → pairing requested, with the wweb.js constructor option", () => {
    const d = resolvePairingOptions({ WA_PAIR_PHONE: "+44 7700 900123" });
    expect(d.mode).toBe("pairing-code");
    expect(d.clientOptions).toEqual({
      pairWithPhoneNumber: {
        phoneNumber: "447700900123",
        showNotification: true,
        intervalMs: DEFAULT_PAIRING_INTERVAL_MS,
      },
    });
    expect(d.criticalLog).toBeUndefined();
  });

  it("env invalid → QR only AND a CRITICAL log line (never crashes)", () => {
    const d = resolvePairingOptions({ WA_PAIR_PHONE: "07700900123" });
    expect(d.mode).toBe("qr");
    expect(d.clientOptions).toEqual({});
    expect(d.criticalLog).toMatch(/^CRITICAL/);
    expect(d.criticalLog).toContain("WA_PAIR_PHONE");
  });

  it("honours a configurable refresh interval via WA_PAIR_INTERVAL_SEC", () => {
    const d = resolvePairingOptions({
      WA_PAIR_PHONE: "447700900123",
      WA_PAIR_INTERVAL_SEC: "60",
    });
    expect(d.clientOptions.pairWithPhoneNumber?.intervalMs).toBe(60_000);
  });

  it("ignores a nonsense / out-of-range interval and keeps the default", () => {
    for (const bad of ["0", "-5", "abc", "", "5", "100000"]) {
      const d = resolvePairingOptions({
        WA_PAIR_PHONE: "447700900123",
        WA_PAIR_INTERVAL_SEC: bad,
      });
      expect(d.clientOptions.pairWithPhoneNumber?.intervalMs).toBe(
        DEFAULT_PAIRING_INTERVAL_MS,
      );
    }
  });

  it("lets the phone notification be suppressed with WA_PAIR_NOTIFY=0", () => {
    const d = resolvePairingOptions({
      WA_PAIR_PHONE: "447700900123",
      WA_PAIR_NOTIFY: "0",
    });
    expect(d.clientOptions.pairWithPhoneNumber?.showNotification).toBe(false);
  });

  it("never throws, whatever junk it is handed", () => {
    expect(() =>
      resolvePairingOptions({ WA_PAIR_PHONE: "💥", WA_PAIR_INTERVAL_SEC: "💥" }),
    ).not.toThrow();
  });
});

describe("pairingCodeLogLine", () => {
  it("is a single greppable line carrying the code", () => {
    const line = pairingCodeLogLine("ABCDEFGH");
    expect(line).toContain(PAIRING_CODE_LOG_PREFIX);
    expect(line).toContain("ABCD-EFGH");
    expect(line.includes("\n")).toBe(false);
  });

  it("groups an 8-character code as XXXX-XXXX (how WhatsApp shows it)", () => {
    expect(pairingCodeLogLine("ABCDEFGH")).toContain("ABCD-EFGH");
  });

  it("leaves an unexpected length alone rather than mangling it", () => {
    expect(pairingCodeLogLine("ABC123")).toContain("ABC123");
    expect(pairingCodeLogLine("ABC123")).not.toContain("-");
  });

  it("uppercases and trims whatever the library hands back", () => {
    expect(pairingCodeLogLine("  abcdefgh ")).toContain("ABCD-EFGH");
  });

  it("has a prefix distinctive enough to grep for", () => {
    expect(PAIRING_CODE_LOG_PREFIX).toBe("WA_PAIRING_CODE:");
  });
});

describe("formatPairingCodeBanner", () => {
  it("wraps the greppable line in an unmissable banner with instructions", () => {
    const banner = formatPairingCodeBanner("ABCDEFGH");
    const lines = banner.split("\n");
    expect(lines.some((l) => l.includes(PAIRING_CODE_LOG_PREFIX))).toBe(true);
    // exactly one greppable line, so the grep one-liner returns one result
    expect(lines.filter((l) => l.includes(PAIRING_CODE_LOG_PREFIX))).toHaveLength(1);
    expect(banner).toContain("====");
    expect(banner).toContain("Linked devices");
    expect(banner).toContain("Link with phone number");
  });

  it("states the expiry so nobody types a stale code", () => {
    expect(formatPairingCodeBanner("ABCDEFGH", 180_000)).toMatch(/180s|3 min/);
    expect(formatPairingCodeBanner("ABCDEFGH", 60_000)).toContain("60s");
  });
});

describe("describePairingOptions", () => {
  it("says QR-only when unconfigured", () => {
    expect(describePairingOptions(resolvePairingOptions({}))).toMatch(/QR/i);
  });

  it("names the mode and masks most of the number when pairing", () => {
    const msg = describePairingOptions(
      resolvePairingOptions({ WA_PAIR_PHONE: "447700900123" }),
    );
    expect(msg).toMatch(/pairing code/i);
    expect(msg).toContain("0123");
    expect(msg).not.toContain("447700900123");
  });
});

describe("the SSH grep one-liner", () => {
  // Regression pin: `grep 'WA_PAIRING_CODE:' bot.log | tail -1` must return
  // exactly one line per code and that line must be the newest code. Any
  // prose that carries the literal prefix (a startup one-liner, the banner's
  // own grep hint) would poison it — that bug existed and this catches it.
  it("matches exactly once per code across everything this module logs", () => {
    const decision = resolvePairingOptions({ WA_PAIR_PHONE: "447700900123" });
    const log = [
      describePairingOptions(decision),
      formatPairingCodeBanner("ABCDEFGH", decision.intervalMs),
      formatPairingCodeBanner("HGFEDCBA", decision.intervalMs),
    ].join("\n");

    const hits = log.split("\n").filter((l) => l.includes(PAIRING_CODE_LOG_PREFIX));
    expect(hits).toHaveLength(2); // one per code, none from the prose
    expect(hits[hits.length - 1]).toContain("HGFE-DCBA"); // tail -1 = newest
  });
});
