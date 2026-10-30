/**
 * Unit tests for the UNNAMED-GUEST NAME ASK (src/lib/guest-name-ask.ts).
 *
 * Pure logic: no DB, no LLM, no network.
 *
 * Amir posted "@Kemal Ediz my brother can play if needed" (2026-08-31) and
 * the owner had to ask for the name himself. MatchTime now asks. Since
 * 2026-10-30 ("no string parsing") whether somebody unnamed was offered is
 * the attendance extractor's reading (an IN claim with `personNamed:
 * false`); the word tests `isPlaceholderGuestName` and
 * `looksLikeUnnamedGuestOffer` are deleted. What stays here is the gate on
 * FACTS and the copy.
 */
import { describe, it, expect } from "vitest";
import { shouldAskForGuestName, renderGuestNameAsk, type GuestAskInput } from "@/lib/guest-name-ask";

// ── 4. shouldAskForGuestName ───────────────────────────────────────────

const BASE: GuestAskInput = {
  tagged: false,
  senderKnown: true,
  attendanceOn: true,
  hasActiveMatch: true,
  confirmedCount: 8,
  maxPlayers: 14,
  alreadyAsked: false,
};

const ask = (over: Partial<GuestAskInput> = {}) => shouldAskForGuestName({ ...BASE, ...over });

describe("shouldAskForGuestName — fires exactly once, only when it helps", () => {
  it("FIRES on an unnamed offer while the squad is short", () => {
    expect(ask().ask).toBe(true);
  });

  it("does NOT fire twice — one ask per player per match, whatever they say next", () => {
    expect(ask({ alreadyAsked: true }).ask).toBe(false);
    expect(ask({ alreadyAsked: true }).reason).toContain("already");
  });

  it("does NOT fire, untagged, when the squad is already FULL", () => {
    // Nothing to offer them: soliciting a name we would then have to
    // bench or refuse is worse than staying quiet.
    expect(ask({ confirmedCount: 14, maxPlayers: 14 }).ask).toBe(false);
    expect(ask({ confirmedCount: 15, maxPlayers: 14 }).ask).toBe(false);
    expect(ask({ confirmedCount: 14, maxPlayers: 14 }).reason).toContain("full");
  });

  it("DOES fire on a full squad when MatchTime was TAGGED — they asked us directly", () => {
    expect(ask({ confirmedCount: 14, maxPlayers: 14, tagged: true }).ask).toBe(true);
  });

  it("does NOT fire when the sender could not be resolved", () => {
    // No userId means no per-player dedupe key, so the ask could repeat
    // forever. Silence is the safe branch.
    expect(ask({ senderKnown: false }).ask).toBe(false);
    expect(ask({ senderKnown: false, tagged: true }).ask).toBe(false);
  });

  it("does NOT fire when the org does not track attendance", () => {
    expect(ask({ attendanceOn: false }).ask).toBe(false);
    expect(ask({ attendanceOn: false, tagged: true }).ask).toBe(false);
  });

  it("does NOT fire when there is no match to add anyone to", () => {
    expect(ask({ hasActiveMatch: false }).ask).toBe(false);
    expect(ask({ hasActiveMatch: false, tagged: true }).ask).toBe(false);
  });

  it("always reports a reason, whichever way it goes", () => {
    expect(ask().reason.length).toBeGreaterThan(0);
    expect(ask({ alreadyAsked: true }).reason.length).toBeGreaterThan(0);
  });
});

// ── 5. renderGuestNameAsk ──────────────────────────────────────────────

describe("renderGuestNameAsk — server-composed, house style", () => {
  it("is short, warm, and names the next step", () => {
    const t = renderGuestNameAsk({ askerName: "Amir Ahmadi", plural: false });
    expect(t).toBe("Nice one Amir 🙌 What's their name? Reply with it and I'll add them to the squad.");
  });

  it("works without a sender name", () => {
    const t = renderGuestNameAsk({ askerName: null, plural: false });
    expect(t).toBe("Nice one 🙌 What's their name? Reply with it and I'll add them to the squad.");
  });

  it("goes plural when more than one unnamed person was offered (a count of claims, not the words)", () => {
    const t = renderGuestNameAsk({ askerName: "Amir", plural: true });
    expect(t).toBe("Nice one Amir 🙌 What are their names? Reply with them and I'll add them to the squad.");
    expect(
      renderGuestNameAsk({ askerName: null, plural: true }),
    ).toContain("What are their names?");
  });

  it("never uses an em dash or a slash (house style)", () => {
    for (const plural of [false, true]) {
      for (const askerName of ["Amir Ahmadi", null]) {
        const t = renderGuestNameAsk({ askerName, plural });
        expect(t).not.toContain("—");
        expect(t).not.toContain("–");
        expect(t).not.toContain("/");
      }
    }
  });

  it("uses the FIRST token of the sender name only, and never a raw number", () => {
    expect(renderGuestNameAsk({ askerName: "Oscar Owner", plural: false })).toContain(
      "Nice one Oscar",
    );
    // A raw @lid / phone-number pushname must never be printed as a name.
    expect(renderGuestNameAsk({ askerName: "447700900123", plural: false })).toBe(
      "Nice one 🙌 What's their name? Reply with it and I'll add them to the squad.",
    );
  });

  it("stays under a sensible group-chat length", () => {
    expect(
      renderGuestNameAsk({ askerName: "Amir", plural: false }).length,
    ).toBeLessThan(120);
  });
});

// ── 6. The ask can never carry a write ─────────────────────────────────

describe("the ask path is READ-ONLY by construction", () => {
  it("shouldAskForGuestName returns no attendance instruction at all", () => {
    const r = ask();
    // The shape is deliberately {ask, reason} — there is nowhere for an
    // attendance write to live, so no caller can smuggle one through.
    expect(Object.keys(r).sort()).toEqual(["ask", "reason"]);
  });
});
