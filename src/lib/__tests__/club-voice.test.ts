/**
 * ONE RULE FOR "MAY MATCHTIME SEND THIS CLUB ANYTHING NOW, AND WHAT" (club
 * summary, slice B6; plan D10, D15; section 3.17).
 *
 * The pure half: `clubVoice` over the summary's lifecycle facts, and the
 * two Prisma fragments every door's query spreads, which must say exactly
 * what `clubVoice` says for every combination of the facts.
 */
import { describe, expect, it } from "vitest";
import { clubVoice, inServedClubWhere, servedClubWhere, speakingClubWhere, type ClubVoiceFacts } from "../club-voice";
import { buildClubSummary } from "../club-summary/derive";
import { NOW, SHAPES } from "../club-summary/__tests__/fixtures";

const ON: ClubVoiceFacts = { approved: true, settingUp: false, dormant: false, billingPaused: false, botOn: true };

describe("clubVoice: on, muted or silent, and why", () => {
  it("an approved, live, awake, unpaused club with its bot on speaks", () => {
    expect(clubVoice(ON)).toEqual({ state: "on" });
  });
  it("the mute switch alone: muted (served, but nothing in the players' group)", () => {
    expect(clubVoice({ ...ON, botOn: false })).toEqual({ state: "muted" });
  });
  it("dormant: silent, whatever the mute switch says", () => {
    expect(clubVoice({ ...ON, dormant: true })).toEqual({ state: "silent", because: "dormant" });
    expect(clubVoice({ ...ON, dormant: true, botOn: false })).toEqual({ state: "silent", because: "dormant" });
  });
  it("billing-paused: silent, whatever the mute switch says", () => {
    expect(clubVoice({ ...ON, billingPaused: true })).toEqual({ state: "silent", because: "billing-paused" });
  });
  it("setting up: silent (its own setup DMs are MatchTime's, on the platform channel)", () => {
    expect(clubVoice({ ...ON, settingUp: true, botOn: false })).toEqual({ state: "silent", because: "setting-up" });
  });
  it("not approved: silent, first of all reasons", () => {
    expect(clubVoice({ ...ON, approved: false, dormant: true, billingPaused: true, botOn: false })).toEqual({
      state: "silent",
      because: "not-approved",
    });
  });
  it("reads the summary's own lifecycle facts, for every club shape", () => {
    const states = Object.fromEntries(
      Object.entries(SHAPES).map(([name, rows]) => [name, clubVoice(buildClubSummary(rows, NOW).lifecycle).state]),
    );
    expect(states).toEqual({ SUTTON: "on", FNF: "on", VETS: "on", RATINGS: "on", MUTED: "muted" });
  });
});

/** A row of the five columns the fragments read, as stored. */
interface Row {
  approvalStatus: string;
  setupStage: string;
  dormantAt: Date | null;
  billingStatus: string;
  whatsappBotEnabled: boolean;
}

/** Does `row` match a flat Prisma `where` of equalities and `{ not }`? */
function matches(where: Record<string, unknown>, row: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    const cell = (row as unknown as Record<string, unknown>)[k];
    if (v && typeof v === "object" && "not" in (v as object)) return cell !== (v as { not: unknown }).not;
    return cell === v;
  });
}

function rows(): Array<{ row: Row; facts: ClubVoiceFacts }> {
  const out: Array<{ row: Row; facts: ClubVoiceFacts }> = [];
  for (const approvalStatus of ["approved", "pending", "suspended"])
    for (const setupStage of ["live", "setting-up"])
      for (const dormantAt of [null, new Date("2026-10-01T00:00:00Z")])
        for (const billingStatus of ["active", "paused"])
          for (const whatsappBotEnabled of [true, false]) {
            const approved = approvalStatus === "approved";
            out.push({
              row: { approvalStatus, setupStage, dormantAt, billingStatus, whatsappBotEnabled },
              facts: {
                approved,
                settingUp: approved && setupStage === "setting-up",
                dormant: dormantAt !== null,
                billingPaused: billingStatus === "paused",
                botOn: whatsappBotEnabled,
              },
            });
          }
  return out;
}

describe("the fragments say what clubVoice says (billing on)", () => {
  const env = { BILLING_ENABLED: "1" };
  it("speakingClubWhere matches exactly the clubs that are on", () => {
    for (const { row, facts } of rows()) {
      expect([row, matches(speakingClubWhere(env), row)]).toEqual([row, clubVoice(facts).state === "on"]);
    }
  });
  it("servedClubWhere matches exactly the clubs that are on or muted", () => {
    for (const { row, facts } of rows()) {
      expect([row, matches(servedClubWhere(env), row)]).toEqual([row, clubVoice(facts).state !== "silent"]);
    }
  });
});

describe("with BILLING_ENABLED off a paused column means nothing, as everywhere else", () => {
  it("a 'paused' row with the flag off is served", () => {
    const row: Row = { approvalStatus: "approved", setupStage: "live", dormantAt: null, billingStatus: "paused", whatsappBotEnabled: true };
    expect(matches(speakingClubWhere({}), row)).toBe(true);
  });
});

describe("the DM door's club pick (K7 b, the main session's review of #536)", () => {
  it("a membership query takes a served club, muted or not: what is served, under org", () => {
    expect(inServedClubWhere({ BILLING_ENABLED: "1" })).toEqual({ org: servedClubWhere({ BILLING_ENABLED: "1" }) });
    expect("whatsappBotEnabled" in inServedClubWhere().org).toBe(false);
  });
});
