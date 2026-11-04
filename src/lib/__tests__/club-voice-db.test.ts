/**
 * The one rule's I/O half (club summary B6): the DM door's third rail, and
 * the row fallback every door without summary facts reads. db is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ membership: { findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { dmClubsSilence } from "../club-voice-db";
import { clubVoice, voiceFactsOfRow } from "../club-voice";

const ON = { approvalStatus: "approved", setupStage: "live", dormantAt: null, billingStatus: "exempt", whatsappBotEnabled: true };
const MUTED = { ...ON, whatsappBotEnabled: false };
const DORMANT = { ...ON, dormantAt: new Date("2026-10-01T00:00:00Z") };
const PENDING = { ...ON, approvalStatus: "pending", whatsappBotEnabled: false };

const clubs = (...orgs: Array<Record<string, unknown>>) => dbMock.membership.findMany.mockResolvedValue(orgs.map((org) => ({ org })));

beforeEach(() => vi.clearAllMocks());

describe("dmClubsSilence: is every one of the sender's clubs one MatchTime does not speak for?", () => {
  it("no club at all (a pool player): carry on", async () => {
    clubs();
    expect(await dmClubsSilence("u1")).toBeNull();
  });
  it("one club that speaks among silent ones: carry on (he is handled for that club)", async () => {
    clubs(DORMANT, ON, MUTED);
    expect(await dmClubsSilence("u1")).toBeNull();
  });
  it("muted only, or muted and dormant: club-muted", async () => {
    clubs(MUTED);
    expect(await dmClubsSilence("u1")).toBe("club-muted");
    clubs(DORMANT, MUTED);
    expect(await dmClubsSilence("u1")).toBe("club-muted");
  });
  it("dormant only: club-dormant", async () => {
    clubs(DORMANT, DORMANT);
    expect(await dmClubsSilence("u1")).toBe("club-dormant");
  });
  it("dormant and waiting for approval: club-not-served", async () => {
    clubs(DORMANT, PENDING);
    expect(await dmClubsSilence("u1")).toBe("club-not-served");
  });
  it("reads only his current memberships, with the rule's columns", async () => {
    clubs(ON);
    await dmClubsSilence("u1");
    expect(dbMock.membership.findMany.mock.calls[0][0].where).toEqual({ userId: "u1", leftAt: null });
  });
});

describe("voiceFactsOfRow: a row read without a column is never silenced by it", () => {
  it("an empty row: approved, not setting up, awake, not paused; muted (held, never dropped)", () => {
    expect(voiceFactsOfRow({})).toEqual({ approved: true, settingUp: false, dormant: false, billingPaused: false, botOn: false });
    expect(clubVoice(voiceFactsOfRow({})).state).toBe("muted");
  });
  it("the stored columns, as the summary's lifecycle facts read them", () => {
    expect(clubVoice(voiceFactsOfRow(ON))).toEqual({ state: "on" });
    expect(clubVoice(voiceFactsOfRow(DORMANT))).toEqual({ state: "silent", because: "dormant" });
    expect(clubVoice(voiceFactsOfRow(PENDING))).toEqual({ state: "silent", because: "not-approved" });
    expect(clubVoice(voiceFactsOfRow({ ...ON, setupStage: "setting-up", whatsappBotEnabled: false }))).toEqual({ state: "silent", because: "setting-up" });
  });
});
