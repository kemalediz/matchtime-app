/**
 * `placeMonthlyLines`: the who-is-who step a pasted monthly list goes
 * through BEFORE the reconcile (review of #574, round 3, B2), and what the
 * reconcile then makes of an organiser's misspelt bencher.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    membership: {
      findMany: vi.fn(async () => [
        { user: { id: "u-zed", name: "Zed Ahmed" } },
        { user: { id: "u-will", name: "Will Smith" } },
        { user: { id: "u-rob", name: "Rob Admin" } },
      ]),
    },
    userAlias: { findMany: vi.fn(async () => []) },
  },
}));

import { placeMonthlyLines } from "../monthly-paste";
import { reconcileMonthPaste } from "../monthly-week-rules";
import type { MonthlyList, MonthlyListEntry } from "../monthly-list";
import type { PersonPick, PersonPicker, WhoRequest } from "../pipeline/who-is-who";

const marks = { paid: false, paidAmountPence: null, tier: null, payg: false, paygDates: [] };
const line = (slot: number, name: string, memberId: string | null): MonthlyListEntry => ({
  slot,
  raw: name,
  name,
  marks,
  facts: { memberId, guest: false, hostUserId: null, games: null, newbie: false },
});
const IDS = new Set(["u-zed", "u-will", "u-rob"]);

function picker(answers: Record<string, PersonPick>) {
  const seen: WhoRequest[] = [];
  const fn: PersonPicker = async (req) => {
    seen.push(req);
    return { picks: new Map(req.messages.map((m) => [m.id, new Map(m.refs.map((r) => [r, answers[r] ?? { kind: "none" as const }]))])), usage: null, degradations: [] };
  };
  return { fn, seen };
}

describe("placeMonthlyLines", () => {
  it("asks once, only for the lines no member is on, with the message and the whole club", async () => {
    const list: MonthlyList = { month: null, slots: [line(1, "Will Smith", "u-will")], sections: { cantPlay: [], reserves: [line(1, "Zedd", null)], other: [] } };
    const p = picker({ Zedd: { kind: "ambiguous", userIds: ["u-zed"] } });
    const out = await placeMonthlyLines({ list, orgId: "org-1", rosterIds: IDS, body: "1. Will Smith\nBench\nZedd", sender: { userId: "u-rob", name: "Rob" }, identify: p.fn });
    expect(p.seen).toHaveLength(1);
    expect(p.seen[0].messages[0]).toMatchObject({ refs: ["Zedd"], body: "1. Will Smith\nBench\nZedd" });
    expect(p.seen[0].roster.map((m) => m.userId)).toEqual(["u-zed", "u-will", "u-rob"]);
    expect(out.sections.reserves[0].facts?.unclear).toEqual({ candidates: ["u-zed"] });
  });

  it("no unplaced line, no call", async () => {
    const list: MonthlyList = { month: null, slots: [line(1, "Will Smith", "u-will")], sections: { cantPlay: [], reserves: [], other: [] } };
    const p = picker({});
    await placeMonthlyLines({ list, orgId: "org-1", rosterIds: IDS, sender: { userId: null, name: null }, identify: p.fn });
    expect(p.seen).toHaveLength(0);
  });

  it("THE BUG: an organiser's paste with a misspelt bencher no longer takes him off the bench; placed surely, he simply stays", async () => {
    const list: MonthlyList = {
      month: null,
      slots: [line(1, "Will Smith", "u-will")],
      sections: { cantPlay: [], reserves: [line(1, "Zedd", null)], other: [] },
      benchShown: true,
    };
    const week = {
      members: [
        { userId: "u-will", name: "Will Smith", kind: "regular" as const, absent: false, paid: "none" as const },
        { userId: "u-zed", name: "Zed Ahmed", kind: "payg" as const },
      ],
      rows: [
        { userId: "u-will", status: "CONFIRMED" as const, position: 1 },
        { userId: "u-zed", status: "BENCH" as const, position: 2 },
      ],
    };
    const reconcile = (l: MonthlyList) =>
      reconcileMonthPaste({
        list: l,
        members: week.members as never,
        rows: week.rows as never,
        maxPlayers: 1,
        roster: [...IDS].map((id) => ({ userId: id, name: id, aliases: [] })),
        matchMonth: 11,
        seeded: true,
        senderUserId: "u-rob",
        senderIsAdmin: true,
        benchSeen: new Set(["u-zed"]),
      });
    // On main the reconcile read the unplaced "Zedd" as nobody: Zed off.
    expect(reconcile(list).actions).toEqual([expect.objectContaining({ kind: "out", userId: "u-zed", self: false, via: "off-bench" })]);
    for (const answer of [{ kind: "member", userId: "u-zed" }, { kind: "ambiguous", userIds: ["u-zed"] }] as PersonPick[]) {
      const placed = await placeMonthlyLines({ list, orgId: "org-1", rosterIds: IDS, sender: { userId: "u-rob", name: "Rob" }, identify: picker({ Zedd: answer }).fn });
      expect(reconcile(placed).actions).toEqual([]);
    }
  });
});
