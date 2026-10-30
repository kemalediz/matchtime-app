/**
 * The Pi's ack of one of MatchTime's HQ posts also gives its WhatsApp id to
 * the team sheet in it (2026-10-30), so a reply to that sheet days later
 * finds it (`team-sheet-history.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  sentNotification: { findUnique: vi.fn() },
  botJob: { findUnique: vi.fn() },
  adminGroupMessage: { updateMany: vi.fn(async () => ({ count: 1 })) },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const sheets = vi.hoisted(() => ({ stampTeamSheets: vi.fn(async () => 1) }));
vi.mock("@/lib/team-sheet-history", () => sheets);

import { stampHqLogStanza } from "../hq-log-stanza";

const AT = new Date("2026-10-27T18:09:00Z");

beforeEach(() => vi.clearAllMocks());

describe("stampHqLogStanza stamps the team sheet too", () => {
  it("an inline HQ reply", async () => {
    dbMock.sentNotification.findUnique.mockResolvedValue({ text: "📝 *Proposed teams* ...", createdAt: AT });
    await stampHqLogStanza("hqreply:org-fnf:wa-1", "3EB0A");
    expect(sheets.stampTeamSheets).toHaveBeenCalledWith({ orgId: "org-fnf", sentText: "📝 *Proposed teams* ...", at: AT, waStanzaId: "3EB0A" });
  });
  it("an admin-group BotJob (the Teams ready proposal)", async () => {
    dbMock.botJob.findUnique.mockResolvedValue({ orgId: "org-fnf", kind: "admin-group", text: "📝 *Proposed teams* ...", createdAt: AT });
    await stampHqLogStanza("botjob-job1", "3EB0B");
    expect(sheets.stampTeamSheets).toHaveBeenCalledWith({ orgId: "org-fnf", sentText: "📝 *Proposed teams* ...", at: AT, waStanzaId: "3EB0B" });
  });
  it("no stanza id: nothing", async () => {
    await stampHqLogStanza("hqreply:org-fnf:wa-1", null);
    expect(sheets.stampTeamSheets).not.toHaveBeenCalled();
  });
});
