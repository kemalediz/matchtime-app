/**
 * THE RULE THAT SEATS A REPLACEMENT — Sutton FC, 15 September 2026.
 *
 * Teams generated 16:41. At 19:14 Wasim went out and at 19:15 Amir put
 * Shahrokh in. Both attendance writes landed correctly and the team
 * sheet was never touched: Wasim kept his Yellow slot, Shahrokh had
 * none, and Yellow would have played with six.
 *
 * Everything below is about the PURE half — which slot moves to whom,
 * and when nothing moves. The engine block in
 * `pipeline/__tests__/engine.test.ts` (S38) drives the same rule through
 * the batch; this file settles the rule itself, including the cases the
 * live traffic has not produced yet.
 */
import { describe, it, expect } from "vitest";
import { decideSlotInherits } from "../team-slot-inherit";

type Row = { userId: string; status: "CONFIRMED" | "BENCH" | "DROPPED"; position: number };

/** Fourteen confirmed players, seven a side, in the shape the balancer
 *  writes them: the red block first, then the yellow block. */
function sheet() {
  const names = [
    "idris", "mustafa", "kemal", "najib", "burak", "david", "elnur",
    "wasim", "habib", "mojib", "elvin", "ibrahim", "karahan", "erdal",
  ];
  const rows: Row[] = names.map((n, i) => ({
    userId: n,
    status: "CONFIRMED",
    position: i + 1,
  }));
  const teams = [
    ...["kemal", "mojib", "idris", "mustafa", "elnur", "najib", "karahan"].map(
      (userId) => ({ userId, team: "RED" as const }),
    ),
    ...["elvin", "ibrahim", "erdal", "burak", "habib", "david", "wasim"].map(
      (userId) => ({ userId, team: "YELLOW" as const }),
    ),
  ];
  return { rows, teams };
}

describe("decideSlotInherits — the 2026-09-15 replacement", () => {
  it("THE INCIDENT: Shahrokh takes the Yellow slot Wasim vacated", () => {
    const { rows, teams } = sheet();
    const world = {
      rows: [
        ...rows.map((r) => (r.userId === "wasim" ? { ...r, status: "DROPPED" as const } : r)),
        { userId: "shahrokh", status: "CONFIRMED" as const, position: 15 },
      ],
      teams,
    };
    expect(decideSlotInherits(world)).toEqual([
      { fromUserId: "wasim", toUserId: "shahrokh", team: "YELLOW" },
    ]);
  });

  it("the other thirteen are not named at all — one move, not a regeneration", () => {
    const { rows, teams } = sheet();
    const moves = decideSlotInherits({
      rows: [
        ...rows.map((r) => (r.userId === "wasim" ? { ...r, status: "DROPPED" as const } : r)),
        { userId: "shahrokh", status: "CONFIRMED", position: 15 },
      ],
      teams,
    });
    expect(moves).toHaveLength(1);
    const touched = new Set(moves.flatMap((m) => [m.fromUserId, m.toUserId]));
    for (const t of teams) {
      if (t.userId === "wasim") continue;
      expect(touched.has(t.userId)).toBe(false);
    }
  });

  it("is order-blind: the arrival recorded BEFORE the drop resolves the same", () => {
    const { rows, teams } = sheet();
    // Shahrokh's row written first (position 15), Wasim dropped after.
    // The same world either way — which is the whole argument for a
    // state check over an event correlation.
    const a = decideSlotInherits({
      rows: [
        { userId: "shahrokh", status: "CONFIRMED", position: 15 },
        ...rows.map((r) => (r.userId === "wasim" ? { ...r, status: "DROPPED" as const } : r)),
      ],
      teams,
    });
    const b = decideSlotInherits({
      rows: [
        ...rows.map((r) => (r.userId === "wasim" ? { ...r, status: "DROPPED" as const } : r)),
        { userId: "shahrokh", status: "CONFIRMED", position: 15 },
      ],
      teams,
    });
    expect(a).toEqual(b);
    expect(a).toEqual([{ fromUserId: "wasim", toUserId: "shahrokh", team: "YELLOW" }]);
  });

  it("self-heals: running it again over the repaired sheet moves nothing", () => {
    const { rows, teams } = sheet();
    const repaired = teams.map((t) =>
      t.userId === "wasim" ? { userId: "shahrokh", team: t.team } : t,
    );
    expect(
      decideSlotInherits({
        rows: [
          ...rows.map((r) => (r.userId === "wasim" ? { ...r, status: "DROPPED" as const } : r)),
          { userId: "shahrokh", status: "CONFIRMED", position: 15 },
          ],
        teams: repaired,
      }),
    ).toEqual([]);
  });
});

describe("decideSlotInherits — the cases that must move nothing", () => {
  it("no team sheet at all: a confirmed player without a slot is normal", () => {
    expect(
      decideSlotInherits({
        rows: [{ userId: "shahrokh", status: "CONFIRMED", position: 1 }],
        teams: [],
      }),
    ).toEqual([]);
  });

  it("a drop with NO replacement leaves the hole — slot_opened owns that", () => {
    const { rows, teams } = sheet();
    expect(
      decideSlotInherits({
        rows: rows.map((r) => (r.userId === "wasim" ? { ...r, status: "DROPPED" as const } : r)),
        teams,
      }),
    ).toEqual([]);
  });

  it("a replacement with NO vacancy reassigns nobody — the squad simply grew", () => {
    const { rows, teams } = sheet();
    expect(
      decideSlotInherits({
        rows: [...rows, { userId: "shahrokh", status: "CONFIRMED", position: 15 }],
        teams,
      }),
    ).toEqual([]);
  });

  it("a BENCH player with no slot is not an arrival", () => {
    const { rows, teams } = sheet();
    expect(
      decideSlotInherits({
        rows: [
          ...rows.map((r) => (r.userId === "wasim" ? { ...r, status: "DROPPED" as const } : r)),
          { userId: "amir", status: "BENCH", position: 15 },
        ],
        teams,
      }),
    ).toEqual([]);
  });
});

describe("decideSlotInherits — more than one vacancy", () => {
  it("two drops and two arrivals zip sheet order against join order", () => {
    const { rows, teams } = sheet();
    // Kemal holds RED slot 1 (first on the sheet); Wasim holds the LAST
    // yellow slot. Sheet order therefore puts Kemal's vacancy first, and
    // join order puts the earlier arrival first.
    const out = decideSlotInherits({
      rows: [
        ...rows.map((r) =>
          r.userId === "wasim" || r.userId === "kemal"
            ? { ...r, status: "DROPPED" as const }
            : r,
        ),
        { userId: "shahrokh", status: "CONFIRMED", position: 15 },
        { userId: "raihan", status: "CONFIRMED", position: 16 },
      ],
      teams,
    });
    expect(out).toEqual([
      { fromUserId: "kemal", toUserId: "shahrokh", team: "RED" },
      { fromUserId: "wasim", toUserId: "raihan", team: "YELLOW" },
    ]);
  });

  it("two vacancies and ONE arrival fills the first vacancy only", () => {
    const { rows, teams } = sheet();
    const out = decideSlotInherits({
      rows: [
        ...rows.map((r) =>
          r.userId === "wasim" || r.userId === "kemal"
            ? { ...r, status: "DROPPED" as const }
            : r,
        ),
        { userId: "shahrokh", status: "CONFIRMED", position: 15 },
      ],
      teams,
    });
    expect(out).toEqual([{ fromUserId: "kemal", toUserId: "shahrokh", team: "RED" }]);
  });

  it("the pairing does not depend on the order the rows arrive in", () => {
    const { rows, teams } = sheet();
    const dropped = rows.map((r) =>
      r.userId === "wasim" || r.userId === "kemal" ? { ...r, status: "DROPPED" as const } : r,
    );
    const arrivals = [
      { userId: "raihan", status: "CONFIRMED" as const, position: 16 },
      { userId: "shahrokh", status: "CONFIRMED" as const, position: 15 },
    ];
    const forwards = decideSlotInherits({ rows: [...dropped, ...arrivals], teams });
    const backwards = decideSlotInherits({
      rows: [...arrivals, ...dropped].reverse(),
      teams,
    });
    expect(forwards).toEqual(backwards);
  });
});

describe("decideSlotInherits — a demoted player is a vacancy too", () => {
  it("a CONFIRMED player moved to the bench vacates their slot", () => {
    const { rows, teams } = sheet();
    expect(
      decideSlotInherits({
        rows: [
          ...rows.map((r) => (r.userId === "wasim" ? { ...r, status: "BENCH" as const } : r)),
          { userId: "shahrokh", status: "CONFIRMED", position: 15 },
        ],
        teams,
      }),
    ).toEqual([{ fromUserId: "wasim", toUserId: "shahrokh", team: "YELLOW" }]);
  });

  it("a slot held by somebody with NO attendance row at all is a vacancy", () => {
    const { rows, teams } = sheet();
    expect(
      decideSlotInherits({
        rows: [
          ...rows.filter((r) => r.userId !== "wasim"),
          { userId: "shahrokh", status: "CONFIRMED", position: 15 },
        ],
        teams,
      }),
    ).toEqual([{ fromUserId: "wasim", toUserId: "shahrokh", team: "YELLOW" }]);
  });
});

describe("decideSlotInherits — the colour swap", () => {
  it("the replacement lands in the side the dropped player is ACTUALLY on", () => {
    const { rows, teams } = sheet();
    // "@Match Time swap all yellow team players with red team players"
    // flips the ENUM on every row (`route.ts`'s colour-swap handler), so
    // Wasim's slot is RED afterwards even though the sheet was written
    // with him in yellow. The inherit copies the CURRENT enum.
    const flipped = teams.map((t) => ({
      userId: t.userId,
      team: (t.team === "RED" ? "YELLOW" : "RED") as "RED" | "YELLOW",
    }));
    expect(
      decideSlotInherits({
        rows: [
          ...rows.map((r) => (r.userId === "wasim" ? { ...r, status: "DROPPED" as const } : r)),
          { userId: "shahrokh", status: "CONFIRMED", position: 15 },
        ],
        teams: flipped,
      }),
    ).toEqual([{ fromUserId: "wasim", toUserId: "shahrokh", team: "RED" }]);
  });
});

describe("decideSlotInherits — it cannot touch attendance", () => {
  it("no field on the decision can carry a status", () => {
    const { rows, teams } = sheet();
    const out = decideSlotInherits({
      rows: [
        ...rows.map((r) => (r.userId === "wasim" ? { ...r, status: "DROPPED" as const } : r)),
        { userId: "shahrokh", status: "CONFIRMED", position: 15 },
      ],
      teams,
    });
    expect(Object.keys(out[0]).sort()).toEqual(["fromUserId", "team", "toUserId"]);
  });
});
