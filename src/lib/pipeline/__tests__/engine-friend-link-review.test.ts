/**
 * Review of #488 (2026-11-01), ported from the reviewer's proofs:
 * an UNRESOLVED sender's friend keeps main's degraded outcome (R5), and a
 * profile MatchTime paused for reports or by hand is never booked, stopped
 * or not (R1b).
 */
import { describe, expect, it } from "vitest";
import { decide } from "../engine";
import { NOW, attendanceFacts, claim, msg, world } from "./helpers";
import { existingProfileOutcome } from "../../friend-link/rules";

describe("review of #488", () => {
  it("R5 an unresolved sender's 'my friend Ali is in' is degraded, as on main", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["kemal", "elvin"] }),
      messages: [
        msg({
          from: null,
          body: "my friend Ali is in",
          tagged: true,
          route: "other_att",
          facts: attendanceFacts([claim({ subject: "other", personRef: "Ali", personNamed: true, personKind: "named", polarity: "in" })]),
        }),
      ],
    });
    expect(r.outcomes[0].disposition).toBe("degraded");
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/unknown guest "Ali" offered by an unresolved sender/);
    expect(r.outcomes[0].friendLinks ?? []).toEqual([]);
  });

  it("R1b a stopped profile that still carries a reports or admin pause is not booked", () => {
    expect(existingProfileOutcome({ status: "stopped", pausedReason: "reports" })).toEqual({ book: false, reactivate: false });
    expect(existingProfileOutcome({ status: "stopped", pausedReason: "admin" })).toEqual({ book: false, reactivate: false });
  });

  it("a stopped profile paused for no-shows is booked and reactivated (the pause kept by the restart rule)", () => {
    expect(existingProfileOutcome({ status: "stopped", pausedReason: "no-shows" })).toEqual({ book: true, reactivate: true });
  });
});
