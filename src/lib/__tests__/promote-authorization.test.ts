/**
 * Unit tests for the promote-from-bench authorisation gate
 * (src/lib/promote-authorization.ts).
 *
 * The gate decides whether a registerFor IN entry may promote a bench
 * player STRAIGHT into the squad (no 👍 confirmation step). It must
 * allow:
 *   - any admin/owner, and
 *   - a self-replace: the sender is one of the OUT targets in the same
 *     registerFor set (they're spending their own slot).
 * It must NOT allow an unrelated non-admin to promote on behalf of a
 * third party.
 *
 * Pure logic — no DB, no LLM. The caller resolves names → userIds.
 */
import { describe, it, expect } from "vitest";
import {
  isPromoteFromBenchAuthorized,
  isSelfReplace,
  type PromoteRegisterEntry,
} from "@/lib/promote-authorization";

const SENDER = "user-sender";
const EHTISHAM = "user-ehtisham";
const AYDIN = "user-aydin";
const BILAL = "user-bilal";

// "replace Ehtisham with Aydın" — Ehtisham OUT, Aydın IN (off bench).
const replacePair = (outUserId: string | null): PromoteRegisterEntry[] => [
  { action: "OUT", userId: outUserId },
  { action: "IN", userId: AYDIN },
];

describe("isPromoteFromBenchAuthorized — admin branch", () => {
  it("authorises ANY admin, regardless of who is being dropped", () => {
    expect(
      isPromoteFromBenchAuthorized({
        senderUserId: SENDER,
        senderIsAdmin: true,
        entries: replacePair(EHTISHAM), // dropping someone else
      }),
    ).toBe(true);
  });

  it("authorises an admin even with no OUT entry (plain promote)", () => {
    expect(
      isPromoteFromBenchAuthorized({
        senderUserId: SENDER,
        senderIsAdmin: true,
        entries: [{ action: "IN", userId: AYDIN }],
      }),
    ).toBe(true);
  });

  it("authorises an admin even when the sender is unresolved", () => {
    expect(
      isPromoteFromBenchAuthorized({
        senderUserId: null,
        senderIsAdmin: true,
        entries: replacePair(EHTISHAM),
      }),
    ).toBe(true);
  });
});

describe("isPromoteFromBenchAuthorized — self-replace branch", () => {
  it("authorises a non-admin who is the OUT target (replace me with Aydın)", () => {
    // Ehtisham (non-admin) drops himself for Aydın.
    expect(
      isPromoteFromBenchAuthorized({
        senderUserId: EHTISHAM,
        senderIsAdmin: false,
        entries: replacePair(EHTISHAM),
      }),
    ).toBe(true);
  });

  it("authorises self-replace when the sender is one of MULTIPLE OUT targets", () => {
    expect(
      isPromoteFromBenchAuthorized({
        senderUserId: EHTISHAM,
        senderIsAdmin: false,
        entries: [
          { action: "OUT", userId: BILAL },
          { action: "OUT", userId: EHTISHAM },
          { action: "IN", userId: AYDIN },
        ],
      }),
    ).toBe(true);
  });
});

describe("isPromoteFromBenchAuthorized — unrelated third party is BLOCKED", () => {
  it("denies a non-admin dropping SOMEONE ELSE (Bilal: replace Ehtisham with Aydın)", () => {
    // Bilal is neither admin nor the OUT target → cannot promote Aydın.
    expect(
      isPromoteFromBenchAuthorized({
        senderUserId: BILAL,
        senderIsAdmin: false,
        entries: replacePair(EHTISHAM),
      }),
    ).toBe(false);
  });

  it("denies a non-admin with no OUT entry at all (plain 'promote Aydın')", () => {
    expect(
      isPromoteFromBenchAuthorized({
        senderUserId: SENDER,
        senderIsAdmin: false,
        entries: [{ action: "IN", userId: AYDIN }],
      }),
    ).toBe(false);
  });

  it("denies when the OUT target name could not be resolved (null userId)", () => {
    // An unresolved OUT must never accidentally read as self.
    expect(
      isPromoteFromBenchAuthorized({
        senderUserId: SENDER,
        senderIsAdmin: false,
        entries: replacePair(null),
      }),
    ).toBe(false);
  });

  it("denies when the sender is unresolved, even if an OUT userId is null", () => {
    expect(
      isPromoteFromBenchAuthorized({
        senderUserId: null,
        senderIsAdmin: false,
        entries: replacePair(null),
      }),
    ).toBe(false);
  });
});

describe("isSelfReplace", () => {
  it("is true only when a resolved sender matches a resolved OUT target", () => {
    expect(isSelfReplace(EHTISHAM, replacePair(EHTISHAM))).toBe(true);
    expect(isSelfReplace(BILAL, replacePair(EHTISHAM))).toBe(false);
  });

  it("never matches a null sender", () => {
    expect(isSelfReplace(null, replacePair(null))).toBe(false);
    expect(isSelfReplace(null, replacePair(EHTISHAM))).toBe(false);
  });

  it("ignores IN/BENCH entries — only OUT targets count", () => {
    // Sender appears as the IN target (nonsensical), not OUT → not self-replace.
    expect(
      isSelfReplace(AYDIN, [
        { action: "OUT", userId: EHTISHAM },
        { action: "IN", userId: AYDIN },
      ]),
    ).toBe(false);
  });
});
