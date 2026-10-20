/**
 * Cross-club phone link: the server actions (FNF incident 2026-10-18).
 *
 * The real `@/lib/org` authorisation runs against an in-memory world, so
 * these tests prove who may act, not a mocked yes:
 *
 *   - an OWNER or ADMIN of club A with NO role at club B is offered the
 *     link and can make it;
 *   - a plain player of club A cannot do either;
 *   - an admin of club B only cannot act on club A's players;
 *   - the offer carries the other user's first name and club name only;
 *   - "yes" runs the shared mergePlayersCore with keep = the existing
 *     account, drop = club A's row, scoped to club A, and tags the audit
 *     row with the actor;
 *   - same-club collisions keep their behaviour (no link offered);
 *   - every failure comes back as a readable sentence (EN and TR), never
 *     a throw.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const A = "fnf";
const B = "sutton";
const PHONE = "+447404111243";

interface U { id: string; name: string | null; email: string; phoneNumber: string | null; password: string | null; isSuperadmin: boolean; onboarded?: boolean }
interface M { userId: string; orgId: string; role: "OWNER" | "ADMIN" | "PLAYER"; leftAt: Date | null; guestFromOrgId: string | null }

let users: U[] = [];
let mems: M[] = [];
let orgs: Record<string, { name: string; language: string; approvalStatus: string }> = {};
let blowUp = false;

const authMock = vi.fn();
const mergePlayersCore = vi.fn();
const userMergeUpdateMany = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/merge-players-core", () => ({ mergePlayersCore: (...a: unknown[]) => mergePlayersCore(...a) }));
vi.mock("@/lib/attendance-events", () => ({ recordAttendanceEvent: vi.fn() }));
vi.mock("@/lib/resolve-player", () => ({ findExistingOrgMember: vi.fn() }));

vi.mock("@/lib/db", () => {
  const db: Record<string, unknown> = {
    user: {
      findUnique: async ({ where }: { where: { id?: string; phoneNumber?: string } }) => {
        const u = users.find((x) => (where.id ? x.id === where.id : x.phoneNumber === where.phoneNumber));
        // The fields #314's ownership check (player-account-guard.ts) reads.
        return u
          ? {
              ...u,
              onboarded: u.onboarded ?? false,
              emailVerified: null,
              _count: { accounts: 0 },
              memberships: mems.filter((m) => m.userId === u.id).map((m) => ({ orgId: m.orgId, guestFromOrgId: m.guestFromOrgId })),
            }
          : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: { phoneNumber: string } }) => {
        if (users.some((x) => x.phoneNumber === data.phoneNumber && x.id !== where.id)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const u = users.find((x) => x.id === where.id)!;
        u.phoneNumber = data.phoneNumber;
        return u;
      },
    },
    membership: {
      findUnique: async ({ where }: { where: { userId_orgId: { userId: string; orgId: string } } }) => {
        const k = where.userId_orgId;
        const m = mems.find((x) => x.userId === k.userId && x.orgId === k.orgId);
        return m ? { ...m } : null;
      },
      findMany: async ({ where }: { where: { userId: string } }) => {
        if (blowUp) throw new Error("connection reset by peer");
        return mems.filter((x) => x.userId === where.userId).map((x) => ({ ...x, org: { name: orgs[x.orgId].name } }));
      },
      count: async ({ where }: { where: { userId: string; orgId: { not: string } } }) =>
        mems.filter((x) => x.userId === where.userId && x.orgId !== where.orgId.not).length,
    },
    organisation: {
      findUnique: async ({ where }: { where: { id: string } }) => orgs[where.id] ?? null,
    },
    userMerge: { updateMany: (...a: unknown[]) => userMergeUpdateMany(...a) },
  };
  for (const k of [
    "attendance", "rating", "moMVote", "teamAssignment", "ratingAdjustment", "playerActivityPosition",
    "analyzedMessage", "userAlias", "rosterSurveyDM", "rosterSurveyResponse", "squadMonthMember",
    "squadCredit", "account", "session",
  ]) db[k] = { count: async () => 0 };
  db.$transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return { db };
});

import { linkPlayerByPhone, updatePlayerPhone } from "../players";
import { en } from "@/lib/i18n/strings.en";

const as = (id: string) => authMock.mockResolvedValue({ user: { id } });

beforeEach(() => {
  vi.clearAllMocks();
  blowUp = false;
  orgs = {
    [A]: { name: "FNF", language: "en", approvalStatus: "approved" },
    [B]: { name: "Sutton Football Club", language: "en", approvalStatus: "approved" },
  };
  users = [
    { id: "adminA", name: "Alex Admin", email: "a@x.io", phoneNumber: "+447700900001", password: null, isSuperadmin: false },
    { id: "playerA", name: "Pat Player", email: "p@x.io", phoneNumber: "+447700900002", password: null, isSuperadmin: false },
    { id: "adminB", name: "Bea Admin", email: "b@x.io", phoneNumber: "+447700900003", password: null, isSuperadmin: false },
    { id: "habibA", name: "Habib", email: "manual-abc@placeholder.matchtime", phoneNumber: null, password: null, isSuperadmin: false },
    { id: "habibB", name: "Habib Rahman", email: "wa-447404111243@placeholder.matchtime", phoneNumber: PHONE, password: null, isSuperadmin: false },
  ];
  mems = [
    { userId: "adminA", orgId: A, role: "OWNER", leftAt: null, guestFromOrgId: null },
    { userId: "playerA", orgId: A, role: "PLAYER", leftAt: null, guestFromOrgId: null },
    { userId: "adminB", orgId: B, role: "ADMIN", leftAt: null, guestFromOrgId: null },
    { userId: "habibA", orgId: A, role: "PLAYER", leftAt: null, guestFromOrgId: null },
    { userId: "habibB", orgId: B, role: "PLAYER", leftAt: null, guestFromOrgId: null },
  ];
});

describe("authorisation", () => {
  it("a club-A admin with no role at club B is offered the link", async () => {
    as("adminA");
    expect(mems.some((m) => m.userId === "adminA" && m.orgId === B)).toBe(false);
    const r = await updatePlayerPhone("habibA", A, "+44 7404 111243");
    expect(r).toEqual({
      ok: false,
      error: "That number already belongs to someone else and can't be used twice.",
      link: { phone: PHONE, firstName: "Habib", clubNames: ["Sutton Football Club"], thisClub: "FNF" },
    });
    // Nothing else of the other user: not their id, surname or email.
    const wire = JSON.stringify(r);
    expect(wire).not.toContain("habibB");
    expect(wire).not.toContain("Rahman");
    expect(wire).not.toContain("placeholder.matchtime");
    expect(users.find((u) => u.id === "habibA")!.phoneNumber).toBeNull();
  });

  it("a club-A admin with no role at club B can link", async () => {
    as("adminA");
    const r = await linkPlayerByPhone("habibA", A, PHONE);
    expect(r).toEqual({ ok: true, keptUserId: "habibB" });
    expect(mergePlayersCore).toHaveBeenCalledTimes(1);
    expect(mergePlayersCore).toHaveBeenCalledWith(expect.anything(), "habibB", "habibA", { saveAliasInOrgIds: [A], keepIdentity: true, actorUserId: "adminA" });
    expect(userMergeUpdateMany).toHaveBeenCalledWith({
      where: { oldUserId: "habibA", survivorUserId: "habibB", orgId: A },
      data: { actorUserId: "adminA", reason: "cross-club-phone-link" },
    });
  });

  it("an ADMIN (not only the OWNER) of club A can link", async () => {
    mems.find((m) => m.userId === "adminA")!.role = "ADMIN";
    as("adminA");
    expect((await linkPlayerByPhone("habibA", A, PHONE)).ok).toBe(true);
  });

  it("a plain player of club A can neither be offered nor link", async () => {
    as("playerA");
    const offer = await updatePlayerPhone("habibA", A, PHONE);
    expect(offer).toEqual({ ok: false, error: "Only an owner or admin of this club can change a player's number." });
    const link = await linkPlayerByPhone("habibA", A, PHONE);
    expect(link).toEqual({ ok: false, error: "Only an owner or admin of this club can change a player's number." });
    expect(mergePlayersCore).not.toHaveBeenCalled();
  });

  it("an admin of club B only cannot act on club A's players", async () => {
    as("adminB");
    const offer = await updatePlayerPhone("habibA", A, PHONE);
    expect(offer.ok).toBe(false);
    expect(!offer.ok && offer.link).toBeUndefined();
    const link = await linkPlayerByPhone("habibA", A, PHONE);
    expect(link).toEqual({ ok: false, error: "Only an owner or admin of this club can change a player's number." });
    expect(mergePlayersCore).not.toHaveBeenCalled();
  });

  it("a former admin of club A (left) cannot link", async () => {
    mems.find((m) => m.userId === "adminA")!.leftAt = new Date();
    as("adminA");
    expect((await linkPlayerByPhone("habibA", A, PHONE)).ok).toBe(false);
    expect(mergePlayersCore).not.toHaveBeenCalled();
  });

  it("signed out: refused as data", async () => {
    authMock.mockResolvedValue(null);
    expect((await linkPlayerByPhone("habibA", A, PHONE)).ok).toBe(false);
    expect((await updatePlayerPhone("habibA", A, PHONE)).ok).toBe(false);
  });
});

describe("the rules, through the actions", () => {
  it("a player of A who is also at another club is refused, with no name", async () => {
    mems.push({ userId: "habibA", orgId: "third", role: "PLAYER", leftAt: null, guestFromOrgId: null });
    orgs.third = { name: "Third FC", language: "en", approvalStatus: "approved" };
    as("adminA");
    const offer = await updatePlayerPhone("habibA", A, PHONE);
    expect(offer.ok).toBe(false);
    expect(!offer.ok && offer.link).toBeUndefined();
    // #314 refuses first: a record in another club is not this club's to
    // change at all, whatever number is typed.
    expect(!offer.ok && offer.error).toBe(en.pg_err_player_owns_account);
    expect(JSON.stringify(offer)).not.toContain("Habib");
    const link = await linkPlayerByPhone("habibA", A, PHONE);
    expect(link.ok).toBe(false);
    expect(mergePlayersCore).not.toHaveBeenCalled();
  });

  it("a link to a player not in club A is refused", async () => {
    as("adminA");
    const link = await linkPlayerByPhone("adminB", A, PHONE);
    expect(link.ok).toBe(false);
    expect(mergePlayersCore).not.toHaveBeenCalled();
  });

  it("a same-club collision is unchanged: no link, the holder is named", async () => {
    mems.push({ userId: "habibB", orgId: A, role: "PLAYER", leftAt: null, guestFromOrgId: null });
    as("adminA");
    const r = await updatePlayerPhone("habibA", A, PHONE);
    expect(r).toEqual({
      ok: false,
      error: "That number already belongs to Habib in this club. To combine the two, use Merge.",
    });
    const link = await linkPlayerByPhone("habibA", A, PHONE);
    expect(link.ok).toBe(false);
    expect(mergePlayersCore).not.toHaveBeenCalled();
  });

  it("a free number saves as before", async () => {
    as("adminA");
    const r = await updatePlayerPhone("habibA", A, "+447700900777");
    expect(r).toEqual({ ok: true, phoneNumber: "+447700900777" });
  });
});

describe("#314's account guard holds on the link path", () => {
  it("a club-A record somebody signed in on (onboarded) is refused before any offer", async () => {
    users.find((u) => u.id === "habibA")!.onboarded = true;
    as("adminA");
    const offer = await updatePlayerPhone("habibA", A, PHONE);
    expect(offer).toEqual({ ok: false, error: en.pg_err_player_owns_account });
    expect(JSON.stringify(offer)).not.toContain("Habib");
  });

  it("linkPlayerByPhone called directly cannot merge away a record somebody signed in on", async () => {
    users.find((u) => u.id === "habibA")!.onboarded = true;
    as("adminA");
    const link = await linkPlayerByPhone("habibA", A, PHONE);
    expect(link.ok).toBe(false);
    expect(mergePlayersCore).not.toHaveBeenCalled();
    expect(userMergeUpdateMany).not.toHaveBeenCalled();
  });

  it("an unapproved club can neither be offered nor link", async () => {
    orgs[A].approvalStatus = "draft";
    as("adminA");
    expect(await updatePlayerPhone("habibA", A, PHONE)).toEqual({ ok: false, error: en.pg_err_club_not_approved });
    expect(await linkPlayerByPhone("habibA", A, PHONE)).toEqual({ ok: false, error: en.pg_err_club_not_approved });
    expect(mergePlayersCore).not.toHaveBeenCalled();
  });

  it("a platform superadmin may link for an unapproved club", async () => {
    orgs[A].approvalStatus = "draft";
    users.find((u) => u.id === "adminA")!.isSuperadmin = true;
    as("adminA");
    expect(await linkPlayerByPhone("habibA", A, PHONE)).toEqual({ ok: true, keptUserId: "habibB" });
  });

  it("after a link the other club's account is not this club's to edit", async () => {
    // What the link leaves behind: the existing account, now in both clubs.
    mems.push({ userId: "habibB", orgId: A, role: "PLAYER", leftAt: null, guestFromOrgId: null });
    as("adminA");
    expect(await updatePlayerPhone("habibB", A, "+447700900777")).toEqual({ ok: false, error: en.pg_err_player_owns_account });
  });
});

describe("readable errors, never a throw", () => {
  it("an invalid number", async () => {
    as("adminA");
    expect(await updatePlayerPhone("habibA", A, "12")).toEqual({
      ok: false,
      error: "That doesn't look like a valid phone number. Use the international format, for example +44 7700 900123.",
    });
  });

  it("an unexpected failure becomes a sentence", async () => {
    as("adminA");
    blowUp = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await updatePlayerPhone("habibA", A, PHONE)).toEqual({
      ok: false,
      error: "Couldn't save the number. Please try again.",
    });
    expect(await linkPlayerByPhone("habibA", A, PHONE)).toEqual({
      ok: false,
      error: "Couldn't save the number. Please try again.",
    });
    spy.mockRestore();
  });

  it("in Turkish for a Turkish club", async () => {
    orgs[A].language = "tr";
    as("adminA");
    const r = await updatePlayerPhone("habibA", A, PHONE);
    expect(!r.ok && r.error).toBe("Bu numara zaten başka birine ait ve iki kez kullanılamaz.");
    as("playerA");
    expect(await linkPlayerByPhone("habibA", A, PHONE)).toEqual({
      ok: false,
      error: "Bir oyuncunun numarasını yalnızca bu kulübün sahibi veya yöneticisi değiştirebilir.",
    });
  });
});
