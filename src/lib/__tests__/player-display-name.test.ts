/**
 * ONE NAME FOR A PLAYER ON EVERY SQUAD SURFACE (2026-10-22).
 *
 * Prod, MT Test: two partner guests from Friday MT Community volunteered
 * for the Wed 28 Oct match. The squad answer listed them as "C1" and
 * "(unnamed)": C2's `User.name` is NULL, he has no alias anywhere, and the
 * analyze route printed a hard-coded English "(unnamed)". Neither line
 * said which club they came from, though the cross-club plan (D7) says a
 * guest is shown by name and club: "Ali K (Sutton FC)".
 *
 * The order: User.name, this club's alias, the guest's home-club alias,
 * then the group's own word for "unnamed". A phone number is never a name.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { en } from "@/lib/i18n/strings.en";
import { tr } from "@/lib/i18n/strings.tr";

const users: Array<{ id: string; name: string | null }> = [];
const mems: Array<{ userId: string; orgId: string; guestFromOrgId: string | null; guestMatchId?: string | null; guestVia?: string | null }> = [];
const aliases: Array<{ userId: string; orgId: string; alias: string; createdAt: Date }> = [];
const orgs: Array<{ id: string; name: string }> = [];

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => users.filter((u) => where.id.in.includes(u.id)),
    },
    membership: {
      findMany: async ({ where }: { where: { orgId: string; userId: { in: string[] } } }) =>
        mems.filter((m) => m.orgId === where.orgId && where.userId.in.includes(m.userId)),
    },
    userAlias: {
      findMany: async ({ where }: { where: { userId: { in: string[] }; orgId: { in: string[] } } }) =>
        aliases
          .filter((a) => where.userId.in.includes(a.userId) && where.orgId.in.includes(a.orgId))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    },
    organisation: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => orgs.filter((o) => where.id.in.includes(o.id)),
    },
  },
}));

import { resolvePlayerName, playerDisplayName, loadPlayerNames } from "@/lib/player-display-name";

const MT_TEST = "cmvhr10dr0000oe9kbvnz40od";
const FRIDAY = "cmv76hlnd000006l6h6or76ht";

describe("resolvePlayerName (pure)", () => {
  it("User.name first", () => {
    expect(resolvePlayerName({ name: "Elvin", aliasesHere: ["el"], aliasesHome: ["e"] })).toBe("Elvin");
  });
  it("an empty or blank User.name falls through to this club's alias", () => {
    expect(resolvePlayerName({ name: null, aliasesHere: ["cem two"] })).toBe("Cem Two");
    expect(resolvePlayerName({ name: "  ", aliasesHere: ["cem"] })).toBe("Cem");
  });
  it("then the guest's home-club alias", () => {
    expect(resolvePlayerName({ name: null, aliasesHere: [], aliasesHome: ["c2"] })).toBe("C2");
  });
  it("null when MatchTime holds no name at all (C2 in prod)", () => {
    expect(resolvePlayerName({ name: null })).toBeNull();
  });
  it("a phone number is never a name, at any step", () => {
    expect(resolvePlayerName({ name: "+447893944985", aliasesHere: ["07893 944985"], aliasesHome: ["ali"] })).toBe("Ali");
    expect(resolvePlayerName({ name: "447893944985" })).toBeNull();
  });
  it("Turkish letters are capitalised correctly", () => {
    expect(resolvePlayerName({ name: null, aliasesHere: ["ilker"] }, "tr")).toBe("İlker");
  });
});

describe("playerDisplayName (pure)", () => {
  it("a member of this club: just the name", () => {
    expect(playerDisplayName({ name: "Baki" }, "en")).toBe("Baki");
  });
  it("a partner guest: name and club (D7)", () => {
    expect(playerDisplayName({ name: "C1", guestClubName: "Friday MT Community" }, "en")).toBe("C1 (Friday MT Community)");
    expect(playerDisplayName({ name: "C1", guestClubName: "Friday MT Community" }, "tr")).toBe("C1 (Friday MT Community)");
  });
  it("no name: the group's own word for unnamed, in its language", () => {
    expect(playerDisplayName({ name: null }, "en")).toBe(en.unnamed);
    expect(playerDisplayName({ name: null }, "tr")).toBe(tr.unnamed);
  });
  it("an unnamed guest still says which club he is from", () => {
    expect(playerDisplayName({ name: null, guestClubName: "Friday MT Community" }, "en")).toBe(`${en.unnamed} (Friday MT Community)`);
    expect(playerDisplayName({ name: null, guestClubName: "Friday MT Community" }, "tr")).toBe(`${tr.unnamed} (Friday MT Community)`);
  });
});

describe("loadPlayerNames (prod shapes)", () => {
  beforeEach(() => {
    users.length = 0;
    mems.length = 0;
    aliases.length = 0;
    orgs.length = 0;
    orgs.push({ id: FRIDAY, name: "Friday MT Community" }, { id: MT_TEST, name: "MT Test" });
    users.push(
      { id: "elvin", name: "Elvin" },
      { id: "c1", name: "C1" },
      { id: "c2", name: null },
    );
    mems.push(
      { userId: "elvin", orgId: MT_TEST, guestFromOrgId: null },
      { userId: "c1", orgId: MT_TEST, guestFromOrgId: FRIDAY },
      { userId: "c2", orgId: MT_TEST, guestFromOrgId: FRIDAY },
    );
  });

  it("the MT Test squad of 2026-10-22: members plain, guests with their club", async () => {
    const names = await loadPlayerNames(MT_TEST, ["elvin", "c1", "c2"], "en");
    expect(names.get("elvin")).toEqual({ name: "Elvin", display: "Elvin" });
    expect(names.get("c1")).toEqual({ name: "C1", display: "C1 (Friday MT Community)" });
    expect(names.get("c2")).toEqual({ name: null, display: `${en.unnamed} (Friday MT Community)` });
  });

  it("a POOL guest (no home club, L5a) is shown as from the MatchTime pool, in the group's language", async () => {
    users.push({ id: "pool1", name: "Ali K" });
    mems.push({ userId: "pool1", orgId: MT_TEST, guestFromOrgId: null, guestMatchId: "m1", guestVia: "pool" });
    expect((await loadPlayerNames(MT_TEST, ["pool1"], "en")).get("pool1")).toEqual({ name: "Ali K", display: "Ali K (MatchTime player pool)" });
    expect((await loadPlayerNames(MT_TEST, ["pool1"], "tr")).get("pool1")?.display).toBe("Ali K (MatchTime oyuncu havuzu)");
  });

  it("a guest's home-club alias names him when User.name is empty", async () => {
    aliases.push({ userId: "c2", orgId: FRIDAY, alias: "c2", createdAt: new Date("2026-10-22") });
    const names = await loadPlayerNames(MT_TEST, ["c2"], "en");
    expect(names.get("c2")).toEqual({ name: "C2", display: "C2 (Friday MT Community)" });
  });

  it("this club's alias wins over the home club's", async () => {
    aliases.push(
      { userId: "c2", orgId: FRIDAY, alias: "c2", createdAt: new Date("2026-10-20") },
      { userId: "c2", orgId: MT_TEST, alias: "cem", createdAt: new Date("2026-10-21") },
    );
    const names = await loadPlayerNames(MT_TEST, ["c2"], "en");
    expect(names.get("c2")?.name).toBe("Cem");
  });

  it("an alias at some third club is never used", async () => {
    aliases.push({ userId: "c2", orgId: "org-third", alias: "secret", createdAt: new Date() });
    const names = await loadPlayerNames(MT_TEST, ["c2"], "en");
    expect(names.get("c2")?.name).toBeNull();
  });

  it("no ids, no queries, an empty map", async () => {
    expect((await loadPlayerNames(MT_TEST, [], "en")).size).toBe(0);
  });

  it("never carries a phone number", async () => {
    users.push({ id: "p", name: "+447893944985" });
    mems.push({ userId: "p", orgId: MT_TEST, guestFromOrgId: FRIDAY });
    const names = await loadPlayerNames(MT_TEST, ["p"], "en");
    expect(JSON.stringify([...names.values()])).not.toMatch(/\d{6,}/);
  });
});

describe("loadPlayerNames fails soft", () => {
  it("a failed read returns an empty map, so the caller prints plain names", async () => {
    const { db } = await import("@/lib/db");
    const spy = vi.spyOn(db.user, "findMany").mockRejectedValueOnce(new Error("pool down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await loadPlayerNames(MT_TEST, ["c1"], "en")).size).toBe(0);
    expect(err).toHaveBeenCalled();
    spy.mockRestore();
    err.mockRestore();
  });
});
