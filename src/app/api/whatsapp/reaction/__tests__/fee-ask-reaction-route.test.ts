/**
 * POST /api/whatsapp/reaction: a ✅ REACTION on the MONTHLY-SQUAD PAYG fee
 * question ("£8 each for 3 players. Reply ✅ (or "yes") to send everyone
 * their pay link").
 *
 * That DM is not a BotJob. The scheduler sends it (bot-scheduler.ts, 6a-bis)
 * under the key `<matchId>:fee-ask` (or `:fee-ask:again` for its one
 * re-ask): due-posts claims a SentNotification{key, kind:"dm", matchId,
 * targetUser:<collector>} and /ack stamps the sent message's id on it. So
 * the join from #359 (`botjob-<id>` → BotJob aboutKey) never matched it,
 * and the route answered `ignored: "no-open-offer"`: the ✅ was dropped.
 *
 * The release itself (`confirmCollectorFeeByReaction`) is mocked here;
 * lib/__tests__/fee-confirm-reaction-release.test.ts pins it.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "test-wa-key";
const WA = "true_447700925001@c.us_3EB0FEEASK0001";
const MATCH = "e2e-mw6-match";
const ORG = "org-monthly";
const CAL = "user-cal";
const ASK_AT = new Date("2026-10-20T21:40:00Z");

const m = vi.hoisted(() => ({
  benchFindFirst: vi.fn(),
  sentFindFirst: vi.fn(),
  sentFindUnique: vi.fn(),
  sentFindMany: vi.fn(),
  jobFindUnique: vi.fn(),
  jobFindFirst: vi.fn(),
  jobCreate: vi.fn(),
  matchFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    benchSlotOffer: { findFirst: (...a: unknown[]) => m.benchFindFirst(...a) },
    sentNotification: {
      findFirst: (...a: unknown[]) => m.sentFindFirst(...a),
      findUnique: (...a: unknown[]) => m.sentFindUnique(...a),
      findMany: (...a: unknown[]) => m.sentFindMany(...a),
    },
    botJob: {
      findUnique: (...a: unknown[]) => m.jobFindUnique(...a),
      findFirst: (...a: unknown[]) => m.jobFindFirst(...a),
      create: (...a: unknown[]) => m.jobCreate(...a),
    },
    match: { findUnique: (...a: unknown[]) => m.matchFindUnique(...a) },
    user: { findUnique: (...a: unknown[]) => m.userFindUnique(...a) },
  },
}));
vi.mock("@/lib/payment-flow", () => ({
  confirmCollectorFeeByReaction: (...a: unknown[]) => m.confirm(...a),
}));

import { POST } from "../route";

const ENV = { key: process.env.WHATSAPP_API_KEY };
afterAll(() => {
  if (ENV.key === undefined) delete process.env.WHATSAPP_API_KEY;
  else process.env.WHATSAPP_API_KEY = ENV.key;
});

function post(body: unknown) {
  return POST(
    new Request("http://x/api/whatsapp/reaction", {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHATSAPP_API_KEY = KEY;
  m.benchFindFirst.mockResolvedValue(null);
  // The scheduler's claim row, stamped with the sent id by /ack.
  m.sentFindFirst.mockImplementation(async (args: { where: { waMessageId?: string } }) =>
    args.where.waMessageId === WA
      ? { key: `${MATCH}:fee-ask`, matchId: MATCH, targetUser: CAL, createdAt: ASK_AT }
      : null,
  );
  // Not a recruit invite.
  m.sentFindUnique.mockResolvedValue(null);
  // The only fee question out for the match is this one.
  m.sentFindMany.mockResolvedValue([{ key: `${MATCH}:fee-ask`, createdAt: ASK_AT }]);
  m.jobFindUnique.mockResolvedValue(null);
  m.jobFindFirst.mockResolvedValue(null);
  m.matchFindUnique.mockResolvedValue({
    activity: { orgId: ORG, org: { paymentHolderId: CAL, paymentCollectionEnabled: true } },
  });
  m.userFindUnique.mockImplementation(async (args: { where: { id: string } }) =>
    args.where.id === CAL ? { phoneNumber: "+447700925001" } : null,
  );
  m.confirm.mockResolvedValue({ matchId: MATCH, orgId: ORG, released: 1, reply: "Done: 1 pay link sent." });
  m.jobCreate.mockResolvedValue({});
});

describe("a ✅ on the monthly PAYG fee question (a scheduler DM, not a BotJob)", () => {
  it("is the collector's yes: confirmed through the typed yes's path with the question's own key, and acked", async () => {
    const res = await post({ waMessageId: WA, emoji: "✅", fromPhone: "447700925001", fromAuthorName: "Cal" });
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, handled: "fee-confirm-reaction", released: 1, matchId: MATCH });
    expect(m.confirm).toHaveBeenCalledTimes(1);
    expect(m.confirm).toHaveBeenCalledWith(CAL, MATCH, `${MATCH}:fee-ask`);
    expect(m.jobCreate).toHaveBeenCalledTimes(1);
    expect(m.jobCreate.mock.calls[0][0].data).toMatchObject({
      orgId: ORG,
      kind: "dm",
      phone: "447700925001",
      text: "Done: 1 pay link sent.",
      matchId: MATCH,
      priority: 1,
    });
  });

  it("the re-ask (`:fee-ask:again`) counts the same", async () => {
    m.sentFindFirst.mockResolvedValue({ key: `${MATCH}:fee-ask:again`, matchId: MATCH, targetUser: CAL, createdAt: ASK_AT });
    m.sentFindMany.mockResolvedValue([{ key: `${MATCH}:fee-ask:again`, createdAt: ASK_AT }]);
    const body = await (await post({ waMessageId: WA, emoji: "👍", fromPhone: "447700925001" })).json();
    expect(body.handled).toBe("fee-confirm-reaction");
    expect(m.confirm).toHaveBeenCalledWith(CAL, MATCH, `${MATCH}:fee-ask:again`);
  });

  it("❤️ does nothing", async () => {
    const body = await (await post({ waMessageId: WA, emoji: "❤️", fromPhone: "447700925001" })).json();
    expect(body.ignored).toBe("not-yes");
    expect(m.confirm).not.toHaveBeenCalled();
  });

  it("superseded by a later typed amount (a newer confirm prompt): nothing", async () => {
    m.jobFindFirst.mockResolvedValue({ id: "job-later", createdAt: new Date(ASK_AT.getTime() + 60_000) });
    const body = await (await post({ waMessageId: WA, emoji: "✅", fromPhone: "447700925001" })).json();
    expect(body.ignored).toBe("superseded-prompt");
    expect(m.confirm).not.toHaveBeenCalled();
  });

  it("the question went to somebody who is no longer the collector: nothing", async () => {
    m.matchFindUnique.mockResolvedValue({
      activity: { orgId: ORG, org: { paymentHolderId: "user-new", paymentCollectionEnabled: true } },
    });
    const body = await (await post({ waMessageId: WA, emoji: "✅", fromPhone: "447700925001" })).json();
    expect(body.ignored).toBe("not-the-collector");
    expect(m.confirm).not.toHaveBeenCalled();
  });

  it("already released (a second ✅): nothing more is sent", async () => {
    m.confirm.mockResolvedValue(null);
    const body = await (await post({ waMessageId: WA, emoji: "✅", fromPhone: "447700925001" })).json();
    expect(body.ignored).toBe("nothing-pending");
    expect(m.jobCreate).not.toHaveBeenCalled();
  });
});
