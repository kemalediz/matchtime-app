/**
 * RED-first spec for how the bot REPORTS a capability it has lost.
 *
 * ── Why this module exists ───────────────────────────────────────────
 * The 2026-08-28 outage was not caused by a lack of error handling. Every
 * broken call was already inside a try/catch that logged something. It went
 * unnoticed for three days because what it logged was
 *
 *     [sync-participants] Sutton FC failed: r
 *
 * — a line that names neither what stopped working nor what it costs the
 * customer. Nobody reading the Pi's journal could tell that it meant "real
 * players will be blocked from putting themselves IN on the web app".
 *
 * So each capability that depends on whatsapp-web.js's injected page code
 * gets ONE tested message that states three things: the RULE it serves, the
 * CONSEQUENCE of losing it, and the MITIGATION. These are pure strings so
 * the wording is pinned by tests instead of drifting per call site.
 */
import { describe, it, expect } from "vitest";
import {
  DEGRADED_CAPABILITIES,
  degradedMessage,
  type DegradedCapability,
} from "./degraded.js";

const ALL = Object.keys(DEGRADED_CAPABILITIES) as DegradedCapability[];

describe("every degraded-capability message", () => {
  it("covers the capabilities that broke in the 2026-08-28 incident", () => {
    expect(ALL).toEqual(
      expect.arrayContaining([
        "group-enumeration",
        "participant-sync",
        "message-recovery",
        "reaction-forwarding",
      ]),
    );
  });

  for (const cap of ALL) {
    describe(cap, () => {
      const msg = degradedMessage(cap, "r");

      it("is greppable as CRITICAL", () => {
        expect(msg.startsWith("CRITICAL:")).toBe(true);
      });

      it("names the capability so the log can be grepped by feature", () => {
        expect(msg).toContain(cap);
      });

      it("states the product consequence, not just the technical failure", () => {
        expect(DEGRADED_CAPABILITIES[cap].consequence.length).toBeGreaterThan(20);
        expect(msg).toContain(DEGRADED_CAPABILITIES[cap].consequence);
      });

      it("tells the reader what to do about it", () => {
        expect(msg).toContain("WA_WEB_VERSION");
      });

      it("carries the underlying cause", () => {
        expect(msg).toContain("r");
      });
    });
  }
});

describe("degradedMessage", () => {
  it("includes an optional scope (group / org) when given one", () => {
    const m = degradedMessage("participant-sync", "r", "Sutton FC (120363@g.us)");
    expect(m).toContain("Sutton FC (120363@g.us)");
  });

  it("renders an Error's message rather than [object Object]", () => {
    const m = degradedMessage("message-recovery", new Error("boom"));
    expect(m).toContain("boom");
    expect(m).not.toContain("[object Object]");
  });

  it("survives a cause that is not an Error at all", () => {
    expect(() => degradedMessage("group-enumeration", { weird: true })).not.toThrow();
    expect(degradedMessage("group-enumeration", undefined)).toContain("CRITICAL:");
  });

  it("is a single line-block, not a multi-page essay", () => {
    // Long enough to be useful, short enough that nobody scrolls past it.
    for (const cap of ALL) {
      expect(degradedMessage(cap, "r").length).toBeLessThan(900);
    }
  });
});

describe("the specific consequences we care about", () => {
  it("participant-sync names the web-app self-IN gate", () => {
    // Membership.lastSeenInGroupAt is written ONLY by
    // /api/whatsapp/sync-participants. When this sweep never runs, that
    // column goes stale and real players get blocked from the app.
    const m = degradedMessage("participant-sync", "r");
    expect(m).toContain("lastSeenInGroupAt");
    expect(m.toLowerCase()).toContain("app");
  });

  it("message-recovery names the restart gap it exists to close", () => {
    const m = degradedMessage("message-recovery", "r");
    expect(m.toLowerCase()).toContain("restart");
  });

  it("reaction-forwarding names the bench prompt", () => {
    const m = degradedMessage("reaction-forwarding", "r");
    expect(m.toLowerCase()).toContain("bench");
  });
});
