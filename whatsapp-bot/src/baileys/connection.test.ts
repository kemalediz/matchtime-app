import { describe, it, expect } from "vitest";
import { decideOnClose, MAX_RECONNECT_FAILURES, MAX_RECONNECT_DELAY_MS } from "./connection.js";

describe("decideOnClose", () => {
  it("exits on loggedOut (401) and names what the operator must do", () => {
    const d = decideOnClose(401, 0);
    expect(d.action).toBe("exit");
    expect(d.action === "exit" && d.reason).toMatch(/re-pair/i);
    expect(d.action === "exit" && d.reason).toMatch(/401/);
  });

  it("exits on connectionReplaced (440): a second process is on this session", () => {
    // A duplicate bot is the 2026-07-19 flood. Reconnecting would fight it.
    const d = decideOnClose(440, 0);
    expect(d.action).toBe("exit");
    expect(d.action === "exit" && d.reason).toMatch(/another process|duplicate/i);
  });

  it.each([403, 411, 500])("exits on the fatal status %i", (status) => {
    expect(decideOnClose(status, 0).action).toBe("exit");
  });

  it("never suggests deleting the session, on any status", () => {
    for (const s of [401, 403, 411, 440, 500, 503, 408, 428, 515, undefined]) {
      const d = decideOnClose(s, 0);
      if (d.action === "exit") expect(d.reason).not.toMatch(/delete|rm -rf|wipe/i);
    }
  });

  it("reconnects IMMEDIATELY on restartRequired (515), which is normal after pairing", () => {
    expect(decideOnClose(515, 0)).toEqual({ action: "reconnect", delayMs: 0 });
    // Still immediate a few failures in: 515 is not a failure signal.
    expect(decideOnClose(515, 3)).toEqual({ action: "reconnect", delayMs: 0 });
  });

  it("backs off exponentially on a transient close", () => {
    expect(decideOnClose(428, 0)).toEqual({ action: "reconnect", delayMs: 1000 });
    expect(decideOnClose(428, 1)).toEqual({ action: "reconnect", delayMs: 2000 });
    expect(decideOnClose(408, 3)).toEqual({ action: "reconnect", delayMs: 8000 });
  });

  it("caps the backoff so a long outage does not become an hour of silence", () => {
    const d = decideOnClose(503, 9);
    expect(d).toEqual({ action: "reconnect", delayMs: MAX_RECONNECT_DELAY_MS });
  });

  it("reconnects on an unknown or missing status rather than giving up", () => {
    expect(decideOnClose(undefined, 0).action).toBe("reconnect");
    expect(decideOnClose(9999, 0).action).toBe("reconnect");
  });

  it("exits once the failures pile up, so systemd restarts instead of flapping", () => {
    const d = decideOnClose(408, MAX_RECONNECT_FAILURES);
    expect(d.action).toBe("exit");
    expect(d.action === "exit" && d.reason).toMatch(new RegExp(String(MAX_RECONNECT_FAILURES)));
  });

  it("lets a fatal status win over the failure count, for the clearer message", () => {
    const d = decideOnClose(401, MAX_RECONNECT_FAILURES + 5);
    expect(d.action === "exit" && d.reason).toMatch(/re-pair/i);
  });
});
