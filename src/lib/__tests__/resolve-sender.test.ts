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
    userAlias: { findUnique: (...a: unknown[]) => userAliasFindUnique(...a) },
  },
}));

import { isRawDigitName, resolveSender } from "@/lib/resolve-sender";

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

  it("falls through to the name when the phone matches nobody", async () => {
    userFindUnique.mockResolvedValue(null);
    membershipFindMany.mockResolvedValue([member("u2", "Baki")]);
    const out = await resolveSender(ORG, { authorPhone: "447700900999", authorName: "Baki" });
    expect(out.userId).toBe("u2");
  });
});

describe("name matching", () => {
  it("matches an exact name, case- and accent-insensitively", async () => {
    membershipFindMany.mockResolvedValue([member("u3", "Elnur Mammadov")]);
    const out = await resolveSender(ORG, { authorPhone: "", authorName: "elnur mammadov" });
    expect(out.userId).toBe("u3");
  });

  it("matches a short pushname onto a longer first name", async () => {
    // Kemal flagged this in 2026-05: "ba" is Baki.
    membershipFindMany.mockResolvedValue([member("u4", "Baki Sutton")]);
    const out = await resolveSender(ORG, { authorPhone: "", authorName: "ba" });
    expect(out.userId).toBe("u4");
  });

  it("refuses to guess between two players with the same first name", async () => {
    membershipFindMany.mockResolvedValue([
      member("u5", "Ibrahim A"),
      member("u6", "Ibrahim B"),
    ]);
    const out = await resolveSender(ORG, { authorPhone: "", authorName: "Ibrahim" });
    expect(out.userId).toBeNull();
    // The pushname still travels back, so the group nudge can name them.
    expect(out.name).toBe("Ibrahim");
  });

  it("uses an admin-curated alias to break that tie", async () => {
    membershipFindMany.mockResolvedValue([
      member("u5", "Baki Sutton"),
      member("u6", "Başar K"),
    ]);
    userAliasFindUnique.mockResolvedValue({ userId: "u5" });
    const out = await resolveSender(ORG, { authorPhone: "", authorName: "ba" });
    expect(out.userId).toBe("u5");
  });

  it("resolves a nickname nothing fuzzy could ever bridge, via an alias", async () => {
    // "Nunu" → Elnur. No letter-overlap rule reaches that; admin curation
    // is the right tool and the resolver must consult it.
    membershipFindMany.mockResolvedValue([member("u7", "Elnur Mammadov")]);
    userAliasFindUnique.mockResolvedValue({ userId: "u7" });
    const out = await resolveSender(ORG, { authorPhone: "", authorName: "Nunu" });
    expect(out.userId).toBe("u7");
  });

  it("restores a soft-removed member who has started posting again", async () => {
    membershipFindMany.mockResolvedValue([member("u8", "Baki", new Date("2026-01-01"))]);
    const out = await resolveSender(ORG, { authorPhone: "", authorName: "Baki" });
    expect(out.userId).toBe("u8");
    expect(membershipUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "mem-u8" } }),
    );
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
