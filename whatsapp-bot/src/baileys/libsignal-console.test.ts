/**
 * libsignal (Baileys' Signal dependency) prints whole session records with
 * console.info / console.warn: "Closing session:", "Opening session:" and
 * friends, with rootKey, baseKey and chain keys as Buffers. Those lines go
 * around Baileys' logger, so its level cannot quieten them. The filter
 * replaces them with one line that carries no object.
 */
import { describe, expect, it, vi } from "vitest";
import { installLibsignalConsoleFilter, libsignalSummary } from "./libsignal-console.js";

const SESSION = {
  currentRatchet: { rootKey: Buffer.from("secret-root-key"), ephemeralKeyPair: { privKey: Buffer.alloc(32) } },
  indexInfo: { baseKey: Buffer.from("base"), remoteIdentityKey: Buffer.from("rik"), closed: -1 },
};

describe("libsignalSummary", () => {
  it("recognises libsignal's own session lines and drops the object", () => {
    expect(libsignalSummary(["Closing session:", SESSION])).toBe("[libsignal] Closing session (details suppressed)");
    expect(libsignalSummary(["Opening session:", SESSION])).toBe("[libsignal] Opening session (details suppressed)");
    expect(libsignalSummary(["Removing old closed session:", SESSION])).toBe(
      "[libsignal] Removing old closed session (details suppressed)",
    );
    expect(libsignalSummary(["Session already closed", SESSION])).toBe(
      "[libsignal] Session already closed (details suppressed)",
    );
    expect(libsignalSummary(["Session already open"])).toBe("[libsignal] Session already open (details suppressed)");
    expect(libsignalSummary(["Migrating session to:", 2])).toBe("[libsignal] Migrating session to (details suppressed)");
    expect(libsignalSummary(["Closing open session in favor of incoming prekey bundle"])).toBe(
      "[libsignal] Closing open session in favor of incoming prekey bundle (details suppressed)",
    );
  });

  it("leaves every other line alone", () => {
    expect(libsignalSummary(["[baileys][msg] upsert=notify"])).toBeNull();
    expect(libsignalSummary(["Closing session for club", 1])).toBeNull();
    expect(libsignalSummary([SESSION])).toBeNull();
    expect(libsignalSummary([])).toBeNull();
  });
});

describe("installLibsignalConsoleFilter", () => {
  it("rewrites the session lines on info, log and warn, and passes everything else through", () => {
    const info = vi.fn();
    const log = vi.fn();
    const warn = vi.fn();
    const target = { info, log, warn } as unknown as Console;
    const uninstall = installLibsignalConsoleFilter(target);
    target.info("Closing session:", SESSION);
    target.warn("Session already closed", SESSION);
    target.log("hello", 1);
    expect(info).toHaveBeenCalledWith("[libsignal] Closing session (details suppressed)");
    expect(warn).toHaveBeenCalledWith("[libsignal] Session already closed (details suppressed)");
    expect(log).toHaveBeenCalledWith("hello", 1);
    const printed = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(printed).not.toMatch(/rootKey|baseKey|privKey/);
    uninstall();
    target.info("Closing session:", SESSION);
    expect(info).toHaveBeenLastCalledWith("Closing session:", SESSION);
  });

  it("installing twice does not wrap twice", () => {
    const info = vi.fn();
    const target = { info, log: vi.fn(), warn: vi.fn() } as unknown as Console;
    installLibsignalConsoleFilter(target);
    installLibsignalConsoleFilter(target);
    target.info("Opening session:", SESSION);
    expect(info).toHaveBeenCalledTimes(1);
  });
});
