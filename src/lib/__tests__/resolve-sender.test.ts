/**
 * `resolveSender` — the function that decides WHO sent a WhatsApp
 * message, and therefore whether their attendance is recorded at all.
 *
 * ── Why this file exists ─────────────────────────────────────────────
 *
 * The 2026-08-30 independent audit, on the attribution hole it found:
 *
 *   "Per house TDD rules: write the failing tests first — `resolveSender`
 *    is currently untested and not exported (`route.ts:1629`), which is
 *    why this hole survived a review."
 *
 * It lived in the middle of a 3,500-line Next.js route handler, where
 * Next's own type checking forbids exporting anything but the HTTP verbs,
 * so it could not be imported and could not be tested. It has been lifted
 * into `src/lib/resolve-sender.ts` for exactly that reason, and this file
 * is the test that should have existed.
 *
 * The most important case below is the one that returns NOTHING: a
 * message with no phone and no name. That path returns HTTP 200, writes
 * no attendance, and was invisible to every queue built to catch it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const userFindUnique = vi.fn();
const userCreate = vi.fn();
const membershipFindMany = vi.fn();
const membershipUpdate = vi.fn();
const membershipUpsert = vi.fn();
const userAliasFindUnique = vi.fn();
const userAliasFindMany = vi.fn();
const userUpdateMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...a),
      create: (...a: unknown[]) => userCreate(...a),
      updateMany: (...a: unknown[]) => userUpdateMany(...a),
    },
    membership: {
      findMany: (...a: unknown[]) => membershipFindMany(...a),
      update: (...a: unknown[]) => membershipUpdate(...a),
      upsert: (...a: unknown[]) => membershipUpsert(...a),
    },
    userAlias: {
      findUnique: (...a: unknown[]) => userAliasFindUnique(...a),
      findMany: (...a: unknown[]) => userAliasFindMany(...a),
    },
  },
}));

import { isRawDigitName, resolveSender, resolveSenders } from "@/lib/resolve-sender";
import type { PersonPick, PersonPicker, WhoRequest } from "@/lib/pipeline/who-is-who";
import { currentAiBudget, runWithAiBudget } from "@/lib/ai-budget-context";

const ORG = "org-1";

function member(id: string, name: string | null, leftAt: Date | null = null) {
  return { id: `mem-${id}`, userId: id, leftAt, user: { id, name } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  userFindUnique.mockResolvedValue(null);
  membershipFindMany.mockResolvedValue([]);
  userAliasFindUnique.mockResolvedValue(null);
  userAliasFindMany.mockResolvedValue([]);
});

describe("THE HOLE: a sender with neither a phone nor a name", () => {
  it("resolves to nobody, and provisions nobody", async () => {
    // This is the whole finding. `phoneFromAuthor` returns "" for any
    // @lid sender by construction, and `authorName` is null whenever the
    // contact lookup died. The message still returns HTTP 200 with
    // handledBy "llm", so the Pi cannot tell anything went wrong, and no
    // attendance is written because every write is gated on a resolved
    // user.
    const out = await resolveSender(ORG, { authorPhone: "", authorName: null });
    expect(out).toEqual({ userId: null, name: null, phone: null });
    expect(userCreate).not.toHaveBeenCalled();
    expect(membershipUpsert).not.toHaveBeenCalled();
  });

  it("does not invent a member from an empty name", async () => {
    const out = await resolveSender(ORG, { authorPhone: "", authorName: "   " });
    expect(out.userId).toBeNull();
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("never surfaces a bare @lid number as a display name", async () => {
    // RC4 of the 2026-06-12 Sutton Lads incident: a raw number showed up
    // as a player name in a group post. Downstream replies address the
    // sender by this field.
    const out = await resolveSender(ORG, {
      authorPhone: "",
      authorName: "158055467598020",
    });
    expect(out.userId).toBeNull();
    expect(out.name).toBeNull();
  });
});

describe("a nameless placeholder takes its WhatsApp name on its first post (2026-09-30)", () => {
  // Someone added to the group arrives as a phone with no name (the join
  // event carries none). The organiser was asked to type the name in. When
  // that person first posts, their WhatsApp name is on the message: use it.
  it("phone matches a user with NO name → the pushname is written and returned", async () => {
    userFindUnique.mockResolvedValue({ id: "u9", name: null });
    userUpdateMany.mockResolvedValue({ count: 1 });
    const out = await resolveSender(ORG, { authorPhone: "447546111893", authorName: "  Ali Veli " });
    expect(userUpdateMany).toHaveBeenCalledWith({ where: { id: "u9", name: null }, data: { name: "Ali Veli" } });
    expect(out).toEqual({ userId: "u9", name: "Ali Veli", phone: "+447546111893" });
  });

  it("a user who HAS a name keeps it, whatever their WhatsApp name says", async () => {
    userFindUnique.mockResolvedValue({ id: "u9", name: "Ali" });
    const out = await resolveSender(ORG, { authorPhone: "447546111893", authorName: "Ali the Wall" });
    expect(userUpdateMany).not.toHaveBeenCalled();
    expect(out.name).toBe("Ali");
  });

  it.each([["447546111893"], ["+44 7546 111893"], ["x"], ["Match Time"], [""]])(
    "never writes %j as a name",
    async (pushname) => {
      userFindUnique.mockResolvedValue({ id: "u9", name: null });
      const out = await resolveSender(ORG, { authorPhone: "447546111893", authorName: pushname });
      expect(userUpdateMany).not.toHaveBeenCalled();
      expect(out.name).toBeNull();
    },
  );

  it("a failed write still resolves the sender (attendance must not be lost)", async () => {
    userFindUnique.mockResolvedValue({ id: "u9", name: null });
    userUpdateMany.mockRejectedValue(new Error("db"));
    const out = await resolveSender(ORG, { authorPhone: "447546111893", authorName: "Ali" });
    expect(out.userId).toBe("u9");
  });
});

describe("phone first", () => {
  it("resolves a bare-digits phone by adding the +", async () => {
    userFindUnique.mockResolvedValue({ id: "u1", name: "Kemal" });
    const out = await resolveSender(ORG, { authorPhone: "447700900123", authorName: null });
    expect(out).toEqual({ userId: "u1", name: "Kemal", phone: "+447700900123" });
  });

  it("falls through to who-is-who on the name when the phone matches nobody", async () => {
    userFindUnique.mockResolvedValue(null);
    membershipFindMany.mockResolvedValue([member("u2", "Baki")]);
    // The unit-test picker is the name-based stand-in: "Baki" is Baki.
    const out = await resolveSender(ORG, { authorPhone: "447700900999", authorName: "Baki" });
    expect(out.userId).toBe("u2");
  });
});

// WITHOUT A PHONE, WHO-IS-WHO (review of #574, finding 4). The sender's
// WhatsApp name is put to the model with the club's members and the
// message; code never matches it by spelling. These pin what the resolver
// does with each answer, with the picker faked.
describe("a phoneless sender: who-is-who's pick, never a match by spelling", () => {
  const answering = (answers: Record<string, PersonPick>) => {
    const seen: WhoRequest[] = [];
    const identify: PersonPicker = async (req) => {
      seen.push(req);
      return {
        picks: new Map(req.messages.map((m) => [m.id, new Map(m.refs.map((r) => [r, answers[r] ?? { kind: "unidentified" as const, why: "no answer" }]))])),
        usage: null,
        degradations: [],
      };
    };
    return { identify, seen };
  };

  it("a member the model is sure of is the sender, and it read the message", async () => {
    membershipFindMany.mockResolvedValue([member("u4", "Baki Sutton")]);
    const { identify, seen } = answering({ ba: { kind: "member", userId: "u4" } });
    const out = await resolveSender(ORG, { authorPhone: "", authorName: "ba", body: "IN" }, { identify });
    expect(out.userId).toBe("u4");
    expect(seen[0].messages[0]).toMatchObject({ body: "IN", refs: ["ba"] });
  });

  it("THE CASE: a non-member David saying 'I'm out' is not Davide: the model says nobody, a new provisional member", async () => {
    membershipFindMany.mockResolvedValue([member("u-davide", "Davide De Sousa")]);
    userCreate.mockResolvedValue({ id: "new-david", name: "David" });
    const { identify } = answering({ David: { kind: "none" } });
    const out = await resolveSender(ORG, { authorPhone: "", authorName: "David", body: "I'm out" }, { identify });
    expect(out.userId).toBe("new-david");
    expect(out.userId).not.toBe("u-davide");
  });

  it("RED on main: a first-name PREFIX no longer resolves anybody ('Dav' is not Davide without the model)", async () => {
    membershipFindMany.mockResolvedValue([member("u-davide", "Davide De Sousa")]);
    const { identify } = answering({});
    const out = await resolveSender(ORG, { authorPhone: "", authorName: "Dav", body: "out" }, { identify });
    expect(out.userId).toBeNull();
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("two members it could be, or not sure: an UNKNOWN sender, nobody provisioned (fails closed)", async () => {
    membershipFindMany.mockResolvedValue([member("u5", "Ibrahim A"), member("u6", "Ibrahim B")]);
    const { identify } = answering({ Ibrahim: { kind: "ambiguous", userIds: ["u5", "u6"] } });
    const out = await resolveSender(ORG, { authorPhone: "", authorName: "Ibrahim" }, { identify });
    expect(out).toEqual({ userId: null, name: "Ibrahim", phone: null });
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("the club's aliases are shown to the model with each member; former members are marked", async () => {
    membershipFindMany.mockResolvedValue([member("u7", "Elnur Mammadov"), member("u8", "Baki", new Date("2026-01-01"))]);
    userAliasFindMany.mockResolvedValue([{ userId: "u7", alias: "nunu" }]);
    const { identify, seen } = answering({ Nunu: { kind: "member", userId: "u7" } });
    const out = await resolveSender(ORG, { authorPhone: "", authorName: "Nunu" }, { identify });
    expect(out.userId).toBe("u7");
    expect(seen[0].roster.find((m) => m.userId === "u7")?.aliases).toEqual(["nunu"]);
    expect(seen[0].roster.find((m) => m.userId === "u8")?.former).toBe(true);
  });

  it("restores a soft-removed member the model recognises", async () => {
    membershipFindMany.mockResolvedValue([member("u8", "Baki", new Date("2026-01-01"))]);
    const { identify } = answering({ Baki: { kind: "member", userId: "u8" } });
    const out = await resolveSender(ORG, { authorPhone: "", authorName: "Baki" }, { identify });
    expect(out.userId).toBe("u8");
    expect(membershipUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "mem-u8" } }));
  });

  it("a batch asks once for every phoneless sender, and never for one found by phone", async () => {
    userFindUnique.mockImplementation(async (a: { where: { phoneNumber: string } }) =>
      a.where.phoneNumber === "+447700900123" ? { id: "u1", name: "Kemal" } : null,
    );
    membershipFindMany.mockResolvedValue([member("u4", "Baki Sutton"), member("u3", "Elnur Mammadov")]);
    const { identify, seen } = answering({ ba: { kind: "member", userId: "u4" }, Elnur: { kind: "member", userId: "u3" } });
    const out = await resolveSenders(
      ORG,
      [
        { waMessageId: "a", authorPhone: "447700900123", authorName: "Kemal Ediz" },
        { waMessageId: "b", authorPhone: "", authorName: "ba", body: "IN" },
        { waMessageId: "c", authorPhone: "", authorName: "Elnur", body: "out" },
      ],
      { identify },
    );
    expect(seen).toHaveLength(1);
    // One entry per distinct WhatsApp name, marked as a WhatsApp name.
    expect(seen[0].messages.map((m) => m.refs)).toEqual([["ba"], ["Elnur"]]);
    expect(seen[0].messages.every((m) => m.waNames === true)).toBe(true);
    expect([...out.values()].map((s) => s.userId)).toEqual(["u1", "u4", "u3"]);
  });

  // ── Round 3 of the review of #574 ──

  it("B1: one new sender's 'IN' then '+1' is ONE provisional member, not two", async () => {
    userCreate.mockResolvedValue({ id: "new-hamzah", name: "Hamzah" });
    const { identify, seen } = answering({ Hamzah: { kind: "none" } });
    const out = await resolveSenders(
      ORG,
      [
        { waMessageId: "a", authorPhone: "", authorName: "Hamzah", body: "IN" },
        { waMessageId: "b", authorPhone: "", authorName: "Hamzah ", body: "+1" },
      ],
      { identify },
    );
    expect(seen[0].messages).toHaveLength(1);
    expect(userCreate).toHaveBeenCalledTimes(1);
    expect(out.get("a")?.userId).toBe("new-hamzah");
    expect(out.get("b")?.userId).toBe("new-hamzah");
  });

  it("B3: a call refused by the daily cap is asked once more INSIDE the attendance overflow", async () => {
    membershipFindMany.mockResolvedValue([member("u4", "Baki Sutton")]);
    const overflowSeen: boolean[] = [];
    let n = 0;
    const identify: PersonPicker = async (req) => {
      overflowSeen.push(currentAiBudget()?.overflow ?? false);
      n += 1;
      if (n === 1) return { picks: new Map(), usage: null, failed: "budget", degradations: ["refused"] };
      return { picks: new Map(req.messages.map((m) => [m.id, new Map([[m.refs[0], { kind: "member", userId: "u4" } as PersonPick]])])), usage: null, degradations: [] };
    };
    const ledger = { reserve: vi.fn(), settle: vi.fn(), release: vi.fn() };
    const out = await runWithAiBudget("org-1", ledger as never, () =>
      resolveSenders(ORG, [{ waMessageId: "a", authorPhone: "", authorName: "Baki Sutton", body: "IN" }], { identify }),
    );
    expect(overflowSeen).toEqual([false, true]);
    expect(out.get("a")?.userId).toBe("u4");
  });

  it("B3: a call that FAILED (not refused) is not re-asked here: the picker already retried it; the sender is unknown", async () => {
    membershipFindMany.mockResolvedValue([member("u4", "Baki Sutton")]);
    const identify = vi.fn<PersonPicker>(async () => ({ picks: new Map(), usage: null, failed: "error", degradations: ["overloaded"] }));
    const out = await resolveSenders(ORG, [{ waMessageId: "a", authorPhone: "", authorName: "Baki Sutton", body: "IN" }], { identify });
    expect(identify).toHaveBeenCalledTimes(1);
    expect(out.get("a")?.userId).toBeNull();
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("B4: a sender with an unknown phone surely placed on a phoneless PROVISIONAL member: the member takes the phone", async () => {
    membershipFindMany.mockResolvedValue([
      { ...member("u-hamzah", "Hamzah Ali"), provisionallyAddedAt: new Date("2026-11-01"), user: { id: "u-hamzah", name: "Hamzah Ali", phoneNumber: null } },
    ]);
    userUpdateMany.mockResolvedValue({ count: 1 });
    const { identify } = answering({ "Hamzah Ali": { kind: "member", userId: "u-hamzah" } });
    const out = await resolveSenders(ORG, [{ waMessageId: "a", authorPhone: "447700900555", authorName: "Hamzah Ali", body: "IN" }], { identify });
    expect(userUpdateMany).toHaveBeenCalledWith({ where: { id: "u-hamzah", phoneNumber: null }, data: { phoneNumber: "+447700900555" } });
    expect(out.get("a")).toEqual({ userId: "u-hamzah", name: "Hamzah Ali", phone: "+447700900555" });
  });

  it("B4: a member who is not provisional, or already has a phone, never takes one", async () => {
    membershipFindMany.mockResolvedValue([
      { ...member("u-a", "Ali Kaya"), provisionallyAddedAt: null, user: { id: "u-a", name: "Ali Kaya", phoneNumber: null } },
      { ...member("u-b", "Bilal"), provisionallyAddedAt: new Date(), user: { id: "u-b", name: "Bilal", phoneNumber: "+447700900999" } },
    ]);
    const { identify } = answering({ "Ali Kaya": { kind: "member", userId: "u-a" }, Bilal: { kind: "member", userId: "u-b" } });
    await resolveSenders(
      ORG,
      [
        { waMessageId: "a", authorPhone: "447700900555", authorName: "Ali Kaya", body: "IN" },
        { waMessageId: "b", authorPhone: "447700900556", authorName: "Bilal", body: "IN" },
      ],
      { identify },
    );
    expect(userUpdateMany).not.toHaveBeenCalled();
  });
});

describe("provisioning", () => {
  it("creates a provisional member for a genuinely new name", async () => {
    membershipFindMany.mockResolvedValue([member("u9", "Baki")]);
    userCreate.mockResolvedValue({ id: "new-1", name: "Shahrokh" });
    const out = await resolveSender(ORG, { authorPhone: "", authorName: "Shahrokh" });
    expect(out.userId).toBe("new-1");
    expect(membershipUpsert).toHaveBeenCalled();
  });

  it("refuses to provision a two-character pushname", async () => {
    // Almost always a truncation of a name already on the roster, and
    // provisioning it makes a ghost the admin has to merge away.
    membershipFindMany.mockResolvedValue([]);
    const out = await resolveSender(ORG, { authorPhone: "", authorName: "ba" });
    expect(userCreate).not.toHaveBeenCalled();
    expect(out.userId).toBeNull();
  });

  it("refuses to provision the bot itself", async () => {
    membershipFindMany.mockResolvedValue([]);
    await resolveSender(ORG, { authorPhone: "", authorName: "Match Time" });
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("provisions a raw-digit name under a neutral placeholder, never the digits", async () => {
    membershipFindMany.mockResolvedValue([]);
    userCreate.mockResolvedValue({ id: "new-2", name: "New player" });
    // A raw-digit name is refused as an IDENTITY above, so this exercises
    // the provisioning helper directly through a name that survives the
    // digit guard on its way in.
    const out = await resolveSender(ORG, {
      authorPhone: "447700900123",
      authorName: "158055467598020",
    });
    if (userCreate.mock.calls.length > 0) {
      expect(userCreate.mock.calls[0][0].data.name).toBe("New player");
    }
    expect(out.name).not.toBe("158055467598020");
  });

  it("survives a database error while provisioning", async () => {
    membershipFindMany.mockResolvedValue([]);
    userCreate.mockRejectedValue(new Error("unique constraint"));
    const out = await resolveSender(ORG, { authorPhone: "", authorName: "Shahrokh" });
    expect(out.userId).toBeNull();
  });
});

describe("isRawDigitName", () => {
  it("recognises a bare lid, with or without decoration", () => {
    expect(isRawDigitName("158055467598020")).toBe(true);
    expect(isRawDigitName("158055467598020@lid")).toBe(true);
    expect(isRawDigitName("+44 7700 900123")).toBe(true);
  });

  it("does not mistake a real name for one", () => {
    expect(isRawDigitName("Baki")).toBe(false);
    expect(isRawDigitName("David 67")).toBe(false);
    expect(isRawDigitName("")).toBe(false);
  });
});
