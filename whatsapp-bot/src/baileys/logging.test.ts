import { describe, it, expect } from "vitest";
import {
  MAX_LOG_LINE,
  effectiveLevel,
  formatLogLine,
  isKeyishFieldName,
  redact,
} from "./logging.js";

describe("isKeyishFieldName", () => {
  it.each([
    "keys",
    "creds",
    "session",
    "sessions",
    "registrationId",
    "advSecretKey",
    "signalIdentities",
    "preKeys",
    "appStateSyncKeys",
    "secret",
    "token",
    "password",
  ])("redacts %s", (name) => {
    expect(isKeyishFieldName(name)).toBe(true);
  });

  it("redacts anything whose name ends in key, keys, keyPair or secret", () => {
    expect(isKeyishFieldName("noiseKey")).toBe(true);
    expect(isKeyishFieldName("signedIdentityKey")).toBe(true);
    expect(isKeyishFieldName("myKeyPair")).toBe(true);
    expect(isKeyishFieldName("clientSecret")).toBe(true);
  });

  it("does NOT redact `key`, which is the message key and the useful half of a log line", () => {
    expect(isKeyishFieldName("key")).toBe(false);
    expect(isKeyishFieldName("Key")).toBe(false);
  });

  it("leaves ordinary fields alone", () => {
    expect(isKeyishFieldName("remoteJid")).toBe(false);
    expect(isKeyishFieldName("monkey")).toBe(false);
  });
});

describe("redact", () => {
  it("replaces key material with a marker, not the value", () => {
    const out = JSON.stringify(redact({ noiseKey: { private: "aaaa", public: "bbbb" } }));
    expect(out).not.toMatch(/aaaa|bbbb/);
    expect(out).toMatch(/redacted/i);
  });

  it("renders a Buffer as a byte count, never as bytes", () => {
    const out = JSON.stringify(redact({ blob: Buffer.from("hello world") }));
    expect(out).not.toMatch(/hello/);
    expect(out).toMatch(/11 bytes/);
  });

  it("renders a serialised Buffer ({type:'Buffer',data:[...]}) the same way", () => {
    const out = JSON.stringify(redact({ blob: { type: "Buffer", data: [1, 2, 3] } }));
    expect(out).toMatch(/3 bytes/);
  });

  it("keeps a message key readable, because that is what we debug with", () => {
    const out = JSON.stringify(
      redact({ key: { remoteJid: "120363@g.us", id: "3EB0", fromMe: false } }),
    );
    expect(out).toMatch(/120363@g\.us/);
    expect(out).toMatch(/3EB0/);
  });

  it("survives a cycle instead of blowing the stack", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => JSON.stringify(redact(a))).not.toThrow();
  });

  it("survives a throwing getter instead of taking the logger down with it", () => {
    const evil = {
      get boom(): string {
        throw new Error("nope");
      },
      fine: "yes",
    };
    expect(() => JSON.stringify(redact(evil))).not.toThrow();
    expect(JSON.stringify(redact(evil))).toMatch(/yes/);
  });

  it("truncates a long string rather than carrying it whole", () => {
    const out = JSON.stringify(redact({ blurb: "x".repeat(5000) }));
    expect(out.length).toBeLessThan(1000);
  });
});

describe("formatLogLine", () => {
  it("caps the whole line, because a session dump filled the Pi's SD card", () => {
    const line = formatLogLine("warn", { blurbs: Array.from({ length: 200 }, () => "y".repeat(200)) }, "noisy");
    expect(line.length).toBeLessThanOrEqual(MAX_LOG_LINE);
  });

  it("names the level and keeps the message", () => {
    const line = formatLogLine("error", { a: 1 }, "it broke");
    expect(line).toMatch(/error/);
    expect(line).toMatch(/it broke/);
  });

  it("handles a bare message with no object", () => {
    expect(formatLogLine("info", undefined, "hello")).toMatch(/hello/);
  });

  it("never leaks key material into the line", () => {
    const line = formatLogLine("warn", { creds: { noiseKey: "SUPERSECRETVALUE" } }, "reconnect");
    expect(line).not.toMatch(/SUPERSECRETVALUE/);
  });
});

describe("effectiveLevel", () => {
  it("demotes the endless app-state-sync parking warning to debug", () => {
    // Normal on a freshly linked device, repeats forever, nothing to do.
    expect(effectiveLevel("warn", "blocked on missing key from v3, parking after 5 attempts")).toBe(
      "debug",
    );
  });

  it("leaves every other warning at warn", () => {
    expect(effectiveLevel("warn", "failed to decrypt message")).toBe("warn");
  });

  it("never touches a level that is not warn", () => {
    expect(effectiveLevel("error", "blocked on missing key from v3, parking after 5 attempts")).toBe(
      "error",
    );
  });
});
