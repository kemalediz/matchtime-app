/**
 * A pasted squad list's NEW names, through the REAL resolver
 * (`resolveOrProvisionByName` -> `createProvisionalByName`), not a mock.
 * Found by the club rehearsal (2026-10-14): the preview promised "Mo" as a
 * new player and the YES then answered "I couldn't change Mo", because the
 * provisioner refused names under three letters (a guard meant for
 * truncated WhatsApp pushnames like "ba"). A name an admin pasted and
 * confirmed is deliberate. And whatever cannot be added, the preview says
 * so BEFORE the YES. db and the attendance writers are mocked. No model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  match: { findMany: vi.fn(), findUnique: vi.fn() },
  attendance: { findMany: vi.fn(), count: vi.fn() },
  membership: { findMany: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  userAlias: { findMany: vi.fn(), findUnique: vi.fn() },
  user: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  adminSquadProposal: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const att = vi.hoisted(() => ({ registerAttendance: vi.fn(), cancelAttendance: vi.fn() }));
vi.mock("@/lib/attendance", () => att);
// The count line's facts (squad-count.ts), read off the same rows.
vi.mock("@/lib/squad-count", () => ({
  loadSquadCount: async () => ({
    confirmed: rows.filter((r) => r.status === "CONFIRMED").length,
    maxPlayers: 6,
    bench: [],
    benchPickMode: null,
  }),
}));

import { answerSquadPasteYes, proposeSquadPaste } from "../admin-group-paste";

const NOW = new Date("2026-10-14T12:00:00Z");
const MATCH = { id: "m1", date: new Date("2026-10-16T19:00:00Z"), status: "UPCOMING", maxPlayers: 6 };
const people: Array<[string, string]> = [
  ["u-ann", "Ann Archer"],
  ["u-bob", "Bob Baker"],
  ["u-cal", "Cal Cooper"],
  ["u-dee", "Dee Dunn"],
];

let rows: Array<{ userId: string; status: string }>;
let created: Array<{ id: string; name: string }>;
let proposal: Record<string, unknown> | null;

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  created = [];
  proposal = null;
  dbMock.match.findMany.mockResolvedValue([MATCH]);
  dbMock.match.findUnique.mockResolvedValue(MATCH);
  dbMock.attendance.findMany.mockImplementation(async () => rows.map((r) => ({ ...r })));
  dbMock.attendance.count.mockImplementation(async () => rows.filter((r) => r.status === "CONFIRMED").length);
  // Both shapes: the proposal's (select user) and the resolver's (include user).
  dbMock.membership.findMany.mockImplementation(async () =>
    [...people, ...created.map((c) => [c.id, c.name] as [string, string])].map(([id, name]) => ({
      id: `mem-${id}`,
      userId: id,
      leftAt: null,
      user: { id, name },
    })),
  );
  dbMock.membership.upsert.mockResolvedValue({});
  dbMock.userAlias.findMany.mockResolvedValue([]);
  dbMock.userAlias.findUnique.mockResolvedValue(null);
  dbMock.user.findUnique.mockResolvedValue(null);
  dbMock.user.create.mockImplementation(async ({ data }: { data: { name: string } }) => {
    const u = { id: `new-${data.name.toLowerCase()}`, name: data.name };
    created.push(u);
    return u;
  });
  dbMock.user.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    [...people, ...created.map((c) => [c.id, c.name] as [string, string])]
      .filter(([id]) => where.id.in.includes(id))
      .map(([id, name]) => ({ id, name })),
  );
  dbMock.adminSquadProposal.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    proposal = { id: "p1", createdAt: NOW, ...data };
    return proposal;
  });
  dbMock.adminSquadProposal.updateMany.mockResolvedValue({ count: 1 });
  dbMock.adminSquadProposal.findFirst.mockImplementation(async () => proposal);
  att.cancelAttendance.mockResolvedValue({ status: "DROPPED" });
  att.registerAttendance.mockImplementation(async (userId: string) => {
    rows.push({ userId, status: "CONFIRMED" });
    return { status: "CONFIRMED" };
  });
});

const base = { orgId: "org", lang: "en", messageId: "wa-paste", senderUserId: "u-ann", now: NOW };

describe("a pasted 2-letter name: promised, then added", () => {
  it("Mo is proposed as new and, on YES, provisioned and put in the squad", async () => {
    const r = await proposeSquadPaste({ ...base, text: "1. Ann\n2. Bob\n3. Cal\n4. Dee\n5. Mo\n6. Uncle" });
    expect(r?.replyText).toContain("Mo, Uncle (not members yet, I'll add them as new players)");

    const yes = await answerSquadPasteYes({ ...base, messageId: "wa-yes" });
    expect(yes?.replyText).not.toContain("couldn't");
    expect(created.map((c) => c.name)).toEqual(["Mo", "Uncle"]);
    expect(rows.filter((x) => x.status === "CONFIRMED")).toHaveLength(6);
    expect(yes?.replyText).toContain("6 of 6");
  });
});

describe("the preview never promises what the YES cannot do", () => {
  it("a name that cannot be a player is said up front, not promised", async () => {
    const r = await proposeSquadPaste({ ...base, text: "1. Ann\n2. Bob\n3. Cal\n4. Dee\n5. WhatsApp" });
    expect(r?.replyText).not.toContain("I'll add them");
    expect(r?.replyText).toContain("I can't add WhatsApp as a player, so I'll leave it out.");
    expect(proposal?.playingNewNames).toEqual([]);
  });

  it("Turkish: the same line in Turkish", async () => {
    const r = await proposeSquadPaste({ ...base, lang: "tr", text: "1. Ann\n2. Bob\n3. Cal\n4. Dee\n5. WhatsApp" });
    expect(r?.replyText).toContain("WhatsApp adını oyuncu olarak ekleyemem, dışarıda bırakıyorum.");
  });
});

describe("the 3-letter guard stays for pushnames and third-party mentions", () => {
  it("createProvisionalByName: 'ba' from a pushname is still refused; an admin's 'Mo' is not", async () => {
    const { createProvisionalByName } = await import("../resolve-sender");
    expect(await createProvisionalByName("org", "ba", null)).toBeNull();
    expect(dbMock.user.create).not.toHaveBeenCalled();
    const mo = await createProvisionalByName("org", "Mo", null, { deliberate: true });
    expect(mo?.name).toBe("Mo");
    expect(await createProvisionalByName("org", "WhatsApp", null, { deliberate: true })).toBeNull();
    expect(await createProvisionalByName("org", "447700900123", null, { deliberate: true })).toBeNull();
  });

  it("resolveOrProvisionByName: a third party's 'Mo' is not provisioned; an admin-confirmed one is", async () => {
    const { resolveOrProvisionByName } = await import("../resolve-or-provision-name");
    expect(await resolveOrProvisionByName("org", "Mo")).toBeNull();
    expect((await resolveOrProvisionByName("org", "Mo", { adminConfirmed: true }))?.name).toBe("Mo");
  });

  it("admin-confirmed: when only removed members make the name ambiguous, a new player is added as promised", async () => {
    dbMock.membership.findMany.mockResolvedValue([
      { id: "m-a", userId: "u-mo1", leftAt: new Date(), user: { id: "u-mo1", name: "Mo Ali" } },
      { id: "m-b", userId: "u-mo2", leftAt: new Date(), user: { id: "u-mo2", name: "Mo Bashir" } },
    ]);
    const { resolveOrProvisionByName } = await import("../resolve-or-provision-name");
    expect(await resolveOrProvisionByName("org", "Mo")).toBeNull();
    expect(await resolveOrProvisionByName("org", "Mo", { adminConfirmed: true })).toEqual({ userId: "new-mo", name: "Mo" });
  });

  it("admin-confirmed: two CURRENT members sharing the name is still ambiguous, no duplicate is made", async () => {
    dbMock.membership.findMany.mockResolvedValue([
      { id: "m-a", userId: "u-mo1", leftAt: null, user: { id: "u-mo1", name: "Mo Ali" } },
      { id: "m-b", userId: "u-mo2", leftAt: new Date(), user: { id: "u-mo2", name: "Mo Bashir" } },
      { id: "m-c", userId: "u-mo3", leftAt: null, user: { id: "u-mo3", name: "Mo Celik" } },
    ]);
    const { resolveOrProvisionByName } = await import("../resolve-or-provision-name");
    expect(await resolveOrProvisionByName("org", "Mo", { adminConfirmed: true })).toBeNull();
    expect(dbMock.user.create).not.toHaveBeenCalled();
  });
});
