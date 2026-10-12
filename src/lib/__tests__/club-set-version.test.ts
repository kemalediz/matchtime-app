/**
 * THE CLUB SET VERSION (src/lib/club-set-version.ts): the stamp the Pi
 * compares to know that the clubs it should serve, monitor or silence have
 * changed. db is mocked; the real transitions against a real Postgres and
 * the real routes are in e2e/api/club-set-version.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ organisation: { findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("../db", () => ({ db: dbMock }));

import { clubSetVersionOf, loadClubSetVersion, type ClubSetFlags } from "../club-set-version";

const FLAGS: ClubSetFlags = { billing: false, selfJoin: true, legacySetupTrigger: false };
const sutton = {
  id: "org-sutton",
  whatsappGroupId: "sutton@g.us",
  adminGroupId: null,
  whatsappBotEnabled: true,
  billingStatus: "exempt",
  approvalStatus: "approved",
  setupStage: "live",
  setupRemovedAt: null,
};
const held = { ...sutton, id: "org-harbour", whatsappGroupId: "harbour@g.us", whatsappBotEnabled: false, setupStage: "setting-up" };

const ENV = { ...process.env };
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  process.env = { ...ENV };
});

describe("clubSetVersionOf: pure", () => {
  const base = clubSetVersionOf([sutton, held], FLAGS);

  it("is a short opaque string, the same for the same clubs", () => {
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(clubSetVersionOf([{ ...sutton }, { ...held }], { ...FLAGS })).toBe(base);
  });

  it("carries no id, group or status in the clear", () => {
    for (const secret of ["org-sutton", "sutton@g.us", "approved", "setting-up"]) expect(base).not.toContain(secret);
  });

  it.each([
    ["a club goes live (stage and bot switch)", { ...held, setupStage: "live", whatsappBotEnabled: true }],
    ["a club is suspended", { ...held, approvalStatus: "suspended" }],
    ["a club is paused for the club fee", { ...held, billingStatus: "paused" }],
    ["MatchTime is removed from a setting-up club's group", { ...held, setupRemovedAt: new Date("2026-10-13T12:00:00Z") }],
    ["an admin group is linked", { ...held, adminGroupId: "admins@g.us" }],
    ["a club's group changes", { ...held, whatsappGroupId: "other@g.us" }],
  ])("changes when %s", (_label, changed) => {
    expect(clubSetVersionOf([sutton, changed], FLAGS)).not.toBe(base);
  });

  it("changes when a club appears (an approval) or disappears", () => {
    expect(clubSetVersionOf([sutton], FLAGS)).not.toBe(base);
    expect(clubSetVersionOf([sutton, held, { ...held, id: "org-new", whatsappGroupId: "new@g.us" }], FLAGS)).not.toBe(base);
  });

  it("a live club that is muted and unmuted", () => {
    const muted = clubSetVersionOf([{ ...sutton, whatsappBotEnabled: false }, held], FLAGS);
    expect(muted).not.toBe(base);
    expect(clubSetVersionOf([{ ...sutton, whatsappBotEnabled: true }, held], FLAGS)).toBe(base);
  });

  it("re-added after a removal: back to exactly the stamp before it", () => {
    const removed = clubSetVersionOf([sutton, { ...held, setupRemovedAt: new Date() }], FLAGS);
    expect(removed).not.toBe(base);
    expect(clubSetVersionOf([sutton, { ...held, setupRemovedAt: null }], FLAGS)).toBe(base);
  });

  it("changes when a flag that decides the sets is switched (billing, self-join, the legacy trigger)", () => {
    expect(clubSetVersionOf([sutton, held], { ...FLAGS, billing: true })).not.toBe(base);
    expect(clubSetVersionOf([sutton, held], { ...FLAGS, selfJoin: false })).not.toBe(base);
    expect(clubSetVersionOf([sutton, held], { ...FLAGS, legacySetupTrigger: true })).not.toBe(base);
  });

  it("no clubs at all is still a stamp", () => {
    expect(clubSetVersionOf([], FLAGS)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("loadClubSetVersion", () => {
  it("ONE query: every club that has a group or an admin group, in a fixed order, and nothing else", async () => {
    dbMock.organisation.findMany.mockResolvedValue([sutton, held]);
    const v = await loadClubSetVersion();
    expect(dbMock.organisation.findMany).toHaveBeenCalledTimes(1);
    const args = dbMock.organisation.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ OR: [{ whatsappGroupId: { not: null } }, { adminGroupId: { not: null } }] });
    expect(args.orderBy).toEqual({ id: "asc" });
    expect(Object.keys(args.select).sort()).toEqual(
      ["adminGroupId", "approvalStatus", "billingStatus", "id", "setupRemovedAt", "setupStage", "whatsappBotEnabled", "whatsappGroupId"].sort(),
    );
    expect(v).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reads the flags from the environment, as /orgs does", async () => {
    dbMock.organisation.findMany.mockResolvedValue([sutton, held]);
    delete process.env.BILLING_ENABLED;
    const off = await loadClubSetVersion();
    process.env.BILLING_ENABLED = "1";
    expect(await loadClubSetVersion()).not.toBe(off);
  });

  it("the same clubs twice: the same stamp (the Pi then does one comparison and nothing else)", async () => {
    dbMock.organisation.findMany.mockResolvedValue([sutton, held]);
    expect(await loadClubSetVersion()).toBe(await loadClubSetVersion());
  });
});
