/**
 * GUARD: NO PAYMENT MESSAGE BYPASSES THE CLUB'S PAYMENT FLAGS (2026-11-03).
 *
 * Kemal: "once payment tracking is off for a club, there is no need to DM
 * anybody about payment reminders." The Vets (monthly, both flags off) got
 * a daily "💷 13 say they've paid for November ... Reply PAID ALL" DM,
 * because the monthly money flow read neither flag.
 *
 * Every file that SENDS a payment message (calls one of the payment copy
 * builders below) must read the flags: `paymentMessagesOn` (the outer
 * gate, `payment-messages.ts`), or the narrower flag it has always needed
 * (`paymentCollectionEnabled`, `paymentTrackingEnabled`,
 * `isPaymentCollectionLive`). A new sender that does neither fails here
 * until it is gated, or listed below with the reason it is not a payment
 * message. The copy files that only BUILD the words are not senders.
 *
 * And the scheduler's single exit drops every payment-keyed instruction
 * when payments are off, whichever section made it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../..");

/** A payment message's words: the builders and the i18n keys for them. */
const PAYMENT_BUILDER =
  /\b(build(?:Fee(?:AskDm|ConfirmPrompt|CancelledAck|ReleasedAck)|PayChaseDm|PayLinkDm|PaidClaimAck(?:Dm)?|PaidForOthersReply|PricedListPost|PriceAskNotice|PayBySummary|GroupPayReminder|PayReminderDm|ClaimsDigest|UnpaidListAdminNotice|UnpaidGroupReminder|UnpaidTail(?:Text)?|PaymentPollQuestion|DirectPayCollector(?:Notice|Nudge)|LeaverNotice|ShareChangeNotice|MidMonthJoinDm|MonthSummaryNotice|PaymentsLiveAnnouncement)|claimsDigestMessage|dm_free_place|not_played_paid|dm_direct_pay_notice|mpy_[a-z_]+)\(/;

/** Reading either flag, or the gate itself. */
const READS_FLAGS = /paymentMessagesOn(?:For)?\(|paymentCollectionEnabled|paymentTrackingEnabled|isPaymentCollectionLive\(/;

/** Files that only build the words (copy), never send them. */
const COPY_ONLY = new Set([
  "lib/dm-copy.ts",
  "lib/scheduler-copy.ts",
  "lib/month-payment-copy.ts",
  "lib/month-close-copy.ts",
  "lib/monthly-week-copy.ts",
]);

/** Senders reviewed on 2026-11-03 that need no flag, and why. Empty today. */
const REVIEWED_UNGATED = new Map<string, string>([]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "generated" || name === "i18n" || name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const senders = sourceFiles(SRC)
  .map((f) => ({ rel: path.relative(SRC, f), text: readFileSync(f, "utf8") }))
  .filter((f) => !COPY_ONLY.has(f.rel) && PAYMENT_BUILDER.test(f.text));

describe("every payment message sender reads the club's payment flags", () => {
  it("finds the senders (the scan is alive)", () => {
    const rels = senders.map((s) => s.rel);
    for (const known of ["lib/bot-scheduler.ts", "lib/month-payment.ts", "lib/month-close.ts", "lib/fee-waiver.ts", "lib/match-cancel.ts", "lib/direct-payment.ts"]) {
      expect(rels).toContain(known);
    }
  });

  it.each(senders.map((s) => [s.rel, s.text] as const))("%s", (rel, text) => {
    if (REVIEWED_UNGATED.has(rel)) return;
    expect(READS_FLAGS.test(text), `${rel} sends a payment message but reads neither payment flag (use paymentMessagesOn, payment-messages.ts)`).toBe(true);
  });

  it("the monthly money flow, which read neither flag, now passes the outer gate", () => {
    const monthPayment = readFileSync(path.join(SRC, "lib/month-payment.ts"), "utf8");
    // The sweep (price ask, digest, summary), the posts, the player's ack, the collector's answer.
    expect(monthPayment.match(/paymentMessagesOn\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    const monthClose = readFileSync(path.join(SRC, "lib/month-close.ts"), "utf8");
    expect(monthClose).toMatch(/paymentMessagesOn\(/);
  });

  it("the scheduler's single exit drops payment-keyed instructions when payments are off", () => {
    const scheduler = readFileSync(path.join(SRC, "lib/bot-scheduler.ts"), "utf8");
    expect(scheduler).toMatch(/if \(!paymentsOn && isPaymentMessageKey\(instr\.key\)\) return false;/);
    expect(scheduler).toMatch(/if \(paymentMessagesOnFor\(features\)\) out\.push\(\.\.\.\(await monthPaymentPosts\(/);
  });
});
