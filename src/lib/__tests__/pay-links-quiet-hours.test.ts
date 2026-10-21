/**
 * The weekly per-match pay links respect the club's quiet hours (Kemal,
 * 2026-10-21). Sutton FC (quiet hours on, 23:00 to 09:00) got its pay links
 * at 08:14 London: `releaseMatchPayments` queued every DM to send at once.
 *
 *   - inside quiet hours the pay-link DMs are queued with `sendAfter` = when
 *     quiet hours end (`messageHoursSendAfter`), the BotJob mechanism the
 *     monthly payment DMs and the admin notices use;
 *   - outside quiet hours, or with quiet hours off, they send at once;
 *   - the collector's ack still goes at once (it is a reply), and when the
 *     links are held it says when they go out, in EN and TR.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const botJobs: Array<{ phone: string; text: string; sendAfter?: Date | null }> = [];
let matchRow: Record<string, unknown> | null = null;

vi.mock("../db", () => ({
  db: {
    match: {
      findUnique: async () => matchRow,
      update: async () => ({}),
    },
    user: { findUnique: async () => null },
    botJob: {
      create: async ({ data }: { data: { phone: string; text: string; sendAfter?: Date | null } }) => {
        botJobs.push(data);
        return data;
      },
    },
  },
}));
vi.mock("../short-link", () => ({ buildShortMagicLinkUrl: async () => "https://mt.test/l/pay" }));
vi.mock("../magic-link", () => ({ signMagicLinkToken: () => "token", MAGIC_LINK_TTL: { bookmark: 1, actionNudge: 1 } }));

import { releaseMatchPayments, runCollectorFeeReply, type CollectorFeeDeps } from "../payment-flow";
import { buildFeeReleasedAck } from "../dm-copy";
import type { QuietHours } from "../message-hours";

// 2026-10-21 is British Summer Time (UTC+1).
const AT_23_30 = new Date("2026-10-21T22:30:00Z");
const AT_08_10 = new Date("2026-10-21T07:10:00Z");
const AT_12_00 = new Date("2026-10-21T11:00:00Z");
const NEXT_09_00 = new Date("2026-10-22T08:00:00Z");
const TODAY_09_00 = new Date("2026-10-21T08:00:00Z");

const ON: QuietHours = { enabled: true, from: "23:00", to: "09:00" };
const OFF: QuietHours = { enabled: false, from: "23:00", to: "09:00" };

function squad(quiet: QuietHours, lang = "en") {
  return {
    id: "m1",
    feePerPlayer: 8,
    activity: {
      name: "Tuesday 7-a-side",
      orgId: "org",
      org: {
        paymentHolderId: "col",
        language: lang,
        quietHoursEnabled: quiet.enabled,
        quietHoursFrom: quiet.from,
        quietHoursTo: quiet.to,
        payMethodPayByBank: false,
        payMethodCard: false,
        payMethodDirect: true,
        stripeChargesEnabled: false,
      },
    },
    attendances: [
      { userId: "a", status: "CONFIRMED", paymentMethod: null, paidAt: null, user: { id: "a", name: "Ali", phoneNumber: "+447700900001" } },
      { userId: "b", status: "CONFIRMED", paymentMethod: null, paidAt: null, user: { id: "b", name: "Ben", phoneNumber: "+447700900002" } },
    ],
  };
}

beforeEach(() => {
  botJobs.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("releaseMatchPayments holds the pay links during the club's quiet hours", () => {
  it("23:30 London: every link waits for 09:00 the next morning", async () => {
    matchRow = squad(ON);
    expect(await releaseMatchPayments("m1", { now: AT_23_30 })).toBe(2);
    expect(botJobs.map((j) => j.sendAfter)).toEqual([NEXT_09_00, NEXT_09_00]);
  });

  it("08:10 London: every link waits for 09:00 the same morning", async () => {
    matchRow = squad(ON);
    await releaseMatchPayments("m1", { now: AT_08_10 });
    expect(botJobs.map((j) => j.sendAfter)).toEqual([TODAY_09_00, TODAY_09_00]);
  });

  it("12:00 London: they send at once, as before", async () => {
    matchRow = squad(ON);
    await releaseMatchPayments("m1", { now: AT_12_00 });
    expect(botJobs.map((j) => j.sendAfter ?? null)).toEqual([null, null]);
  });

  it("quiet hours off: nothing waits, even at 23:30", async () => {
    matchRow = squad(OFF);
    await releaseMatchPayments("m1", { now: AT_23_30 });
    expect(botJobs.map((j) => j.sendAfter ?? null)).toEqual([null, null]);
  });

  it("the club's own window: quiet from 21:00 to 07:30 holds a 22:00 release until 07:30", async () => {
    matchRow = squad({ enabled: true, from: "21:00", to: "07:30" });
    await releaseMatchPayments("m1", { now: new Date("2026-10-21T21:00:00Z") });
    expect(botJobs.map((j) => j.sendAfter)).toEqual([new Date("2026-10-22T06:30:00Z"), new Date("2026-10-22T06:30:00Z")]);
  });

  it("no clock passed: the real one decides", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT_08_10);
    matchRow = squad(ON);
    await releaseMatchPayments("m1");
    expect(botJobs[0].sendAfter).toEqual(TODAY_09_00);
  });
});

function deps(quiet: QuietHours | undefined, now: Date, lang: "en" | "tr" = "en"): CollectorFeeDeps {
  return {
    now: () => now,
    pendingMatch: async () => ({
      id: "m1",
      name: "Tuesday 7-a-side",
      feePendingConfirm: 8,
      lang,
      payMethods: ["direct"],
      ...(quiet ? { quietHours: quiet } : {}),
    }),
    headcount: async () => 12,
    judge: async () => "neither",
    release: async () => 12,
    cancel: async () => {},
    stage: async () => {},
  };
}

describe("the collector's ack says when held links go out", () => {
  const SENT_EN =
    "✅ Done, sent 12 pay links at *£8* each for *Tuesday 7-a-side*. " +
    "Players pay you directly, and I'll let you know when someone says they have. I'll chase anyone who hasn't paid.";
  const HELD_EN =
    "✅ Done, 12 pay links at *£8* each for *Tuesday 7-a-side* are ready. " +
    "They go out at 09:00 London, when quiet hours end. " +
    "Players pay you directly, and I'll let you know when someone says they have. I'll chase anyone who hasn't paid.";
  const HELD_TR =
    "✅ Tamam, *Tuesday 7-a-side* için kişi başı *£8* üzerinden 12 ödeme linki hazır. " +
    "Sessiz saatler bitince, Londra saatiyle saat 09:00 olunca gönderilecek. " +
    "Oyuncular doğrudan sana ödeyecek, ödediğini söyleyen olursa sana haber veririm. Ödemeyenlere ben hatırlatırım.";

  it("23:30: held until 09:00 (EN and TR)", async () => {
    expect((await runCollectorFeeReply("✅", deps(ON, AT_23_30)))?.reply).toBe(HELD_EN);
    expect((await runCollectorFeeReply("✅", deps(ON, AT_23_30, "tr")))?.reply).toBe(HELD_TR);
  });

  it("08:10: held until 09:00", async () => {
    expect((await runCollectorFeeReply("✅", deps(ON, AT_08_10)))?.reply).toBe(HELD_EN);
  });

  it("12:00: sent, the ack as it was", async () => {
    expect((await runCollectorFeeReply("✅", deps(ON, AT_12_00)))?.reply).toBe(SENT_EN);
  });

  it("quiet hours off: sent, at any hour", async () => {
    expect((await runCollectorFeeReply("✅", deps(OFF, AT_23_30)))?.reply).toBe(SENT_EN);
  });

  it("a club window ending 07:30 names 07:30", async () => {
    const r = await runCollectorFeeReply("✅", deps({ enabled: true, from: "21:00", to: "07:30" }, AT_23_30));
    expect(r?.reply).toContain("They go out at 07:30 London, when quiet hours end.");
  });

  it("one link: singular", () => {
    expect(buildFeeReleasedAck({ released: 1, fee: 8, matchName: "Tuesday 7-a-side", methods: ["direct"], heldUntil: "09:00", lang: "en" })).toContain(
      "1 pay link at *£8* each for *Tuesday 7-a-side* is ready. It goes out at 09:00 London, when quiet hours end.",
    );
  });
});
