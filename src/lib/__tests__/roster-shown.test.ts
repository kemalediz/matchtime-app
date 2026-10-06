/**
 * The pure half of "do not post the same squad twice" (2026-10-06).
 * See `src/lib/roster-shown.ts` for the incident.
 */
import { describe, it, expect } from "vitest";
import {
  ROSTER_QUIET_MS,
  ROSTER_SHOWN_KIND,
  RECRUIT_ACK_KIND,
  hasRosterBlock,
  recruitAckKey,
  recruitAckRecently,
  rosterShownKey,
  rosterShownRecently,
  squadFingerprint,
  stripRosterBlock,
} from "@/lib/roster-shown";

const NAMES = Array.from({ length: 13 }, (_, i) => `Player ${i + 1}`);
const ROSTER = [...NAMES.map((n, i) => `${i + 1}. ${n}`), "14. 🥁"].join("\n");

/** The 08:00 post of Tue 6 Oct 2026, in the shape the composer wrote it. */
const MORNING =
  "☀️ Squad update — 1 more and Tuesday 7-a-side is full. Kicking off 21:30 at Goals North Cheam. Who's in?\n\n" +
  "If we don't find 1 more, we could switch to 5-a-side (10 players): Player 11 + Player 12 + Player 13 go on the bench. Admins can rebook and flip it in the portal.\n\n" +
  `*Playing tonight:*\n${ROSTER}`;

describe("stripRosterBlock", () => {
  it("drops the header and the numbered rows, and keeps every other line", () => {
    expect(stripRosterBlock(MORNING)).toBe(
      "☀️ Squad update — 1 more and Tuesday 7-a-side is full. Kicking off 21:30 at Goals North Cheam. Who's in?\n\n" +
        "If we don't find 1 more, we could switch to 5-a-side (10 players): Player 11 + Player 12 + Player 13 go on the bench. Admins can rebook and flip it in the portal.",
    );
  });

  it("drops a bench block too, even a bench of one", () => {
    const text = `Need 1 more.\n\n*Playing tonight:*\n${ROSTER}\n\n*Bench (1):*\n1. Ben Bench`;
    expect(stripRosterBlock(text)).toBe("Need 1 more.");
  });

  it("keeps a line that follows the roster", () => {
    const text = `Need 1 more.\n\n*Playing tonight:*\n${ROSTER}\n\nTentative: Sam (will play if nobody steps in)`;
    expect(stripRosterBlock(text)).toBe("Need 1 more.\n\nTentative: Sam (will play if nobody steps in)");
  });

  it("handles the static block's own header, and a Turkish one", () => {
    expect(stripRosterBlock(`🗓 *Tuesday 7-a-side* — need *1 more*.\n\n*Confirmed (13/14):*\n${ROSTER}`)).toBe(
      "🗓 *Tuesday 7-a-side* — need *1 more*.",
    );
    expect(stripRosterBlock(`1 kişi daha lazım.\n\n*Bu akşam oynayanlar:*\n${ROSTER}\n\n*Yedekler (1):*\n1. Ali`)).toBe(
      "1 kişi daha lazım.",
    );
  });

  it("leaves a text with no roster exactly as it was", () => {
    const text = "☀️ Still *1 short* for tonight's *Tuesday 7-a-side*. Any takers? 👀";
    expect(stripRosterBlock(text)).toBe(text);
    expect(hasRosterBlock(text)).toBe(false);
    expect(hasRosterBlock(MORNING)).toBe(true);
  });

  it("does not eat a single numbered sentence that is not under a header", () => {
    const text = "Two things today.\n1. Bring a ball.\n\nSee you there.";
    expect(stripRosterBlock(text)).toBe(text);
  });
});

describe("squadFingerprint", () => {
  const base = { confirmedUserIds: ["a", "b", "c"], benchUserIds: ["x"], maxPlayers: 14 };

  it("is the same for the same squad in any order", () => {
    expect(squadFingerprint({ ...base, confirmedUserIds: ["c", "a", "b"] })).toBe(squadFingerprint(base));
  });

  it("changes when a player leaves, joins, the bench changes or the size changes", () => {
    const fp = squadFingerprint(base);
    expect(squadFingerprint({ ...base, confirmedUserIds: ["a", "b"] })).not.toBe(fp);
    expect(squadFingerprint({ ...base, confirmedUserIds: ["a", "b", "d"] })).not.toBe(fp);
    expect(squadFingerprint({ ...base, benchUserIds: [] })).not.toBe(fp);
    expect(squadFingerprint({ ...base, maxPlayers: 10 })).not.toBe(fp);
  });

  it("is safe inside a colon-delimited key", () => {
    expect(squadFingerprint(base)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("the two recent-post checks", () => {
  const now = new Date("2026-10-06T07:00:00.000Z"); // 08:00 London
  const at = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60_000);
  const fp = "0123456789abcdef";

  it("a roster for the same squad inside three hours counts", () => {
    const rows = [{ key: rosterShownKey("m1", fp, at(32)), kind: ROSTER_SHOWN_KIND, createdAt: at(32) }];
    expect(rosterShownRecently(rows, { matchId: "m1", fingerprint: fp, now })).toBe(true);
  });

  it("a different squad, another match, or an old post does not", () => {
    const row = (key: string, minsAgo: number) => ({ key, kind: ROSTER_SHOWN_KIND, createdAt: at(minsAgo) });
    expect(rosterShownRecently([row(rosterShownKey("m1", "ffffffffffffffff", at(32)), 32)], { matchId: "m1", fingerprint: fp, now })).toBe(false);
    expect(rosterShownRecently([row(rosterShownKey("m2", fp, at(32)), 32)], { matchId: "m1", fingerprint: fp, now })).toBe(false);
    expect(rosterShownRecently([row(rosterShownKey("m1", fp, at(181)), 181)], { matchId: "m1", fingerprint: fp, now })).toBe(false);
    expect(ROSTER_QUIET_MS).toBe(3 * 60 * 60 * 1000);
  });

  it("a recruit ack counts for the same need only", () => {
    const rows = [{ key: recruitAckKey("m1", 1, at(32)), kind: RECRUIT_ACK_KIND, createdAt: at(32) }];
    expect(recruitAckRecently(rows, { matchId: "m1", need: 1, now })).toBe(true);
    expect(recruitAckRecently(rows, { matchId: "m1", need: 2, now })).toBe(false);
    expect(recruitAckRecently(rows, { matchId: "m2", need: 1, now })).toBe(false);
    expect(
      recruitAckRecently([{ key: recruitAckKey("m1", 1, at(181)), kind: RECRUIT_ACK_KIND, createdAt: at(181) }], { matchId: "m1", need: 1, now }),
    ).toBe(false);
  });

  it("rows of any other kind are ignored", () => {
    const rows = [{ key: rosterShownKey("m1", fp, at(5)), kind: "group-message", createdAt: at(5) }];
    expect(rosterShownRecently(rows, { matchId: "m1", fingerprint: fp, now })).toBe(false);
  });
});
