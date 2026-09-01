/**
 * OUT safety net — pinned against REAL production reasoning.
 *
 * Every string in the two tables below (except the ones explicitly
 * marked SYNTHETIC) was read out of the production `AnalyzedMessage`
 * table on 2026-09-01:
 *
 *   select "createdAt"::date, "authorName", action, reasoning
 *     from "AnalyzedMessage" where intent = 'replacement_request';
 *
 * That is the point of this file. A test that feeds a regex the literal
 * it was written from proves nothing — the 2026-05-26 guard passed that
 * kind of review for three months while being incapable of matching the
 * sentence its own commit message quotes. `action` in the query above is
 * `registerAttendance ?? react/reply/none`, so a row with action != 'OUT'
 * is a row where this guard actually ran in production.
 *
 * MUST NOT FIRE rows are the ones the guard evaluated for real and had
 * to decline (cover requests, third-party relays, admin chases). MUST
 * FIRE rows are drop reasonings; most are rows where the model DID emit
 * OUT itself, which is exactly the text the net has to recognise on the
 * day the model forgets the field — which is the whole failure mode.
 */
import { describe, it, expect } from "vitest";
import { outSafetyNetSignals, shouldForceSenderOut } from "../out-safety-net";

/** The 2026-05-26 Mojib/Habib incident, verbatim from production. */
const MOJIB_2026_05_26 =
  "Mojib is asking the group to find replacements for himself and Habib " +
  "(third-party). Both are definite drops. Squad goes from 14/14 to 12/14 " +
  "— short by 2. Reply includes the chase nudge with roster showing open " +
  "slots 8 and 9.";

describe("OUT safety net — the incident it was written for", () => {
  it("fires on the real 2026-05-26 Mojib reasoning", () => {
    expect(shouldForceSenderOut(MOJIB_2026_05_26)).toBe(true);
  });

  it("fires on the load-bearing sentence alone: 'Both are definite drops.'", () => {
    // f35dfe6's commit message quotes exactly this. The guard it shipped
    // could not match it: `\b(drop|out)\b` fails on the plural.
    expect(shouldForceSenderOut("Both are definite drops.")).toBe(true);
  });

  it("does not depend on a single alternative — both signals are right", () => {
    const s = outSafetyNetSignals(MOJIB_2026_05_26);
    expect(s.strongDrop).toBe(true);
    // "chase nudge" describes the REPLY the bot is composing, not the
    // sender's attendance. It used to veto this very incident.
    expect(s.notDropping).toBe(false);
  });
});

/**
 * Reasonings where the sender IS leaving. The guard must force OUT.
 */
const MUST_FIRE: ReadonlyArray<readonly [string, string]> = [
  [
    "2026-04-20 Ibrahim (injury)",
    "Ibrahim is dropping out due to injury (sore ankle) and explicitly asking the group to find a replacement. Clear replacement_request pattern.",
  ],
  [
    "2026-05-11 (definite drop, injury)",
    "Definite drop with injury, requesting replacement. This is replacement_request type (a). Squad now 12/14 — need 2 more. Include roster with two open slots.",
  ],
  [
    "2026-05-18 ba",
    "ba is dropping out (definite) and requesting cover from the bench. Matches replacement_request type (a). Emit OUT for ba. Roster shows 13/14 with ba removed and slot 14 as open. Bench-confirmation flow will DM Erdal (first bench player) asking if he can step up. Reply acknowledges the drop, states squad status, and commits to asking Erdal via DM.",
  ],
  [
    "2026-05-18 Nunu",
    "Nunu (assumed to be Nunu's confirmed slot, likely @189206211076115) is requesting to be replaced. This is a definite drop with a bench available. Emit OUT for Nunu, trigger bench-confirmation DM flow server-side (do NOT preemptively promote Erdal in reply text or registerFor). Squad drops to 13/14, show the roster with row 14 as 🥁.",
  ],
  [
    "2026-05-25 Omar",
    "Omar is dropping out and explicitly asking for someone to take his spot. This is a definite drop (type a replacement_request). Squad goes from 14/14 to 13/14, and there's one bench player (Karahan) who should be asked via in-group tag. Reply follows the mandatory format: lead acknowledges the drop, roster shows 13 confirmed + 1 open slot, and the 'Asking Karahan...' line explains the bench-confirmation flow without claiming Karahan is already in.",
  ],
  ["2026-05-26 Mojib (THE INCIDENT)", MOJIB_2026_05_26],
  [
    "2026-06-09 Ehtisham (ankle + groin)",
    "Ehtisham is requesting replacement due to injury (ankle twisted and groin). He explicitly names Najib as his replacement. This is a definite drop (type a) — registering him OUT. The bench player (Najib) will be asked to confirm via the server's in-group tag flow. Squad goes from 14/14 to 13/14 pending Najib's confirmation.",
  ],
  [
    "2026-06-09 Wasim (hurt toe)",
    "Wasim drops (hurt toe) and says Erdal will cover — this is replacement_request type (a): definite drop with named cover. Register Wasim OUT. Do NOT register Erdal IN — bench-confirmation flow handles promotion (the server tags Erdal in-group to accept). Reply follows BENCH CONFIRMATION FLOW rules: acknowledge drop, say 'Asking Erdal' (in-group tag, NOT DM — critical), show squad at 13/14 with slot 14 open (🥁).",
  ],
  [
    "2026-06-18 Ehtisham",
    "Ehtisham is dropping out and asking for a replacement — definite drop (type a). Squad goes from 14/14 to 13/14, one slot opens. The server will offer it to the bench (Adam first). Reply follows SHORT-SQUAD RESPONSE format with bench section shown.",
  ],
  [
    "2026-07-07 Kemal ('replace me')",
    "Kemal is asking for a replacement and specifically says 'replace me', which is a definite drop. registerAttendance: OUT. Squad goes from 14/14 to 13/14 (one slot open). Reply follows SHORT-SQUAD RESPONSE format with Kemal's name removed from the roster.",
  ],
  // SYNTHETIC — the audited variants of each strongDrop alternative.
  ["SYNTHETIC plural gerund", "Both are dropping out, so the squad goes to 12/14."],
  ["SYNTHETIC 'definitely dropping'", "He is definitely dropping for tonight."],
  [
    "SYNTHETIC curly apostrophe",
    "He can’t make it tonight and wants someone to take his slot.",
  ],
  [
    "SYNTHETIC 'won't be able to'",
    "He won't be able to make it tonight and is asking for cover.",
  ],
  ["SYNTHETIC 'unable to attend'", "The sender is unable to attend and wants a replacement."],
];

describe("OUT safety net — must fire (real drop reasonings)", () => {
  for (const [label, reasoning] of MUST_FIRE) {
    it(`fires: ${label}`, () => {
      expect(shouldForceSenderOut(reasoning)).toBe(true);
    });
  }
});

/**
 * Reasonings where the sender is NOT leaving — cover requests, admin
 * chases, third-party relays. Over-firing here removes a player from the
 * squad who never asked to leave, which is the worse failure.
 */
const MUST_NOT_FIRE: ReadonlyArray<readonly [string, string]> = [
  [
    "2026-04-21 Ehtisham (flavour b fallback)",
    "Tentative drop with explicit fallback. Ehtisham is asking the group to cover but will attend if nobody does. This is flavour (b) — don't flip attendance, emit a reply asking for cover.",
  ],
  [
    "2026-04-21 Ehtisham ('not definitively out')",
    "Tentative drop: Ehtisham says he'll come if no replacement found, but with low energy — classic fallback commitment. Squad is 2 short; short by 2 so reply needed. He's not definitively out, so no registerAttendance.",
  ],
  [
    "2026-04-21 Ibrahim (backstop)",
    "Ibrahim was in the Dropped list but is now saying he'll play if no substitute covers his slot — this is tentative/fallback commitment. He remains a backstop and should not be registered yet. No reply needed as squad is already at 12/14; his offer to step in is helpful but doesn't require immediate group nudge.",
  ],
  [
    "2026-05-05 Nunu (hasn't confirmed)",
    "Nunu is asking if anyone wants to cover for them (replacement_request). They mention bench explicitly. Bench is empty per Match Context, so I answer that directly and note squad is full. Tentative drop — they haven't confirmed OUT yet, so registerAttendance stays null.",
  ],
  [
    "2026-05-05 Kemal relaying Izzet (THIRD-PARTY)",
    "Kemal relays that Izzet E wants to step aside and asks if anyone can replace them. This is a third-party drop with a replacement request. Squad is currently full (14/14), so stepping down doesn't immediately leave us short — however, the intent is clearly to find cover for Izzet E. registerFor registers Izzet's drop; registerAttendance stays null (Kemal isn't registering themselves). No reply needed yet since we're still at capacity if a replacement materialises — the chat will respond with takers.",
  ],
  [
    "2026-05-12 Wasim covering for his dad (THIRD-PARTY)",
    "Wasimp is asking for cover for his dad (Najib, per the Confirmed list). This is a replacement_request — tentative drop (his dad isn't feeling well, asking if anyone can step in). registerFor drops Najib as OUT. Squad goes to 13/14 short by 1, so include SHORT-SQUAD RESPONSE with roster and ask for a replacement.",
  ],
  [
    "2026-05-28 Kemal (admin group-level chase — the false positive f35dfe6 caused)",
    "Kemal (admin) is asking the group for more players — squad is 5/14, very short. This is a replacement_request type (b) — tentative/group-level rather than a personal drop, so registerAttendance stays null. Reply includes the SHORT-SQUAD format with the roster and the format-switch suggestion (kickoff is 122.9h away, we're 9 short, and 5-a-side is available — conditions hold).",
  ],
  [
    "2026-06-09 Ehtisham (state collapse, 'registerAttendance: null')",
    "Ehtisham clarifies he'll still play if nobody is available — this is the tentative fallback clause. Since his earlier message in the same batch already registered him OUT, this follow-up gets registerAttendance: null (state collapse rule). No react/reply needed — the first message's verdict already handled the replacement request and will mention him in the Tentative line of the roster.",
  ],
  [
    "2026-06-11 Ehtisham (attendance off)",
    "attendance feature off — squad not tracked",
  ],
  [
    "2026-06-30 Burak ('registerAttendance is null')",
    "Burak is asking if anyone can replace him but states he'll still play if nobody steps in — classic tentative replacement_request. He stays committed as a backstop, so registerAttendance is null (do NOT drop him). Reply acknowledges the ask and shows the full roster, keeping him in slot 5.",
  ],
  [
    "2026-07-13 Youssef (50/50 backstop)",
    "Youssef is offering to drop if someone steps in (conditional drop: 'if anyone wants to replace me') but will still play as a backstop ('50/50'). This is tentative replacement_request type (b) — registerAttendance: null (do NOT flip him to OUT), react: 🤔, short acknowledgement reply confirming he's still in until a replacement confirms.",
  ],
  // SYNTHETIC — the adversarial direction. Each of these contains a
  // strong-drop phrase that a naive widening would swallow.
  [
    "SYNTHETIC negated: 'not a definite drop'",
    "He is asking for cover but this is not a definite drop — he will still play if nobody steps in.",
  ],
  [
    "SYNTHETIC negated: 'not definitely out'",
    "He is not definitely out; he is only chasing a replacement for later.",
  ],
  [
    "SYNTHETIC type-b cover request",
    "Classic type (b) cover request — he wants a replacement but has not confirmed he is leaving.",
  ],
  [
    "SYNTHETIC admin nudge (the dead 'admin nudging' alternative)",
    "This is an admin nudge for more players, not a personal drop; registerAttendance stays null.",
  ],
  [
    "SYNTHETIC 'just nudging' (the dead alternative)",
    "The admin is just nudging the group for more players; registerAttendance is null.",
  ],
];

describe("OUT safety net — must NOT fire (cover requests, relays, chases)", () => {
  for (const [label, reasoning] of MUST_NOT_FIRE) {
    it(`declines: ${label}`, () => {
      expect(shouldForceSenderOut(reasoning)).toBe(false);
    });
  }
});

describe("OUT safety net — degenerate input", () => {
  it("never fires on empty or missing reasoning", () => {
    expect(shouldForceSenderOut(null)).toBe(false);
    expect(shouldForceSenderOut(undefined)).toBe(false);
    expect(shouldForceSenderOut("")).toBe(false);
    expect(shouldForceSenderOut("   ")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(shouldForceSenderOut("BOTH ARE DEFINITE DROPS.")).toBe(true);
  });
});
