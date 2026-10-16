/**
 * Free places, tonight's version (FNF, 2026-10-16). The club gives two
 * places a week away (the bib washer and the Man of the Match). An
 * organiser or the money collector marks those players paid on the
 * payments page (/collect/<matchId>, "Mark received") BEFORE the fee is
 * confirmed. When the fee is then confirmed, `releaseMatchPayments` must
 * send them no pay link, and must still send everyone else theirs.
 *
 * The daily chase already skips a paid row (bot-scheduler `if (a.paidAt)
 * continue`), pinned end to end in e2e/api/pay-chase.spec.ts and in the
 * release path in e2e/helpers/payment-lib-tests.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const botJobs: Array<{ phone: string; text: string }> = [];
let matchRow: Record<string, unknown> | null = null;
const matchUpdate = vi.fn(async () => ({}));
let findArgs: unknown = null;

vi.mock("../db", () => ({
  db: {
    match: {
      findUnique: async (args: unknown) => {
        findArgs = args;
        return matchRow;
      },
      update: (...a: unknown[]) => matchUpdate(...(a as [])),
    },
    botJob: {
      create: async ({ data }: { data: { phone: string; text: string } }) => {
        botJobs.push(data);
        return data;
      },
    },
  },
}));
vi.mock("../short-link", () => ({ buildShortMagicLinkUrl: async () => "https://mt.test/l/pay" }));
vi.mock("../magic-link", () => ({ signMagicLinkToken: () => "token", MAGIC_LINK_TTL: { bookmark: 1, actionNudge: 1 } }));

import { releaseMatchPayments } from "../payment-flow";

const phoneOf = (i: number) => `+4477009000${i}`;

function att(i: number, id: string, paidAt: Date | null = null) {
  return {
    userId: id,
    status: "CONFIRMED",
    paymentMethod: null,
    paidAt,
    user: { id, name: id, phoneNumber: phoneOf(i) },
  };
}

function match(attendances: ReturnType<typeof att>[]) {
  return {
    id: "m1",
    feePerPlayer: 7,
    activity: { name: "Friday Night Football", orgId: "org", org: { paymentHolderId: "col", language: "en" } },
    attendances,
  };
}

beforeEach(() => {
  botJobs.length = 0;
  matchUpdate.mockClear();
  findArgs = null;
});

describe("releaseMatchPayments skips a player already marked paid", () => {
  it("the two free places get no pay link; everyone else does; the collector never does", async () => {
    const marked = new Date("2026-10-16T19:00:00Z");
    matchRow = match([
      att(1, "bibs", marked),
      att(2, "mom", marked),
      att(3, "ali"),
      att(4, "ben"),
      att(5, "col"),
    ]);
    expect(await releaseMatchPayments("m1")).toBe(2);
    expect(botJobs.map((j) => j.phone).sort()).toEqual([phoneOf(3), phoneOf(4)].map((p) => p.slice(1)).sort());
    // The release is still stamped, so the chase starts for the payers.
    expect(matchUpdate).toHaveBeenCalledTimes(1);
  });

  it("reads paidAt off the attendance rows it sends to", async () => {
    matchRow = match([att(1, "ali")]);
    await releaseMatchPayments("m1");
    // The query loads the whole Attendance row (include, not a narrow
    // select), so paidAt is present on every row the loop reads.
    const a = (findArgs as { include: { attendances: Record<string, unknown> } }).include.attendances;
    expect(a).not.toHaveProperty("select");
  });

  it("nobody marked: every player but the collector gets a link, as before", async () => {
    matchRow = match([att(1, "ali"), att(2, "ben"), att(3, "col")]);
    expect(await releaseMatchPayments("m1")).toBe(2);
    expect(botJobs).toHaveLength(2);
  });
});
