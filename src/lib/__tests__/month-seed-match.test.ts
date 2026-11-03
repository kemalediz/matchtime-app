/**
 * WHO IS WHO ON THE ORGANISER'S LIST (2026-11-03, Vets MNF: 4 of 13 names
 * matched because 20 members had no name).
 *
 *   - the DM's reader: "Craig is 3" is a match of the listed name to the
 *     member he saw as number 3, checked against what he was shown;
 *   - the nameless members: no name and no alias here, with a phone;
 *   - his choice names the member (alias, and name while he has none);
 *   - the DM asks who is who, by phone, only when there is somebody to ask about;
 *   - the page's picker: an organiser, a member, an open draft.
 * The database is mocked; no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const membershipFindMany = vi.fn();
const membershipFindFirst = vi.fn();
const aliasFindMany = vi.fn();
const userFindMany = vi.fn();
const userUpdateMany = vi.fn();
const proposalFindFirst = vi.fn();
const proposalUpdateMany = vi.fn();
const saveListAliases = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    membership: { findMany: (...a: unknown[]) => membershipFindMany(...a), findFirst: (...a: unknown[]) => membershipFindFirst(...a) },
    userAlias: { findMany: (...a: unknown[]) => aliasFindMany(...a) },
    user: { findMany: (...a: unknown[]) => userFindMany(...a), updateMany: (...a: unknown[]) => userUpdateMany(...a) },
    adminSquadProposal: { findFirst: (...a: unknown[]) => proposalFindFirst(...a), updateMany: (...a: unknown[]) => proposalUpdateMany(...a) },
  },
}));
vi.mock("@/lib/squad-month", () => ({ saveListAliases: (...a: unknown[]) => saveListAliases(...a) }));
vi.mock("@/lib/app-url", () => ({ appUrl: (p: string) => `https://mt.test${p}` }));

import { buildSeedReplyUserTurn, parseSeedReply } from "@/lib/month-seed-reply";
import { loadNamelessMembers, loadSeedMatchView, matchSeedName, nameMemberFromList, seedDmText } from "@/lib/month-seed-match";
import type { MonthSeedProposalData } from "@/lib/month-seed-hq";
import { unmatchedEntries } from "@/lib/month-seed-match-rules";

const j = (o: unknown) => JSON.stringify(o);

describe("the DM reader: a listed name matched to a member by his number", () => {
  const members = [
    { ref: "p1", userId: "u-davide" },
    { ref: "n3", userId: "u-anon3" },
  ];
  it("'Craig is 3' is a match of u2 to the member numbered 3", () => {
    const raw = j({ answer: "change", changes: [{ action: "match", member: "n3", games: 0, listed: "u2" }], confidence: 0.92 });
    expect(parseSeedReply(raw, members, ["u1", "u2"])).toEqual({ kind: "change", changes: [{ action: "match", userId: "u-anon3", listed: "u2" }] });
  });
  it("a number he was not shown, or a name not on the unknown list, is 'other'", () => {
    expect(parseSeedReply(j({ answer: "change", changes: [{ action: "match", member: "n9", games: 0, listed: "u2" }], confidence: 0.9 }), members, ["u2"]).kind).toBe("other");
    expect(parseSeedReply(j({ answer: "change", changes: [{ action: "match", member: "n3", games: 0, listed: "u7" }], confidence: 0.9 }), members, ["u2"]).kind).toBe("other");
  });
  it("the user turn lists the unknown names and the numbered nameless members, never a phone", () => {
    const turn = buildSeedReplyUserTurn({
      draft: [{ ref: "p1", name: "Davide", kind: "regular", games: null }],
      members: [{ ref: "p1", name: "Davide Russo" }],
      unmatched: [{ ref: "u1", name: "Craig" }],
      nameless: [{ ref: "n1", n: 1 }],
      asked: "the DM",
      text: "Craig is 1",
    });
    expect(turn).toContain("NAMES NOT MATCHED:\n  u1: Craig");
    expect(turn).toContain("NO NAME YET:\n  n1: number 1 in the message");
    expect(turn).not.toMatch(/\+44/);
    expect(turn.endsWith("HIS REPLY:\nCraig is 1")).toBe(true);
  });
  it("without unknown names the user turn is as before", () => {
    const turn = buildSeedReplyUserTurn({ draft: [], members: [{ ref: "p1", name: "Davide" }], asked: "a", text: "yes" });
    expect(turn).not.toContain("NAMES NOT MATCHED");
    expect(turn).not.toContain("NO NAME YET");
  });
});

const member = (id: string, name: string | null, phone: string | null) => ({ user: { id, name, phoneNumber: phone } });

beforeEach(() => {
  vi.clearAllMocks();
  aliasFindMany.mockResolvedValue([]);
  userUpdateMany.mockResolvedValue({ count: 1 });
  proposalUpdateMany.mockResolvedValue({ count: 1 });
});

describe("loadNamelessMembers", () => {
  it("members with no usable name, no alias here and a phone; the draft's own left out", async () => {
    membershipFindMany.mockResolvedValue([
      member("u-davide", "Davide Russo", "+447700900001"),
      member("u-a", null, "+447700900002"),
      member("u-b", "447700900003", "+447700900003"),
      member("u-c", null, "+447700900004"),
      member("u-d", null, null),
      member("u-e", null, "+447700900005"),
    ]);
    aliasFindMany.mockResolvedValue([{ userId: "u-c" }]);
    expect(await loadNamelessMembers("org", ["u-e"])).toEqual([
      { userId: "u-a", phone: "+447700900002" },
      { userId: "u-b", phone: "+447700900003" },
    ]);
  });
});

describe("nameMemberFromList", () => {
  it("saves the list's name as his alias, then as his name while he has none", async () => {
    await nameMemberFromList("org", "u-a", " steff ");
    expect(saveListAliases).toHaveBeenCalledWith("org", [{ userId: "u-a", alias: "steff" }]);
    expect(userUpdateMany).toHaveBeenCalledWith({ where: { id: "u-a", name: null }, data: { name: "steff" } });
  });
  it("a phone number is never a name", async () => {
    await nameMemberFromList("org", "u-a", "+44 7700 900123");
    expect(saveListAliases).not.toHaveBeenCalled();
    expect(userUpdateMany).not.toHaveBeenCalled();
  });
});

const draft = (over: Partial<MonthSeedProposalData> = {}): MonthSeedProposalData => ({
  activityId: "act",
  games: 5,
  rows: [{ userId: "u-davide", kind: "regular", listName: "Davide" }],
  unmatched: unmatchedEntries([
    { slot: 2, name: "Craig", reason: "unknown", candidates: [], kind: "regular", tier: "standard", paid: "claimed", paidAmountPence: null, gamesCommitted: 4 },
  ]),
  ...over,
});

describe("seedDmText", () => {
  beforeEach(() => userFindMany.mockResolvedValue([{ id: "u-davide", name: "Davide Russo" }]));

  it("asks who is who, numbering the nameless members by phone, in English", async () => {
    membershipFindMany.mockResolvedValue([member("u-davide", "Davide Russo", "+447700900001"), member("u-a", null, "+447700900002"), member("u-b", null, "+447700900003")]);
    const { text, nameless } = await seedDmText({ orgId: "org", lang: "en", monthStart: "2026-11-01", data: draft(), hq: false });
    expect(nameless).toEqual([{ n: 1, userId: "u-a" }, { n: 2, userId: "u-b" }]);
    expect(text).toContain("I couldn't match these names on your list to anyone: Craig.");
    expect(text).toContain("1. +44 7700 900002\n2. +44 7700 900003");
    expect(text).toContain(`for example "Craig is 1", or pick them on the months page: https://mt.test/admin/months`);
    expect(text).toContain("reply *yes* here");
    expect(text).not.toContain("Not known to me yet");
    expect(text).not.toMatch(/[–—]/);
  });

  it("in Turkish", async () => {
    membershipFindMany.mockResolvedValue([member("u-a", null, "+447700900002")]);
    const { text } = await seedDmText({ orgId: "org", lang: "tr", monthStart: "2026-11-01", data: draft(), hq: false });
    expect(text).toContain("Listendeki şu isimleri kimseyle eşleştiremedim: Craig.");
    expect(text).toContain(`örneğin "Craig 1 numara"`);
    expect(text).toContain("1. +44 7700 900002");
  });

  it("nobody nameless: the names are 'not known', and nobody is numbered", async () => {
    membershipFindMany.mockResolvedValue([member("u-davide", "Davide Russo", "+447700900001")]);
    const { text, nameless } = await seedDmText({ orgId: "org", lang: "en", monthStart: "2026-11-01", data: draft(), hq: false });
    expect(nameless).toEqual([]);
    expect(text).toContain("Not known to me yet: Craig.");
  });

  it("every name matched: neither, and no member query", async () => {
    const { text } = await seedDmText({ orgId: "org", lang: "en", monthStart: "2026-11-01", data: draft({ unmatched: [] }), hq: false });
    expect(membershipFindMany).not.toHaveBeenCalled();
    expect(text).not.toContain("Not known");
    expect(text).not.toContain("couldn't match");
  });
});

describe("matchSeedName (the months page's picker)", () => {
  const open = { id: "prop-1", monthStart: "2026-11-01", monthSeed: draft() };
  it("puts the member on the draft with the line, and names him", async () => {
    membershipFindFirst.mockResolvedValue({ id: "m" });
    proposalFindFirst.mockResolvedValue(open);
    expect(await matchSeedName({ orgId: "org", actorUserId: "u-davide", proposalId: "prop-1", ref: "u1", userId: "u-a" })).toEqual({ ok: true });
    const saved = proposalUpdateMany.mock.calls[0][0];
    expect(saved.where).toEqual({ id: "prop-1", resolvedAt: null });
    expect(saved.data.monthSeed.rows).toContainEqual(expect.objectContaining({ userId: "u-a", listName: "Craig", gamesCommitted: 4, paid: "claimed", slot: 2 }));
    expect(saved.data.monthSeed.unmatched).toEqual([]);
    expect(saved.data.playingUserIds).toEqual(["u-davide", "u-a"]);
    expect(saveListAliases).toHaveBeenCalledWith("org", [{ userId: "u-a", alias: "Craig" }]);
  });
  it("refuses a non-organiser, a non-member, a closed draft and a name already matched", async () => {
    proposalFindFirst.mockResolvedValue(open);
    membershipFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "m" });
    expect(await matchSeedName({ orgId: "org", actorUserId: "u-x", proposalId: "prop-1", ref: "u1", userId: "u-a" })).toEqual({ ok: false, error: "not-allowed" });
    membershipFindFirst.mockResolvedValueOnce({ id: "m" }).mockResolvedValueOnce(null);
    expect(await matchSeedName({ orgId: "org", actorUserId: "u-davide", proposalId: "prop-1", ref: "u1", userId: "u-out" })).toEqual({ ok: false, error: "not-a-member" });
    membershipFindFirst.mockResolvedValue({ id: "m" });
    proposalFindFirst.mockResolvedValueOnce(null);
    expect(await matchSeedName({ orgId: "org", actorUserId: "u-davide", proposalId: "prop-1", ref: "u1", userId: "u-a" })).toEqual({ ok: false, error: "not-found" });
    expect(await matchSeedName({ orgId: "org", actorUserId: "u-davide", proposalId: "prop-1", ref: "u9", userId: "u-a" })).toEqual({ ok: false, error: "no-such-name" });
    expect(proposalUpdateMany).not.toHaveBeenCalled();
  });
});

describe("loadSeedMatchView", () => {
  it("each unknown name with the nameless members by phone; null when nothing waits", async () => {
    proposalFindFirst.mockResolvedValueOnce({ id: "prop-1", monthStart: "2026-11-01", monthSeed: draft() });
    membershipFindMany.mockResolvedValue([member("u-a", null, "+447700900002")]);
    expect(await loadSeedMatchView("org")).toEqual({
      proposalId: "prop-1",
      monthStart: "2026-11-01",
      names: [{ ref: "u1", name: "Craig", options: [{ userId: "u-a", label: "+44 7700 900002" }] }],
    });
    proposalFindFirst.mockResolvedValueOnce({ id: "prop-1", monthStart: "2026-11-01", monthSeed: draft({ unmatched: [] }) });
    expect(await loadSeedMatchView("org")).toBeNull();
    proposalFindFirst.mockResolvedValueOnce(null);
    expect(await loadSeedMatchView("org")).toBeNull();
  });
});
