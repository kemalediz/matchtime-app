/**
 * A CLUB ADMIN CANNOT TAKE OVER SOMEBODY ELSE'S ACCOUNT (2026-10-18).
 *
 * A phone number is a sign-in (verifyPhoneSignIn finds the user by it),
 * and `User.phoneNumber` / `User.name` are global. The attack class this
 * pins shut: an admin attaches a stranger's existing account to their own
 * club, then changes its number to one they hold. Each step is refused on
 * its own, so closing any one of them is not relied on:
 *
 *   1. typing a number that already belongs to someone outside the club
 *      (createPlayer, addPlayerToMatch) attaches nobody and names nobody;
 *   2. changing the number or name of a user the club does not OWN (has
 *      signed in, or is in any other club) is refused;
 *   3. a merge cannot fold a real account away, nor hand a real account a
 *      number from a placeholder;
 *   4. none of the player-editing actions work for an unapproved club,
 *      except for a platform superadmin.
 *
 * And the legitimate flows still work: editing a club's own placeholder,
 * the sync-orphan merge, a same-club rejoin, a placeholder merged into a
 * real player.
 *
 * auth / db / next are mocked with a small in-memory store. No live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { en } from "@/lib/i18n/strings.en";
import { tr } from "@/lib/i18n/strings.tr";

type U = {
  id: string;
  name: string | null;
  email: string;
  phoneNumber: string | null;
  onboarded: boolean;
  password: string | null;
  emailVerified: Date | null;
  isSuperadmin: boolean;
  accounts: number;
};
type M = { id: string; userId: string; orgId: string; role: string; leftAt: Date | null; guestFromOrgId: string | null };
type O = { id: string; approvalStatus: string; language: string };

const store = {
  users: new Map<string, U>(),
  mems: [] as M[],
  orgs: new Map<string, O>(),
  events: [] as Array<{ userId: string; orgId: string; cause: string }>,
};
const authMock = vi.fn();
const requireOrgAdmin = vi.fn();
const mergeCore = vi.fn();
const userUpdate = vi.fn();
const membershipCreate = vi.fn();
const membershipUpdate = vi.fn();

function pick<T extends object>(row: T, select?: Record<string, unknown>): Record<string, unknown> {
  if (!select) return { ...(row as unknown as Record<string, unknown>) };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(select)) {
    if (k === "_count") out._count = { accounts: (row as unknown as U).accounts };
    else if (k === "memberships")
      out.memberships = store.mems
        .filter((m) => m.userId === (row as unknown as U).id)
        .map((m) => ({ orgId: m.orgId, guestFromOrgId: m.guestFromOrgId }));
    else out[k] = (row as unknown as Record<string, unknown>)[k];
  }
  return out;
}

function findUser(where: { id?: string; phoneNumber?: string }): U | undefined {
  if (where.id) return store.users.get(where.id);
  return [...store.users.values()].find((u) => u.phoneNumber === where.phoneNumber);
}

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: (...a: unknown[]) => requireOrgAdmin(...a) }));
vi.mock("@/lib/resolve-player", () => ({ findExistingOrgMember: vi.fn(async () => null) }));
vi.mock("@/lib/merge-players-core", () => ({ mergePlayersCore: (...a: unknown[]) => mergeCore(...a) }));
vi.mock("@/lib/attendance-events", () => ({ recordAttendanceEvent: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/db", () => {
  const db = {
    user: {
      findUnique: async ({ where, select }: { where: { id?: string; phoneNumber?: string }; select?: Record<string, unknown> }) => {
        const u = findUser(where);
        return u ? pick(u, select) : null;
      },
      update: async (args: { where: { id: string }; data: Partial<U> }) => {
        userUpdate(args);
        const u = store.users.get(args.where.id)!;
        if (args.data.phoneNumber && [...store.users.values()].some((x) => x.id !== u.id && x.phoneNumber === args.data.phoneNumber)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        Object.assign(u, args.data);
        return u;
      },
      create: async ({ data }: { data: Partial<U> }) => {
        const id = `new-${store.users.size}`;
        store.users.set(id, { ...blankUser(id), ...data, id } as U);
        return { id };
      },
    },
    membership: {
      findUnique: async ({ where }: { where: { userId_orgId: { userId: string; orgId: string } } }) =>
        store.mems.find((m) => m.userId === where.userId_orgId.userId && m.orgId === where.userId_orgId.orgId) ?? null,
      findMany: async ({ where }: { where: { userId: string } }) =>
        store.mems.filter((m) => m.userId === where.userId).map((m) => ({ ...m, org: { name: `Club ${m.orgId}` } })),
      // The cross-club link's fact loader (cross-club-link.ts, #312).
      count: async ({ where }: { where: { userId: string; orgId: { not: string } } }) =>
        store.mems.filter((m) => m.userId === where.userId && m.orgId !== where.orgId.not).length,
      create: async ({ data }: { data: Omit<M, "id" | "leftAt" | "guestFromOrgId"> }) => {
        membershipCreate(data);
        const m = { id: `m-${store.mems.length}`, leftAt: null, guestFromOrgId: null, ...data } as M;
        store.mems.push(m);
        return m;
      },
      update: async (args: { where: { id?: string }; data: Partial<M> }) => {
        membershipUpdate(args);
        return {};
      },
    },
    organisation: {
      findUnique: async ({ where }: { where: { id: string } }) => store.orgs.get(where.id) ?? null,
    },
    attendanceEvent: {
      findMany: async ({ where }: { where: { userId: string; orgId: { in: string[] }; cause: { notIn: string[] } } }) =>
        store.events
          .filter((e) => e.userId === where.userId && where.orgId.in.includes(e.orgId) && !where.cause.notIn.includes(e.cause))
          .map((e) => ({ orgId: e.orgId })),
    },
    match: {
      findUnique: async () => ({
        id: "match-1",
        date: new Date("2030-01-01"),
        status: "UPCOMING",
        activity: { name: "Tue", orgId: CLUB, matchDurationMins: 60, sport: { mvpLabel: "MoM" } },
      }),
    },
    attendance: { count: async () => 0 },
    rating: { count: async () => 0 },
    moMVote: { count: async () => 0 },
    teamAssignment: { count: async () => 0 },
    ratingAdjustment: { count: async () => 0 },
    playerActivityPosition: { count: async () => 0 },
    analyzedMessage: { count: async () => 0 },
    userAlias: { count: async () => 0 },
    rosterSurveyDM: { count: async () => 0 },
    rosterSurveyResponse: { count: async () => 0 },
    squadMonthMember: { count: async () => 0 },
    squadCredit: { count: async () => 0 },
    account: { count: async () => 0 },
    session: { count: async () => 0 },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  };
  return { db };
});

import {
  createPlayer,
  updatePlayerPhone,
  updatePlayerName,
  mergePlayers,
  removeProvisionalPlayer,
  addPlayerToMatch,
} from "@/app/actions/players";
import { clubOwnsUser, hasOwnSignIn } from "@/lib/player-account-guard";

const ADMIN = "admin";
const CLUB = "org-attacker";
const OTHER = "org-victim-club";
const ATTACKER_PHONE = "+447700900111";
const VICTIM_PHONE = "+447700900222";

function blankUser(id: string): U {
  return {
    id,
    name: null,
    email: `wa-sync+${id}@matchtime.local`,
    phoneNumber: null,
    onboarded: false,
    password: null,
    emailVerified: null,
    isSuperadmin: false,
    accounts: 0,
  };
}
function addUser(id: string, over: Partial<U> = {}) {
  store.users.set(id, { ...blankUser(id), ...over });
}
function addMem(userId: string, orgId: string, over: Partial<M> = {}) {
  store.mems.push({ id: `m-${userId}-${orgId}`, userId, orgId, role: "PLAYER", leftAt: null, guestFromOrgId: null, ...over });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.users.clear();
  store.mems.length = 0;
  store.events.length = 0;
  store.orgs.clear();
  store.orgs.set(CLUB, { id: CLUB, approvalStatus: "approved", language: "en" });
  store.orgs.set(OTHER, { id: OTHER, approvalStatus: "approved", language: "en" });
  authMock.mockResolvedValue({ user: { id: ADMIN } });
  requireOrgAdmin.mockResolvedValue(undefined);
  addUser(ADMIN, { name: "Admin", onboarded: true, phoneNumber: "+447700900999" });
  addMem(ADMIN, CLUB, { role: "OWNER" });
  // The victim: a real player who signs in by phone, at another club.
  addUser("victim", { name: "Victim", phoneNumber: VICTIM_PHONE, onboarded: true, email: "phone+victim@matchtime.local" });
  addMem("victim", OTHER);
});

describe("ownership (pure)", () => {
  const base = {
    email: "wa-x@placeholder.matchtime",
    onboarded: false,
    password: null,
    emailVerified: null,
    isSuperadmin: false,
    accountCount: 0,
    memberships: [{ orgId: CLUB, guestFromOrgId: null }],
  };
  it("a placeholder only in this club is owned", () => {
    expect(clubOwnsUser(base, CLUB)).toBe(true);
  });
  it.each([
    ["signed in by phone", { onboarded: true }],
    ["has an OAuth account", { accountCount: 1 }],
    ["has a password", { password: "x" }],
    ["verified an email", { emailVerified: new Date() }],
    ["has a real email", { email: "someone@gmail.com" }],
    ["is a superadmin", { isSuperadmin: true }],
  ])("not owned when the user %s", (_l, over) => {
    expect(hasOwnSignIn({ ...base, ...over })).toBe(true);
    expect(clubOwnsUser({ ...base, ...over }, CLUB)).toBe(false);
  });
  it("not owned when in another club, even a past or guest membership", () => {
    expect(clubOwnsUser({ ...base, memberships: [...base.memberships, { orgId: OTHER, guestFromOrgId: null }] }, CLUB)).toBe(false);
    expect(clubOwnsUser({ ...base, memberships: [{ orgId: CLUB, guestFromOrgId: OTHER }] }, CLUB)).toBe(false);
    expect(clubOwnsUser({ ...base, memberships: [] }, CLUB)).toBe(false);
  });
  it("a POOL guest row (no home club, L5a) is never this club's claim on his record", () => {
    // His only row here is a pool guest's: not an ordinary membership.
    expect(clubOwnsUser({ ...base, memberships: [{ orgId: CLUB, guestFromOrgId: null, guestMatchId: "m1" }] }, CLUB)).toBe(false);
    // A pool guest row at another club is not lent out by this one.
    expect(
      clubOwnsUser({ ...base, memberships: [...base.memberships, { orgId: OTHER, guestFromOrgId: null, guestMatchId: "m1" }] }, CLUB),
    ).toBe(false);
  });
});

describe("step 1: attaching a stranger by number is refused", () => {
  it("createPlayer with a number that belongs to someone outside the club attaches nobody and names nobody", async () => {
    const res = await createPlayer(CLUB, "Anything", VICTIM_PHONE);
    expect(res).toEqual({ ok: false, error: en.pg_err_number_on_matchtime });
    expect(membershipCreate).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain("Victim");
  });

  it("the refusal is in the club's language", async () => {
    store.orgs.get(CLUB)!.language = "tr";
    const res = await createPlayer(CLUB, "Anything", VICTIM_PHONE);
    expect(res).toEqual({ ok: false, error: tr.pg_err_number_on_matchtime });
  });

  it("a user with no club at all is not attached either", async () => {
    addUser("loner", { phoneNumber: "+447700900333", onboarded: true });
    const res = await createPlayer(CLUB, "Loner", "+447700900333");
    expect(res.ok).toBe(false);
    expect(membershipCreate).not.toHaveBeenCalled();
  });

  it("a past guest from a partner club is not turned into a member", async () => {
    addMem("victim", CLUB, { leftAt: new Date(), guestFromOrgId: OTHER });
    const res = await createPlayer(CLUB, "Victim", VICTIM_PHONE);
    expect(res).toEqual({ ok: false, error: en.pg_err_number_on_matchtime });
    expect(membershipUpdate).not.toHaveBeenCalled();
  });

  it("addPlayerToMatch by number refuses the same way", async () => {
    const res = await addPlayerToMatch("match-1", { phone: VICTIM_PHONE, name: "x" });
    expect(res).toEqual({ ok: false, error: en.pg_err_number_on_matchtime });
    expect(membershipCreate).not.toHaveBeenCalled();
  });

  it("addPlayerToMatch by user id cannot reach a user outside the club", async () => {
    const res = await addPlayerToMatch("match-1", { userId: "victim" });
    expect(res).toEqual({ ok: false, error: en.pg_err_number_on_matchtime });
    expect(membershipCreate).not.toHaveBeenCalled();
  });

  it("still works: a same-club rejoin by number", async () => {
    addUser("old", { name: "Old Boy", phoneNumber: "+447700900444" });
    addMem("old", CLUB, { leftAt: new Date() });
    const res = await createPlayer(CLUB, "Old Boy", "+447700900444");
    expect(res).toEqual({ ok: true, userId: "old", created: false, rejoined: true });
  });

  it("still works: a brand new number creates a player", async () => {
    const res = await createPlayer(CLUB, "New Guy", "+447700900555");
    expect(res).toMatchObject({ ok: true, created: true });
  });
});

describe("step 2: changing the number or name of a record the club does not own", () => {
  it("refuses a phone change on someone else's account attached to this club", async () => {
    addMem("victim", CLUB); // e.g. attached before this fix
    const res = await updatePlayerPhone("victim", CLUB, ATTACKER_PHONE);
    expect(res).toEqual({ ok: false, error: en.pg_err_player_owns_account });
    expect(store.users.get("victim")!.phoneNumber).toBe(VICTIM_PHONE);
  });

  it("refuses a phone change on a never-signed-in record that is also in another club", async () => {
    addUser("shared", { name: "Shared", phoneNumber: "+447700900666" });
    addMem("shared", CLUB);
    addMem("shared", OTHER, { leftAt: new Date() });
    const res = await updatePlayerPhone("shared", CLUB, ATTACKER_PHONE);
    expect(res).toEqual({ ok: false, error: en.pg_err_player_owns_account });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a phone change on a record that signed in, even if only in this club", async () => {
    addUser("mine", { name: "Mine", onboarded: true });
    addMem("mine", CLUB);
    const res = await updatePlayerPhone("mine", CLUB, ATTACKER_PHONE);
    expect(res).toEqual({ ok: false, error: en.pg_err_player_owns_account });
  });

  it("refuses a rename of someone else's account", async () => {
    addMem("victim", CLUB);
    const res = await updatePlayerName("victim", CLUB, "Renamed");
    expect(res).toEqual({ ok: false, error: en.pg_err_player_owns_account });
    expect(store.users.get("victim")!.name).toBe("Victim");
  });

  it("still works: the club's own placeholder gets a number and a name", async () => {
    addUser("ph", { name: "MJA swthree" });
    addMem("ph", CLUB);
    expect(await updatePlayerPhone("ph", CLUB, "+447700900777")).toEqual({ ok: true, phoneNumber: "+447700900777" });
    expect(await updatePlayerName("ph", CLUB, "Michael")).toEqual({ ok: true });
    expect(store.users.get("ph")).toMatchObject({ phoneNumber: "+447700900777", name: "Michael" });
  });

  it("still works: a same-club sync orphan holding the number is merged in", async () => {
    addUser("ph", { name: "Faris" });
    addMem("ph", CLUB);
    addUser("orphan", { phoneNumber: "+447700900888" });
    addMem("orphan", CLUB);
    const res = await updatePlayerPhone("ph", CLUB, "+447700900888");
    expect(res).toMatchObject({ mergedSyncOrphan: "orphan" });
    expect(mergeCore).toHaveBeenCalledWith(expect.anything(), "ph", "orphan", expect.anything());
  });

  it("a number held by an orphan in ANOTHER club is not merged across, and nobody is named", async () => {
    addUser("ph", { name: "Faris" });
    addMem("ph", CLUB);
    addUser("orphan", { phoneNumber: "+447700900888", name: null });
    addMem("orphan", OTHER);
    const res = await updatePlayerPhone("ph", CLUB, "+447700900888");
    expect(res).toMatchObject({ ok: false });
    expect(mergeCore).not.toHaveBeenCalled();
  });

  it("the collision message does not name a player from another club", async () => {
    addUser("ph", { name: "Faris" });
    addMem("ph", CLUB);
    const res = await updatePlayerPhone("ph", CLUB, VICTIM_PHONE);
    expect(res).toMatchObject({ ok: false });
    // The error sentence names nobody. The "Same person?" offer (#312,
    // owner-approved) carries the holder's FIRST name and club name only,
    // never their id, email or phone beyond what the admin typed.
    expect(!res.ok && res.error).not.toContain("Victim");
    expect(!res.ok && res.link).toEqual({ phone: VICTIM_PHONE, firstName: "Victim", clubNames: [`Club ${OTHER}`], thisClub: "" });
    expect(JSON.stringify(res)).not.toContain("phone+victim");
    expect(JSON.stringify(res)).not.toContain('"victim"');
    expect(mergeCore).not.toHaveBeenCalled();
    expect(store.users.get("victim")!.phoneNumber).toBe(VICTIM_PHONE);
  });
});

describe("step 3: a merge cannot fold a real account away or hand it a number", () => {
  beforeEach(() => {
    addUser("ph", { name: "Placeholder", phoneNumber: ATTACKER_PHONE });
    addMem("ph", CLUB);
    addMem("victim", CLUB);
  });

  it("refuses dropping a record the club does not own", async () => {
    const res = await mergePlayers(CLUB, "ph", "victim");
    expect(res).toEqual({ ok: false, error: en.pg_err_merge_keep_owned });
    expect(mergeCore).not.toHaveBeenCalled();
  });

  it("refuses a merge that would give a real account the placeholder's number", async () => {
    store.users.get("victim")!.phoneNumber = null;
    const res = await mergePlayers(CLUB, "victim", "ph");
    expect(res).toEqual({ ok: false, error: en.pg_err_player_owns_account });
    expect(mergeCore).not.toHaveBeenCalled();
  });

  it("still works: a placeholder merged into a real player who keeps their own number", async () => {
    const res = await mergePlayers(CLUB, "victim", "ph");
    expect(res).toEqual({ ok: true });
    expect(mergeCore).toHaveBeenCalledWith(expect.anything(), "victim", "ph", expect.anything());
  });
});

describe("step 4: an unapproved club cannot edit players", () => {
  beforeEach(() => {
    store.orgs.get(CLUB)!.approvalStatus = "draft";
    addUser("ph", { name: "Ph" });
    addMem("ph", CLUB);
    addUser("ph2", { name: "Ph2" });
    addMem("ph2", CLUB);
  });
  const refused = { ok: false, error: en.pg_err_club_not_approved };

  it.each([
    ["createPlayer", () => createPlayer(CLUB, "New", "+447700900555")],
    ["updatePlayerPhone", () => updatePlayerPhone("ph", CLUB, "+447700900555")],
    ["updatePlayerName", () => updatePlayerName("ph", CLUB, "X")],
    ["mergePlayers", () => mergePlayers(CLUB, "ph", "ph2")],
    ["removeProvisionalPlayer", () => removeProvisionalPlayer("ph", CLUB)],
    ["addPlayerToMatch", () => addPlayerToMatch("match-1", { name: "New", phone: "+447700900555" })],
  ])("%s is refused for a draft club", async (_n, call) => {
    expect(await call()).toEqual(refused);
    expect(userUpdate).not.toHaveBeenCalled();
    expect(membershipCreate).not.toHaveBeenCalled();
    expect(membershipUpdate).not.toHaveBeenCalled();
    expect(mergeCore).not.toHaveBeenCalled();
  });

  it.each(["pending", "rejected", "suspended"])("a %s club is refused too", async (status) => {
    store.orgs.get(CLUB)!.approvalStatus = status;
    expect(await updatePlayerName("ph", CLUB, "X")).toEqual(refused);
  });

  it("a platform superadmin still can", async () => {
    store.users.get(ADMIN)!.isSuperadmin = true;
    expect(await updatePlayerName("ph", CLUB, "Fixed")).toEqual({ ok: true });
  });
});

// ── A home club keeps its own player while he guests elsewhere (2026-10-22) ──
//
// Prod, MT Test / Friday MT Community: C2 is a never-signed-in placeholder
// at Friday MT Community. When he volunteered for a partner ask, MatchTime
// gave him a guest membership at MT Test (`guestFromOrgId` = Friday). From
// that moment `clubOwnsUser` said Friday no longer owned him, so Kemal's
// rename at Friday was refused and the squad list kept printing "(unnamed)".
// A guest row FROM the home club is that club's own player lent out; it
// must not take him away. Every other protection stays.
describe("a guest membership from the home club does not take the player away from it", () => {
  const HOME = CLUB;
  const PARTNER = "org-partner";
  const THIRD = "org-third";
  const base = {
    email: "wa-sync+player-x@matchtime.local",
    onboarded: false,
    password: null,
    emailVerified: null,
    isSuperadmin: false,
    accountCount: 0,
    guestOrgsWithOtherHistory: [] as string[],
  };
  const home = { orgId: HOME, guestFromOrgId: null };
  const lent = { orgId: PARTNER, guestFromOrgId: HOME };

  describe("pure rule", () => {
    it("owned by the home club when his only other row is a guest row from the home club", () => {
      expect(clubOwnsUser({ ...base, memberships: [home, lent] }, HOME)).toBe(true);
    });
    it("still owned with guest rows at several partners, all from the home club", () => {
      expect(clubOwnsUser({ ...base, memberships: [home, lent, { orgId: THIRD, guestFromOrgId: HOME }] }, HOME)).toBe(true);
    });
    it("never owned by the partner club he guests at", () => {
      expect(clubOwnsUser({ ...base, memberships: [home, lent] }, PARTNER)).toBe(false);
    });
    it("a guest row from a DIFFERENT club still blocks the home club", () => {
      expect(clubOwnsUser({ ...base, memberships: [home, { orgId: PARTNER, guestFromOrgId: THIRD }] }, HOME)).toBe(false);
    });
    it("an ordinary membership at any other club still blocks", () => {
      expect(clubOwnsUser({ ...base, memberships: [home, lent, { orgId: THIRD, guestFromOrgId: null }] }, HOME)).toBe(false);
    });
    it("a guest row alone, with no ordinary home membership, owns nothing", () => {
      expect(clubOwnsUser({ ...base, memberships: [lent] }, HOME)).toBe(false);
      expect(clubOwnsUser({ ...base, memberships: [lent] }, PARTNER)).toBe(false);
    });
    // Adversarial review, finding 1: a FORMER ordinary member of the
    // partner club who volunteers has his old row relabelled as a guest row
    // (partner-guest.ts writePlace). His history there is not the home
    // club's to take over.
    it("a lent-out row at a club where he has history of his own does not count", () => {
      expect(clubOwnsUser({ ...base, memberships: [home, lent], guestOrgsWithOtherHistory: [PARTNER] }, HOME)).toBe(false);
    });
    it("unknown history fails closed", () => {
      const { guestOrgsWithOtherHistory: _drop, ...noFacts } = base;
      expect(clubOwnsUser({ ...noFacts, memberships: [home, lent] }, HOME)).toBe(false);
      // A record with no lent-out rows never needs the fact.
      expect(clubOwnsUser({ ...noFacts, memberships: [home] }, HOME)).toBe(true);
    });
    it.each([
      ["signed in by phone", { onboarded: true }],
      ["has an OAuth account", { accountCount: 1 }],
      ["has a password", { password: "x" }],
      ["verified an email", { emailVerified: new Date() }],
      ["has a real email", { email: "someone@gmail.com" }],
      ["is a superadmin", { isSuperadmin: true }],
    ])("a player who %s is still never club-owned", (_l, over) => {
      expect(clubOwnsUser({ ...base, ...over, memberships: [home, lent] }, HOME)).toBe(false);
    });
  });

  describe("the actions", () => {
    beforeEach(() => {
      store.orgs.set(PARTNER, { id: PARTNER, approvalStatus: "approved", language: "en" });
      store.orgs.set(THIRD, { id: THIRD, approvalStatus: "approved", language: "en" });
      addUser("c2", { name: null, phoneNumber: "+447700900321" });
      addMem("c2", HOME);
      addMem("c2", PARTNER, { guestFromOrgId: HOME });
    });

    it("the home club can rename its lent-out player (the C2 incident)", async () => {
      expect(await updatePlayerName("c2", HOME, "C2")).toEqual({ ok: true });
      expect(store.users.get("c2")!.name).toBe("C2");
    });

    it("the home club can change his number", async () => {
      expect(await updatePlayerPhone("c2", HOME, "+447700900654")).toEqual({ ok: true, phoneNumber: "+447700900654" });
      expect(store.users.get("c2")!.phoneNumber).toBe("+447700900654");
    });

    it("the partner club he guests at can rename him or change his number: no", async () => {
      // An admin of the partner club acting on its own club.
      addMem(ADMIN, PARTNER, { role: "OWNER" });
      expect(await updatePlayerName("c2", PARTNER, "Hijack")).toEqual({ ok: false, error: en.pg_err_player_owns_account });
      const phone = await updatePlayerPhone("c2", PARTNER, ATTACKER_PHONE);
      expect(phone).toEqual({ ok: false, error: en.phone_err_guest });
      expect(store.users.get("c2")).toMatchObject({ name: null, phoneNumber: "+447700900321" });
    });

    it("a guest row from a different club still blocks the home club", async () => {
      store.mems.find((m) => m.userId === "c2" && m.orgId === PARTNER)!.guestFromOrgId = THIRD;
      expect(await updatePlayerName("c2", HOME, "C2")).toEqual({ ok: false, error: en.pg_err_player_owns_account });
      expect(await updatePlayerPhone("c2", HOME, ATTACKER_PHONE)).toEqual({ ok: false, error: en.pg_err_player_owns_account });
      expect(userUpdate).not.toHaveBeenCalled();
    });

    it("an ordinary membership at another club still blocks the home club", async () => {
      addMem("c2", THIRD);
      expect(await updatePlayerName("c2", HOME, "C2")).toEqual({ ok: false, error: en.pg_err_player_owns_account });
      expect(await updatePlayerPhone("c2", HOME, ATTACKER_PHONE)).toEqual({ ok: false, error: en.pg_err_player_owns_account });
      expect(userUpdate).not.toHaveBeenCalled();
    });

    it("a former member of the partner club, relabelled a guest when he volunteered, stays out of reach (review finding 1)", async () => {
      store.events.push({ userId: "c2", orgId: PARTNER, cause: "self-attendance" });
      expect(await updatePlayerName("c2", HOME, "C2")).toEqual({ ok: false, error: en.pg_err_player_owns_account });
      expect(await updatePlayerPhone("c2", HOME, ATTACKER_PHONE)).toEqual({ ok: false, error: en.pg_err_player_owns_account });
      expect(userUpdate).not.toHaveBeenCalled();
    });

    it("guest-place moves at the partner club (an organiser pick) do not take him away", async () => {
      store.events.push({ userId: "c2", orgId: PARTNER, cause: "partner-ask" }, { userId: "c2", orgId: PARTNER, cause: "organiser-pick" });
      expect(await updatePlayerName("c2", HOME, "C2")).toEqual({ ok: true });
    });

    it("a merge cannot push a lent-out placeholder's partner-club rows onto a record the club does not own (review finding 2)", async () => {
      addMem("victim", HOME); // a real account that is also at this club
      const res = await mergePlayers(HOME, "victim", "c2");
      expect(res).toEqual({ ok: false, error: en.pg_err_player_owns_account });
      expect(mergeCore).not.toHaveBeenCalled();
    });

    it("still works: a lent-out placeholder merged into another of the club's own placeholders", async () => {
      addUser("keep", { name: "Keeper" });
      addMem("keep", HOME);
      expect(await mergePlayers(HOME, "keep", "c2")).toEqual({ ok: true });
      expect(mergeCore).toHaveBeenCalledWith(expect.anything(), "keep", "c2", expect.anything());
    });

    it("once he has signed in himself, the home club cannot rename him or change his number", async () => {
      store.users.get("c2")!.onboarded = true;
      expect(await updatePlayerName("c2", HOME, "C2")).toEqual({ ok: false, error: en.pg_err_player_owns_account });
      expect(await updatePlayerPhone("c2", HOME, ATTACKER_PHONE)).toEqual({ ok: false, error: en.pg_err_player_owns_account });
      expect(userUpdate).not.toHaveBeenCalled();
    });
  });
});
