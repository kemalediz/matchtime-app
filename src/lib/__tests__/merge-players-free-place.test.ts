/**
 * A MERGE CARRIES A FREE PLACE LIKE IT CARRIES A PAYMENT (review of #301,
 * item 9). When the dropped duplicate's place wins a collision, its
 * `paidAt` already travels to the keeper's row; its free place
 * (`feeWaivedAt`, reason, who) must travel the same way, or the merged
 * player is charged for a game the organisers made free.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/attendance-events", () => ({ recordAttendanceEvent: vi.fn() }));

import { mergePlayersCore } from "../merge-players-core";

const KEEP = "u-keep";
const DROP = "u-drop";
const FREE_AT = new Date("2026-10-16T18:00:00Z");

function tx(dropRow: Record<string, unknown>, keepRow: Record<string, unknown>) {
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async (args: { where?: Record<string, unknown>; data?: Record<string, unknown> }) => {
          if (name === "user" && method === "findUnique") {
            const id = (args.where as { id: string }).id;
            return { id, name: id, email: `${id}@matchtime.local`, phoneNumber: null };
          }
          if (name === "attendance" && method === "findMany") return (args.where as { userId: string }).userId === DROP ? [dropRow] : [];
          if (name === "attendance" && method === "findUnique") return keepRow;
          if (name === "attendance" && method === "update") updates.push({ where: args.where, data: args.data ?? {} });
          if (name === "match" && method === "findUnique") return { activity: { orgId: "org" } };
          if (method === "findMany") return [];
          if (/updateMany|deleteMany/.test(method)) return { count: 0 };
          return null;
        },
      },
    );
  return { tx: new Proxy({}, { get: (_t, name: string) => model(name) }), updates };
}

describe("mergePlayersCore and a free place", () => {
  it("the dropped row's place wins: its free place travels to the keeper, with who and why", async () => {
    const { tx: t, updates } = tx(
      { id: "a-drop", matchId: "m1", userId: DROP, status: "CONFIRMED", position: 2, paidAt: null, feeWaivedAt: FREE_AT, feeWaivedReason: "organiser", feeWaivedByUserId: "org1" },
      { id: "a-keep", matchId: "m1", userId: KEEP, status: "BENCH", position: 9, paidAt: null, feeWaivedAt: null, feeWaivedReason: null, feeWaivedByUserId: null },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mergePlayersCore(t as any, KEEP, DROP, { saveAliasInOrgIds: [] });
    const keep = updates.find((u) => (u.where as { id: string }).id === "a-keep");
    expect(keep?.data).toMatchObject({ status: "CONFIRMED", feeWaivedAt: FREE_AT, feeWaivedReason: "organiser", feeWaivedByUserId: "org1" });
  });

  it("the keeper's own free place is kept when the dropped row has none", async () => {
    const { tx: t, updates } = tx(
      { id: "a-drop", matchId: "m1", userId: DROP, status: "CONFIRMED", position: 2, paidAt: null, feeWaivedAt: null, feeWaivedReason: null, feeWaivedByUserId: null },
      { id: "a-keep", matchId: "m1", userId: KEEP, status: "BENCH", position: 9, paidAt: null, feeWaivedAt: FREE_AT, feeWaivedReason: "organiser", feeWaivedByUserId: "org2" },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mergePlayersCore(t as any, KEEP, DROP, { saveAliasInOrgIds: [] });
    const keep = updates.find((u) => (u.where as { id: string }).id === "a-keep");
    expect(keep?.data).toMatchObject({ feeWaivedAt: FREE_AT, feeWaivedByUserId: "org2" });
  });
});
