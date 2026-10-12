/**
 * `loadHelloInput`: the one read behind the settings-aware group hello
 * (go-live slice S2, 2026-10-12). The database is a double; no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn() },
  clubConnect: { findFirst: vi.fn() },
  membership: { findFirst: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { loadHelloInput, type HelloReadClient } from "../group-hello-load";
import { DEFAULT_HELLO_SETTINGS, HELLO_ORG_SELECT, buildGroupHello, type HelloOrgRow } from "../group-hello";
import { en } from "../i18n/strings.en";
import { tr } from "../i18n/strings.tr";

const ROW: HelloOrgRow = {
  language: "en",
  squadMode: "weekly",
  featureAttendance: true,
  featureBench: true,
  featureTeamBalancing: true,
  featureMomVoting: true,
  featurePlayerRating: true,
  featureReminders: true,
  featureStatsQa: true,
  featureSquadFromList: false,
  rollingSquadEnabled: false,
  benchPickMode: "first-come",
  dropOutDeadlineDay: null,
  dropOutDeadlineTime: null,
  listPublishDay: null,
  listPublishTime: null,
  paymentTrackingEnabled: false,
  paymentCollectionEnabled: false,
  stripeConnectAccountId: null,
  stripeChargesEnabled: false,
  payMethodCard: true,
  payMethodPayByBank: true,
};

beforeEach(() => {
  for (const m of [dbMock.organisation.findUnique, dbMock.clubConnect.findFirst, dbMock.membership.findFirst, dbMock.user.findUnique]) {
    m.mockReset();
  }
  dbMock.organisation.findUnique.mockResolvedValue(ROW);
  dbMock.clubConnect.findFirst.mockResolvedValue({ userId: "u-connect" });
  dbMock.membership.findFirst.mockResolvedValue({ userId: "u-owner" });
  dbMock.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    name: where.id === "u-connect" ? "Ali Veli" : where.id === "u-owner" ? "Olivia Owner" : "Given Person",
  }));
});

describe("loadHelloInput", () => {
  it("reads the hello's columns and names the person who connected the club", async () => {
    const input = await loadHelloInput("org-1");
    expect(dbMock.organisation.findUnique).toHaveBeenCalledWith({ where: { id: "org-1" }, select: HELLO_ORG_SELECT });
    expect(input).toEqual({ organiser: "Ali", lang: "en", settings: DEFAULT_HELLO_SETTINGS });
    expect(dbMock.membership.findFirst).not.toHaveBeenCalled();
    expect(buildGroupHello({ ...input, catchUp: false })).toBe(en.sj_group_hello({ organiser: "Ali" }));
  });

  it("falls back to the club's owner when no connect link exists", async () => {
    dbMock.clubConnect.findFirst.mockResolvedValue(null);
    expect((await loadHelloInput("org-1")).organiser).toBe("Olivia");
  });

  it("uses the organiser it is given, with no lookup", async () => {
    expect((await loadHelloInput("org-1", { organiserUserId: "u-given" })).organiser).toBe("Given");
    expect(dbMock.clubConnect.findFirst).not.toHaveBeenCalled();
    expect(dbMock.membership.findFirst).not.toHaveBeenCalled();
  });

  it("no organiser at all, or one with no name, is the hello's nameless wording", async () => {
    dbMock.clubConnect.findFirst.mockResolvedValue(null);
    dbMock.membership.findFirst.mockResolvedValue(null);
    const input = await loadHelloInput("org-1");
    expect(input.organiser).toBeNull();
    expect(dbMock.user.findUnique).not.toHaveBeenCalled();
    expect(buildGroupHello({ ...input, catchUp: false })).toBe(en.sj_group_hello({ organiser: null }));

    dbMock.clubConnect.findFirst.mockResolvedValue({ userId: "u-x" });
    dbMock.user.findUnique.mockResolvedValue({ name: null });
    expect((await loadHelloInput("org-1")).organiser).toBeNull();
  });

  it("a Turkish rolling squad club is greeted in Turkish, from its own settings", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({
      ...ROW,
      language: "tr",
      rollingSquadEnabled: true,
      dropOutDeadlineDay: 1,
      dropOutDeadlineTime: "21:00",
    });
    const out = buildGroupHello(await loadHelloInput("org-1"));
    expect(out).toContain(tr.sj_hello_rolling({ deadline: "Pazartesi 21:00" }));
    expect(out).not.toContain(tr.sj_hello_whos_in);
    expect(out).not.toContain(tr.sj_hello_catch_up);
  });

  it("throws for a club that does not exist, so no hello is ever built from nothing", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(null);
    await expect(loadHelloInput("org-missing")).rejects.toThrow(/org-missing/);
  });

  it("reads through the client it is handed (a transaction), not the shared one", async () => {
    const tx = {
      organisation: { findUnique: vi.fn(async () => ({ ...ROW, rollingSquadEnabled: true })) },
      clubConnect: { findFirst: vi.fn(async () => ({ userId: "u-tx" })) },
      membership: { findFirst: vi.fn(async () => null) },
      user: { findUnique: vi.fn(async () => ({ name: "Tamsin Xu" })) },
    };
    const input = await loadHelloInput("org-1", { client: tx as unknown as HelloReadClient });
    expect(input.organiser).toBe("Tamsin");
    expect(input.settings.rollingSquad).toBe(true);
    expect(dbMock.organisation.findUnique).not.toHaveBeenCalled();
  });
});
