/**
 * Review of #437, 4: a score arriving for a game marked as not played in
 * between (`setMatchScore` throws `MatchCancelledError` inside its locked
 * transaction). The legacy WhatsApp score route and the dashboard's
 * `updateMatchScore` both answer it in words, never a 500.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const elo = vi.hoisted(() => ({ setMatchScore: vi.fn(), reconcileMatchElo: vi.fn() }));
vi.mock("@/lib/match-elo", async (orig) => ({ ...(await orig<typeof import("@/lib/match-elo")>()), ...elo }));
const dbMock = vi.hoisted(() => ({
  organisation: { findFirst: vi.fn() },
  user: { findUnique: vi.fn() },
  match: { findMany: vi.fn(), findUnique: vi.fn() },
  attendance: { findUnique: vi.fn(), findFirst: vi.fn() },
  membership: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "admin" } }) }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const KICKOFF = new Date(Date.now() - 5 * 3600_000);

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.WHATSAPP_API_KEY = "k";
  const { MatchCancelledError } = await import("@/lib/match-elo");
  elo.setMatchScore.mockRejectedValue(new MatchCancelledError("m1"));
});

describe("a score for a game marked as not played meanwhile", () => {
  it("the WhatsApp score route: 409 with a plain message", async () => {
    dbMock.organisation.findFirst.mockResolvedValue({ id: "org1" });
    dbMock.user.findUnique.mockResolvedValue({ id: "u1" });
    dbMock.match.findMany.mockResolvedValue([{ id: "m1", date: KICKOFF, activity: { name: "Tuesday 5-a-side", matchDurationMins: 60 }, teamAssignments: [] }]);
    dbMock.attendance.findUnique.mockResolvedValue({ status: "CONFIRMED" });
    dbMock.attendance.findFirst.mockResolvedValue({ status: "CONFIRMED" });
    dbMock.membership.findUnique.mockResolvedValue({ role: "OWNER", leftAt: null });
    const { POST } = await import("@/app/api/whatsapp/score/route");
    const res = await POST(
      new Request("http://x/api/whatsapp/score", {
        method: "POST",
        headers: { "x-api-key": "k", "content-type": "application/json" },
        body: JSON.stringify({ fromPhone: "+447700900001", redScore: 5, yellowScore: 3, groupId: "g@g.us" }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_played", message: "That game is marked as not played, so I haven't recorded a score for it." });
    expect(elo.reconcileMatchElo).not.toHaveBeenCalled();
  });

  it("the dashboard's updateMatchScore: the error is the plain line, in the club's language", async () => {
    dbMock.match.findUnique.mockResolvedValue({ id: "m1", status: "COMPLETED", date: KICKOFF, activity: { orgId: "org1", matchDurationMins: 60, org: { language: "tr" } } });
    const { updateMatchScore } = await import("@/app/actions/matches");
    await expect(updateMatchScore("m1", { redScore: 5, yellowScore: 3 })).rejects.toThrow("Bu maç oynanmadı olarak işaretli, bu yüzden skor kaydetmedim.");
    expect(elo.reconcileMatchElo).not.toHaveBeenCalled();
  });
});
