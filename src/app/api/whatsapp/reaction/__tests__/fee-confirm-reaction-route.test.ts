/**
 * POST /api/whatsapp/reaction: a ✅ REACTION on the collector's fee
 * confirm prompt (Sutton FC, 2026-10-21 00:47 UTC).
 *
 * The rows below are the production rows, read back read-only:
 *   SentNotification botjob-cmvhe77dn000207jse4xb6eqw, kind "dm",
 *     waMessageId "true_447525334985@c.us_3EB01CA3A67CC8AC4CE8FD"
 *   BotJob cmvhe77dn000207jse4xb6eqw, phone 447525334985,
 *     aboutKey "cmtbro2gy0008tt9kheu37suw:fee-confirm"
 * and the Pi forwarded exactly that id with emoji ✅ from 447525334985.
 * Before the fix the route answered `ignored: "no-open-offer"` and the
 * links never went out.
 *
 * The release itself (`confirmCollectorFeeByReaction`) is mocked here;
 * lib/__tests__/fee-confirm-reaction-release.test.ts pins it.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "test-wa-key";
const WA = "true_447525334985@c.us_3EB01CA3A67CC8AC4CE8FD";
const MATCH = "cmtbro2gy0008tt9kheu37suw";
const JOB = "cmvhe77dn000207jse4xb6eqw";
const ORG = "cmnnwhdx30000zfr85q18lyy9";
const KEMAL = "cmn5vhtp2000004ifh4dqbsym";

const m = vi.hoisted(() => ({
  benchFindFirst: vi.fn(),
  sentFindFirst: vi.fn(),
  sentFindUnique: vi.fn(),
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

const PROMPT_JOB = {
  id: JOB,
  kind: "dm",
  orgId: ORG,
  phone: "447525334985",
  matchId: MATCH,
  aboutKey: `${MATCH}:fee-confirm`,
  createdAt: new Date("2026-10-21T00:47:18.299Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHATSAPP_API_KEY = KEY;
  m.benchFindFirst.mockResolvedValue(null);
  // The /ack stamped the dispatch row with the id the Pi forwards.
  m.sentFindFirst.mockImplementation(async (args: { where: { waMessageId?: string } }) =>
    args.where.waMessageId === WA ? { key: `botjob-${JOB}` } : null,
  );
  // Not a recruit invite: no `recruit-dm-job:` link row.
  m.sentFindUnique.mockResolvedValue(null);
  m.jobFindUnique.mockImplementation(async (args: { where: { id: string } }) =>
    args.where.id === JOB ? PROMPT_JOB : null,
  );
  // It is the newest fee confirm prompt for the match.
  m.jobFindFirst.mockResolvedValue({ id: JOB });
  m.matchFindUnique.mockResolvedValue({
    activity: {
      orgId: ORG,
      org: { paymentHolderId: KEMAL, paymentCollectionEnabled: true },
    },
  });
  m.userFindUnique.mockImplementation(async (args: { where: { id: string } }) =>
    args.where.id === KEMAL ? { phoneNumber: "+447525334985" } : null,
  );
  m.confirm.mockResolvedValue({ matchId: MATCH, orgId: ORG, released: 13, reply: "Done: 13 pay links sent." });
  m.jobCreate.mockResolvedValue({});
});

describe("the 2026-10-21 Sutton ✅ reaction on the fee confirm prompt", () => {
  it("releases the links through the collector's confirm path and queues the same ack", async () => {
    const res = await post({ waMessageId: WA, emoji: "✅", fromPhone: "447525334985", fromAuthorName: "Kemal" });
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, handled: "fee-confirm-reaction", released: 13, matchId: MATCH });
    expect(m.confirm).toHaveBeenCalledTimes(1);
    expect(m.confirm).toHaveBeenCalledWith(KEMAL, MATCH);
    // The ack goes to the collector, under the match's club, at reply priority.
    expect(m.jobCreate).toHaveBeenCalledTimes(1);
    expect(m.jobCreate.mock.calls[0][0].data).toMatchObject({
      orgId: ORG,
      kind: "dm",
      phone: "447525334985",
      text: "Done: 13 pay links sent.",
      matchId: MATCH,
      priority: 1,
    });
  });

  it("a ❤️ on the same prompt does nothing", async () => {
    const body = await (await post({ waMessageId: WA, emoji: "❤️", fromPhone: "447525334985" })).json();
    expect(body.ignored).toBe("not-yes");
    expect(m.confirm).not.toHaveBeenCalled();
    expect(m.jobCreate).not.toHaveBeenCalled();
  });

  it("a second ✅ (already released) sends nothing more", async () => {
    m.confirm.mockResolvedValue(null);
    const body = await (await post({ waMessageId: WA, emoji: "✅", fromPhone: "447525334985" })).json();
    expect(body.ignored).toBe("nothing-pending");
    expect(m.jobCreate).not.toHaveBeenCalled();
  });

  it("a reaction on any other DM still falls through as before", async () => {
    m.sentFindFirst.mockResolvedValue(null);
    const body = await (await post({ waMessageId: "true_447700900001@c.us_3EB0OTHER", emoji: "✅", fromPhone: "447700900001" })).json();
    expect(body).toEqual({ ok: true, ignored: "no-open-offer" });
    expect(m.confirm).not.toHaveBeenCalled();
  });
});
