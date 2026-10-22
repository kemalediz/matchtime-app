/**
 * Partner clubs, the writer (cross-club ask, slice S1).
 * `src/lib/club-partnership.ts`: a club's organiser accepts, pauses, resumes or removes
 * with a compare-and-set; the partner side alone sets its approval; the
 * asking side's settings are checked and saved together.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn(), update: vi.fn() },
  clubPartnership: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
const noticeMock = vi.hoisted(() => ({ sendAdminNotice: vi.fn() }));
vi.mock("../admin-channel", () => noticeMock);
const hqLogMock = vi.hoisted(() => ({ recordMatchTimeQuestion: vi.fn() }));
vi.mock("../admin-group-log", () => hqLogMock);

import {
  actOnPartnership,
  loadPartnershipsForOrg,
  savePartnerAskSettings,
  setPartnerApproval,
} from "../club-partnership";

const NOW = new Date("2026-10-16T12:00:00Z");
const FNF = { id: "fnf", name: "FNF", language: "en" };
const SUTTON = { id: "sutton", name: "Sutton FC", language: "tr" };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id === "fnf" ? FNF : where.id === "sutton" ? SUTTON : null),
  );
  dbMock.clubPartnership.findUnique.mockResolvedValue(null);
  dbMock.clubPartnership.create.mockResolvedValue({ id: "p1" });
  dbMock.clubPartnership.updateMany.mockResolvedValue({ count: 1 });
  noticeMock.sendAdminNotice.mockResolvedValue({ channel: "dm", queued: 1 });
});

describe("actOnPartnership", () => {
  const row = { id: "p1", askerOrgId: "fnf", partnerOrgId: "sutton", status: "proposed", askerAcceptedAt: NOW, partnerAcceptedAt: null, pausedByOrgId: null };

  it("the second owner's acceptance activates it, with a compare-and-set on what was read", async () => {
    dbMock.clubPartnership.findUnique.mockResolvedValue(row);
    const r = await actOnPartnership({ partnershipId: "p1", orgId: "sutton", userId: "u2", role: "OWNER", action: "accept", now: NOW });
    expect(r).toEqual({ ok: true, status: "active" });
    expect(dbMock.clubPartnership.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", status: "proposed", askerAcceptedAt: NOW, partnerAcceptedAt: null },
      data: { partnerAcceptedAt: NOW, partnerAcceptedBy: "u2", status: "active" },
    });
  });

  it("someone else changed it first: nothing written, refused as changed", async () => {
    dbMock.clubPartnership.findUnique.mockResolvedValue(row);
    dbMock.clubPartnership.updateMany.mockResolvedValue({ count: 0 });
    expect(await actOnPartnership({ partnershipId: "p1", orgId: "sutton", userId: "u2", role: "OWNER", action: "accept", now: NOW })).toEqual({ ok: false, refusal: "changed" });
  });

  it("a club that is not in the pairing cannot even see it", async () => {
    dbMock.clubPartnership.findUnique.mockResolvedValue(row);
    expect(await actOnPartnership({ partnershipId: "p1", orgId: "other", userId: "u", role: "OWNER", action: "pause", now: NOW })).toEqual({ ok: false, refusal: "not-found" });
    expect(dbMock.clubPartnership.updateMany).not.toHaveBeenCalled();
  });

  it("an admin accepts too (D-2); a player cannot", async () => {
    dbMock.clubPartnership.findUnique.mockResolvedValue({ ...row, askerAcceptedAt: null });
    expect(await actOnPartnership({ partnershipId: "p1", orgId: "fnf", userId: "u", role: "ADMIN", action: "accept", now: NOW })).toEqual({ ok: true, status: "proposed" });
    expect(await actOnPartnership({ partnershipId: "p1", orgId: "fnf", userId: "u", role: "PLAYER", action: "accept", now: NOW })).toEqual({ ok: false, refusal: "admin-only" });
  });
});

describe("setPartnerApproval", () => {
  it("only the partner side's row is changed", async () => {
    expect(await setPartnerApproval({ partnershipId: "p1", orgId: "sutton", value: "standing" })).toEqual({ ok: true, value: "standing" });
    expect(dbMock.clubPartnership.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", partnerOrgId: "sutton", status: { not: "ended" } },
      data: { partnerApproval: "standing" },
    });
    dbMock.clubPartnership.updateMany.mockResolvedValue({ count: 0 });
    expect(await setPartnerApproval({ partnershipId: "p1", orgId: "fnf", value: "standing" })).toEqual({ ok: false, refusal: "not-partner" });
  });
  it("a value that is not one of the two is refused before any write", async () => {
    expect(await setPartnerApproval({ partnershipId: "p1", orgId: "sutton", value: "always" })).toEqual({ ok: false, refusal: "bad-value" });
    expect(dbMock.clubPartnership.updateMany).not.toHaveBeenCalled();
  });
});

describe("savePartnerAskSettings", () => {
  beforeEach(() => {
    dbMock.organisation.findUnique.mockResolvedValue({ partnerAskWhen: "auto", partnerAskTime: "17:00", partnerAskCutoffHours: 6 });
  });

  it("saves the three settings and marks them as the organiser's", async () => {
    const r = await savePartnerAskSettings("fnf", { when: "auto", time: "17:00", cutoffHours: 6 });
    expect(r).toEqual({ ok: true, settings: { when: "auto", time: "17:00", cutoffHours: 6 } });
    expect(dbMock.organisation.update).toHaveBeenCalledWith({
      where: { id: "fnf" },
      data: {
        partnerAskWhen: "auto",
        partnerAskTime: "17:00",
        partnerAskCutoffHours: 6,
        settingsSetByOrganiser: { push: ["partnerAskWhen", "partnerAskTime", "partnerAskCutoffHours"] },
      },
    });
  });

  it("refuses a bad value and writes nothing", async () => {
    expect(await savePartnerAskSettings("fnf", { when: "auto", cutoffHours: 0 })).toEqual({ ok: false, refusal: "bad-cutoff" });
    expect(await savePartnerAskSettings("fnf", { time: "25:00" })).toEqual({ ok: false, refusal: "bad-time" });
    expect(await savePartnerAskSettings("fnf", { when: "always" })).toEqual({ ok: false, refusal: "bad-when" });
    expect(dbMock.organisation.update).not.toHaveBeenCalled();
  });
});

describe("loadPartnershipsForOrg", () => {
  it("each pairing from this club's side, without ended ones", async () => {
    dbMock.clubPartnership.findMany.mockResolvedValue([
      {
        id: "p1",
        askerOrgId: "fnf",
        partnerOrgId: "sutton",
        status: "paused",
        partnerApproval: "each-ask",
        askerAcceptedAt: NOW,
        partnerAcceptedAt: NOW,
        pausedByOrgId: "sutton",
        askerOrg: { name: "FNF" },
        partnerOrg: { name: "Sutton FC" },
      },
    ]);
    const [v] = await loadPartnershipsForOrg("fnf");
    expect(v).toMatchObject({ side: "asker", otherOrgName: "Sutton FC", status: "paused", pausedBy: "them", weAccepted: true, theyAccepted: true });
    expect(dbMock.clubPartnership.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ askerOrgId: "fnf" }, { partnerOrgId: "fnf" }],
      status: { not: "ended" },
    });
  });
});
