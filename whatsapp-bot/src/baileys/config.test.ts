import { describe, it, expect } from "vitest";
import { resolveBaileysConfig, describeBaileysConfig, normalisePairPhone, decidePairingAction, pairingCodeBanner } from "./config.js";

describe("resolveBaileysConfig", () => {
  it("defaults the auth directory to .baileys_auth under the bot directory", () => {
    const c = resolveBaileysConfig({}, "/home/pi/matchtime-bot/whatsapp-bot");
    expect(c.authDir).toBe("/home/pi/matchtime-bot/whatsapp-bot/.baileys_auth");
  });

  it("lets BAILEYS_AUTH_DIR override it, absolutely", () => {
    const c = resolveBaileysConfig({ BAILEYS_AUTH_DIR: "/mnt/ssd/wa" }, "/anywhere");
    expect(c.authDir).toBe("/mnt/ssd/wa");
  });

  it("resolves a relative override against the bot directory", () => {
    const c = resolveBaileysConfig({ BAILEYS_AUTH_DIR: "sessions/a" }, "/home/pi/bot");
    expect(c.authDir).toBe("/home/pi/bot/sessions/a");
  });

  it("treats a blank env var as unset, because a blank line in .env is not a choice", () => {
    const c = resolveBaileysConfig({ BAILEYS_AUTH_DIR: "   " }, "/home/pi/bot");
    expect(c.authDir).toBe("/home/pi/bot/.baileys_auth");
  });

  it("defaults the Baileys log level to warn, because the library is very chatty", () => {
    expect(resolveBaileysConfig({}, "/x").logLevel).toBe("warn");
    expect(resolveBaileysConfig({ WA_BAILEYS_LOG_LEVEL: " DEBUG " }, "/x").logLevel).toBe("debug");
  });

  it("falls back to warn for a level nobody recognises", () => {
    expect(resolveBaileysConfig({ WA_BAILEYS_LOG_LEVEL: "shouty" }, "/x").logLevel).toBe("warn");
  });

  it("is observe-only in this phase, and says so in the type", () => {
    // Phase 1 has no sends, no scheduler and no server calls. The flag
    // exists so the guard is a value someone can read, not a comment.
    expect(resolveBaileysConfig({}, "/x").observeOnly).toBe(true);
  });

  it("describes itself in one line for the startup log", () => {
    const line = describeBaileysConfig(resolveBaileysConfig({}, "/home/pi/bot"));
    expect(line).toMatch(/\.baileys_auth/);
    expect(line).toMatch(/observe-only/i);
  });
});

describe("normalisePairPhone", () => {
  it("keeps digits only, so a pasted +44 7700 900123 works", () => {
    expect(normalisePairPhone("+44 7700 900123")).toBe("447700900123");
  });

  it("returns an empty string for nothing", () => {
    expect(normalisePairPhone(undefined)).toBe("");
    expect(normalisePairPhone("   ")).toBe("");
  });

  it("refuses something that is not a plausible number rather than calling WhatsApp with it", () => {
    // A crash loop calling requestPairingCode hammers WhatsApp's pairing
    // endpoint from one number, and losing the number is far worse than
    // being down for an hour.
    expect(normalisePairPhone("12")).toBe("");
  });
});

describe("decidePairingAction", () => {
  it("shows a QR when no pair phone is configured", () => {
    expect(decidePairingAction({ pairPhone: "", codeRequested: false })).toBe("show-qr");
  });

  it("requests a code once when a pair phone is configured", () => {
    expect(decidePairingAction({ pairPhone: "447700900123", codeRequested: false })).toBe(
      "request-code",
    );
  });

  it("does NOTHING on a repeat, so one socket asks WhatsApp exactly once", () => {
    expect(decidePairingAction({ pairPhone: "447700900123", codeRequested: true })).toBe("none");
  });
});

describe("pairingCodeBanner", () => {
  it("prints the code somewhere a human scanning a journal will see it", () => {
    const b = pairingCodeBanner("447700900123", "ABCD1234");
    expect(b).toMatch(/ABCD1234/);
    expect(b).toMatch(/447700900123/);
  });
});
