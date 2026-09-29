/**
 * THE RULES for linking a joiner to a placeholder (2026-09-29).
 *
 * The incident, Sutton FC, 29 Sept: at 07:57 Wasim wrote "Hamzah in".
 * Hamzah was not a Sutton member, so the third-party registration made a
 * NEW phoneless "Hamzah", confirmed him and he got a team slot. A real
 * "Hamzah" with a phone number already existed (another club). At 22:51
 * the admin added him to the WhatsApp group; group-join matched him by
 * phone and gave him a Sutton membership of his own. Two "Hamzah" rows on
 * /admin/players, one with the phone, one with the match.
 *
 * These rules decide, when a person with a known phone joins a club, what
 * happens to a phoneless placeholder of the same name:
 *   - exactly one placeholder, exact name (or alias) → merge it into them;
 *   - more than one, or only a partial match → suggest, never merge;
 *   - a placeholder with a phone of its own → never (phone vs phone);
 *   - a placeholder that is also a member of another club → never.
 *
 * Pure: no database. The DB half is `placeholder-link.ts` and the e2e
 * replay is `e2e/api/joiner-links-placeholder.spec.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  decidePlaceholderLink,
  findDuplicateSuggestions,
  isLinkablePlaceholder,
  matchNames,
  placeholderAddedAt,
  type PlaceholderCandidate,
  type RosterRow,
} from "@/lib/placeholder-link-rules";

const JOINER = { userId: "u-phone-hamzah", phoneNumber: "+447376548222", names: ["Hamzah"] };

function placeholder(over: Partial<PlaceholderCandidate> = {}): PlaceholderCandidate {
  return {
    userId: "u-ghost-hamzah",
    name: "Hamzah",
    phoneNumber: null,
    email: "provisional+hamzah-mg1abc@matchtime.local",
    provisionallyAddedAt: new Date("2026-09-29T07:57:00Z"),
    leftAt: null,
    createdAt: new Date("2026-09-29T07:57:00Z"),
    clubCount: 1,
    aliases: [],
    ...over,
  };
}

describe("matchNames", () => {
  it("an exact name, folded for case and accents, is exact", () => {
    expect(matchNames(["Hamzah"], ["hamzah"])).toBe("exact");
    expect(matchNames(["Ayşe Yılmaz"], ["ayse yılmaz"])).toBe("exact");
    expect(matchNames(["  Hamzah  "], ["~Hamzah"])).toBe("exact");
  });

  it("a shared first name or a prefix is only partial", () => {
    expect(matchNames(["Hamzah Khan"], ["Hamzah"])).toBe("partial");
    expect(matchNames(["Hamzah"], ["Hamza"])).toBe("partial");
  });

  it("different names do not match", () => {
    expect(matchNames(["Hamzah"], ["Wasim"])).toBeNull();
  });

  it("an empty or one-letter name never matches", () => {
    expect(matchNames([""], [""])).toBeNull();
    expect(matchNames(["H"], ["H"])).toBeNull();
    expect(matchNames([], ["Hamzah"])).toBeNull();
  });

  it("any one of several names on either side can match exactly (aliases)", () => {
    expect(matchNames(["Hamzah Khan", "hamzah"], ["Hamzah"])).toBe("exact");
    expect(matchNames(["Hamzah Khan"], ["H", "hamzah khan"])).toBe("exact");
  });
});

describe("isLinkablePlaceholder", () => {
  it("a phoneless, single-club, provisional member is linkable", () => {
    expect(isLinkablePlaceholder(placeholder())).toBe(true);
  });

  it("a provisional+ email alone is enough (an admin edit clears provisionallyAddedAt)", () => {
    expect(isLinkablePlaceholder(placeholder({ provisionallyAddedAt: null }))).toBe(true);
  });

  it("a provisionallyAddedAt alone is enough", () => {
    expect(isLinkablePlaceholder(placeholder({ email: "someone@example.com" }))).toBe(true);
  });

  it("a phoneless member who was never a placeholder (a real sign-up) is not", () => {
    expect(
      isLinkablePlaceholder(placeholder({ email: "hamzah@example.com", provisionallyAddedAt: null })),
    ).toBe(false);
  });

  it("a member with a phone is never a placeholder", () => {
    expect(isLinkablePlaceholder(placeholder({ phoneNumber: "+447700900111" }))).toBe(false);
  });

  it("a placeholder that is also a member of another club is not linkable", () => {
    expect(isLinkablePlaceholder(placeholder({ clubCount: 2 }))).toBe(false);
  });

  it("a removed placeholder (leftAt) is not linkable", () => {
    expect(isLinkablePlaceholder(placeholder({ leftAt: new Date() }))).toBe(false);
  });
});

describe("decidePlaceholderLink", () => {
  it("THE INCIDENT: one placeholder with the exact name merges", () => {
    const ghost = placeholder();
    const d = decidePlaceholderLink(JOINER, [ghost]);
    expect(d).toEqual({ kind: "merge", placeholder: ghost });
  });

  it("an alias of the placeholder in this club counts as an exact match", () => {
    const ghost = placeholder({ name: "Hamz", aliases: ["hamzah"] });
    expect(decidePlaceholderLink(JOINER, [ghost]).kind).toBe("merge");
  });

  it("two exact candidates suggest, and never merge", () => {
    const a = placeholder({ userId: "g1" });
    const b = placeholder({ userId: "g2" });
    const d = decidePlaceholderLink(JOINER, [a, b]);
    expect(d.kind).toBe("suggest");
    if (d.kind === "suggest") expect(d.candidates.map((c) => c.userId)).toEqual(["g1", "g2"]);
  });

  it("an exact candidate plus a partial one is still ambiguous: suggest", () => {
    const exact = placeholder({ userId: "g1" });
    const partial = placeholder({ userId: "g2", name: "Hamza" });
    expect(decidePlaceholderLink(JOINER, [exact, partial]).kind).toBe("suggest");
  });

  it("a single partial match suggests, and never merges", () => {
    const d = decidePlaceholderLink({ ...JOINER, names: ["Hamzah Khan"] }, [placeholder()]);
    expect(d.kind).toBe("suggest");
  });

  it("PHONE VS PHONE: a same-name member with a phone is never merged or suggested", () => {
    const d = decidePlaceholderLink(JOINER, [placeholder({ phoneNumber: "+447700900111" })]);
    expect(d).toEqual({ kind: "none" });
  });

  it("a joiner without a phone never links anything", () => {
    const d = decidePlaceholderLink({ ...JOINER, phoneNumber: null }, [placeholder()]);
    expect(d).toEqual({ kind: "none" });
  });

  it("CROSS-CLUB: a placeholder that also belongs to another club is never merged", () => {
    const d = decidePlaceholderLink(JOINER, [placeholder({ clubCount: 2 })]);
    expect(d).toEqual({ kind: "none" });
  });

  it("the joiner is never a candidate for itself", () => {
    const d = decidePlaceholderLink(JOINER, [placeholder({ userId: JOINER.userId })]);
    expect(d).toEqual({ kind: "none" });
  });

  it("no name on the joiner: nothing to match", () => {
    const d = decidePlaceholderLink({ ...JOINER, names: [] }, [placeholder()]);
    expect(d).toEqual({ kind: "none" });
  });

  it("an unrelated name: nothing", () => {
    const d = decidePlaceholderLink(JOINER, [placeholder({ name: "Wasim" })]);
    expect(d).toEqual({ kind: "none" });
  });
});

describe("placeholderAddedAt", () => {
  it("is the provisional stamp when there is one, else the user's creation", () => {
    const stamp = new Date("2026-09-29T07:57:00Z");
    const created = new Date("2026-09-01T00:00:00Z");
    expect(placeholderAddedAt(placeholder({ provisionallyAddedAt: stamp, createdAt: created }))).toEqual(stamp);
    expect(placeholderAddedAt(placeholder({ provisionallyAddedAt: null, createdAt: created }))).toEqual(created);
  });
});

describe("findDuplicateSuggestions (the /admin/players list)", () => {
  function row(over: Partial<RosterRow>): RosterRow {
    return {
      id: "x",
      name: null,
      phoneNumber: null,
      email: "x@example.com",
      provisionallyAddedAt: null,
      leftAt: null,
      createdAt: new Date("2026-09-01T00:00:00Z"),
      clubCount: 1,
      aliases: [],
      ...over,
    };
  }
  const phoneHamzah = row({ id: "p1", name: "Hamzah Khan", phoneNumber: "+447376548222" });
  const ghost = row({
    id: "g1",
    name: "Hamzah",
    email: "provisional+hamzah-1@matchtime.local",
    provisionallyAddedAt: new Date("2026-09-29T07:57:00Z"),
  });

  it("pairs a placeholder with a phone member of a matching name", () => {
    expect(findDuplicateSuggestions([phoneHamzah, ghost])).toEqual([
      { placeholderId: "g1", placeholderName: "Hamzah", keepId: "p1", keepName: "Hamzah Khan" },
    ]);
  });

  it("never pairs two phone members", () => {
    const other = row({ id: "p2", name: "Hamzah", phoneNumber: "+447700900111" });
    expect(findDuplicateSuggestions([phoneHamzah, other])).toEqual([]);
  });

  it("never suggests a placeholder that belongs to another club too", () => {
    expect(findDuplicateSuggestions([phoneHamzah, { ...ghost, clubCount: 2 }])).toEqual([]);
  });

  it("ignores former members on either side", () => {
    expect(findDuplicateSuggestions([{ ...phoneHamzah, leftAt: new Date() }, ghost])).toEqual([]);
    expect(findDuplicateSuggestions([phoneHamzah, { ...ghost, leftAt: new Date() }])).toEqual([]);
  });

  it("does not pair unrelated names", () => {
    expect(findDuplicateSuggestions([row({ id: "p3", name: "Wasim", phoneNumber: "+447700900222" }), ghost])).toEqual([]);
  });
});
