/**
 * The graphics command's hook in `handleAdminGroupMessage` (2026-10-14):
 * read after the collector's PAID and before everything else, for a club
 * of any squad mode; when it answers, nothing below runs (so "poster" is
 * never a pick reply or a squad change, and never reaches the model);
 * when it does not, the route is exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findFirst: vi.fn() },
  organiserPickRound: { findFirst: vi.fn() },
  membership: { findFirst: vi.fn() },
  sentNotification: { create: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/admin-group-link", () => ({ resolveSenderUserIds: vi.fn(async () => ["u-admin"]) }));
const pick = vi.hoisted(() => ({ handlePickReply: vi.fn() }));
vi.mock("@/lib/organiser-pick", () => pick);
vi.mock("@/lib/admin-group-paste", () => ({ proposeSquadPaste: vi.fn(async () => null), answerSquadPasteYes: vi.fn(async () => null) }));
const change = vi.hoisted(() => ({ handleAdminSquadChange: vi.fn() }));
vi.mock("@/lib/admin-group-squad-change", () => change);
vi.mock("@/lib/month-payment", () => ({ handleCollectorPaidReply: vi.fn() }));
const graphics = vi.hoisted(() => ({ handleAdminGraphicsCommand: vi.fn() }));
vi.mock("@/lib/admin-group-graphics", () => graphics);

import { handleAdminGroupMessage } from "../admin-group";

const HQ = "120363777000000001@g.us";
const NOW = new Date("2026-10-14T12:00:00Z");
const ORG = { id: "org-fnf", billingStatus: null, whatsappBotEnabled: true, squadMode: "weekly", language: "en" };
const msg = (text: string) => ({ groupId: HQ, messageId: "wa-1", text, senderPhone: "447700900001", now: NOW });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.organisation.findFirst.mockResolvedValue(ORG);
  dbMock.organiserPickRound.findFirst.mockResolvedValue(null);
  dbMock.membership.findFirst.mockResolvedValue({ userId: "u-admin" });
  dbMock.sentNotification.create.mockResolvedValue({});
  dbMock.user.findUnique.mockResolvedValue({ name: "Raihan" });
  change.handleAdminSquadChange.mockResolvedValue({ handled: false });
  graphics.handleAdminGraphicsCommand.mockResolvedValue(null);
});

describe("handleAdminGroupMessage: the graphics command", () => {
  it("is asked first, with the club, the message and the clock, and its answer is the route's", async () => {
    graphics.handleAdminGraphicsCommand.mockResolvedValue({ handled: true, orgId: "org-fnf", outcome: "graphic-queued", replyText: null });
    const m = msg("poster");
    expect(await handleAdminGroupMessage(m)).toEqual({ handled: true, orgId: "org-fnf", outcome: "graphic-queued", replyText: null });
    expect(graphics.handleAdminGraphicsCommand).toHaveBeenCalledWith({ org: ORG, msg: m, now: NOW });
    expect(change.handleAdminSquadChange).not.toHaveBeenCalled();
    expect(pick.handlePickReply).not.toHaveBeenCalled();
    expect(dbMock.organiserPickRound.findFirst).not.toHaveBeenCalled();
  });

  it("not the command: the route carries on as before (here, a squad change)", async () => {
    change.handleAdminSquadChange.mockResolvedValue({ handled: true, outcome: "squad-changed", replyText: "Done." });
    expect(await handleAdminGroupMessage(msg("Shehryar out"))).toMatchObject({ handled: true, outcome: "squad-changed" });
    expect(graphics.handleAdminGraphicsCommand).toHaveBeenCalledTimes(1);
  });

  it("a monthly club reaches it too (the list is still a list)", async () => {
    dbMock.organisation.findFirst.mockResolvedValue({ ...ORG, squadMode: "monthly" });
    graphics.handleAdminGraphicsCommand.mockResolvedValue({ handled: true, orgId: "org-fnf", outcome: "graphic-queued", replyText: null });
    expect(await handleAdminGroupMessage(msg("liste"))).toMatchObject({ outcome: "graphic-queued" });
  });

  it("a paused club never reaches it", async () => {
    vi.stubEnv("BILLING_ENABLED", "1");
    try {
      dbMock.organisation.findFirst.mockResolvedValue({ ...ORG, billingStatus: "paused" });
      expect(await handleAdminGroupMessage(msg("poster"))).toMatchObject({ ignored: "club-billing-paused" });
      expect(graphics.handleAdminGraphicsCommand).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
