/**
 * ONE RULE FOR "PAYMENTS ARE ON FOR THIS CLUB" ON EVERY DOOR (club summary,
 * slice B3; decision K2, Kemal 2026-11-04).
 *
 * The rule is the existing `paymentMessagesOn` (payment-messages.ts):
 * payments are on when the club tracks who has paid OR collects match fees,
 * and off only when both flags are off. The club summary exposes it as
 * `payments.messagesOn`. Before B3 three doors used another rule (plan
 * D3): the credit command needed tracking alone, the help's payments topic
 * and the settings page's Payments line needed collection alone. And "can
 * this club take a card" was spelled four ways (D4); it is now ONE rule,
 * `isPaymentCollectionLive` (collection on, a connected account that can
 * take charges), and the card and Pay by Bank methods read it.
 *
 * The two shapes with exactly one flag on are the ones that moved:
 *   - collection only (Sutton FC in production);
 *   - tracking only (an older club that still has the hidden poll on).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { availablePayMethods, isPaymentCollectionLive } from "../payments";
import { isPaymentCollectionLive as liveFromAnnounce } from "../payments-live-announce";
import { buildHelpReply, type HelpFeatures } from "../onboarding-conversation";
import { paymentsSummary } from "../settings-summaries";
import { decide } from "../pipeline/engine";
import { msg, world, NOW } from "../pipeline/__tests__/helpers";
import { helloInputFromOrg } from "../group-hello";

const SRC = path.resolve(__dirname, "../..");

// ── The card rule (D4) ─────────────────────────────────────────────────

const STRIPE = { stripeConnectAccountId: "acct_1", stripeChargesEnabled: true } as const;
const ALL_METHODS = { payMethodPayByBank: true, payMethodCard: true, payMethodDirect: true } as const;

describe("can this club take a card: one rule", () => {
  it("is collection on, a connected account and charges enabled, and the announcement uses the same function", () => {
    expect(isPaymentCollectionLive({ paymentCollectionEnabled: true, ...STRIPE })).toBe(true);
    expect(isPaymentCollectionLive({ paymentCollectionEnabled: false, ...STRIPE })).toBe(false);
    expect(isPaymentCollectionLive({ paymentCollectionEnabled: true, stripeConnectAccountId: null, stripeChargesEnabled: true })).toBe(false);
    expect(isPaymentCollectionLive({ paymentCollectionEnabled: true, stripeConnectAccountId: "acct_1", stripeChargesEnabled: false })).toBe(false);
    expect(liveFromAnnounce).toBe(isPaymentCollectionLive);
  });

  it("card and Pay by Bank are offered only when the club can take a card; paying directly needs only its switch", () => {
    expect(availablePayMethods({ ...ALL_METHODS, paymentCollectionEnabled: true, ...STRIPE })).toEqual(["pay_by_bank", "card", "direct"]);
    // Tracking only, with a Stripe account left over: no card, no bank.
    expect(availablePayMethods({ ...ALL_METHODS, paymentCollectionEnabled: false, ...STRIPE })).toEqual(["direct"]);
    // Charges enabled but no account on record: no card.
    expect(availablePayMethods({ ...ALL_METHODS, paymentCollectionEnabled: true, stripeConnectAccountId: null, stripeChargesEnabled: true })).toEqual(["direct"]);
  });

  it("the group hello asks the same rule (it no longer restates it)", () => {
    const row = {
      squadMode: "weekly",
      language: "en",
      featureAttendance: true,
      featureSquadFromList: false,
      rollingSquadEnabled: false,
      dropOutDeadlineDay: null,
      dropOutDeadlineTime: null,
      listPublishDay: null,
      listPublishTime: null,
      ...ALL_METHODS,
      ...STRIPE,
    };
    const on = helloInputFromOrg({ ...row, paymentCollectionEnabled: true } as never, "Kemal");
    const off = helloInputFromOrg({ ...row, paymentCollectionEnabled: false } as never, "Kemal");
    expect(JSON.stringify(on)).toContain('"card-and-bank"');
    expect(JSON.stringify(off)).not.toContain("card");
  });

  it("no file restates the card rule or the payments rule inline", () => {
    /** Narrower rules that name both flags on purpose, with the reason. */
    const NARROWER = new Map<string, string>([
      [
        "lib/pipeline/payment-answer.ts",
        // `matchHasPaymentSource`: does MatchTime know who paid THIS match
        // (the poll for any match, collection once its links are out).
        "return input.paymentTracking || (input.paymentCollection && input.paymentLinksReleasedAt !== null);",
      ],
    ]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (["__tests__", "generated", "node_modules", "__fixtures__"].includes(name)) continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
        const rel = path.relative(SRC, full);
        const narrower = NARROWER.get(rel);
        const raw = readFileSync(full, "utf8");
        if (narrower) expect(raw, `${rel} still has its narrower rule`).toContain(narrower);
        const text = narrower ? raw.replace(narrower, "") : raw;
        // "a card can be taken": the account AND charges, outside its home.
        if (rel !== "lib/payments.ts" && /stripeConnectAccountId\s*&&[^;\n]*stripeChargesEnabled|stripeChargesEnabled\s*&&[^;\n]*stripeConnectAccountId/.test(text)) offenders.push(`${rel}: card rule`);
        // "payments are on": the two flags combined, outside its home.
        if (
          rel !== "lib/payment-messages.ts" &&
          /paymentTracking(?:Enabled)?\b[^;\n]{0,40}(?:\|\||&&)[^;\n]{0,40}paymentCollection(?:Enabled)?\b|paymentCollection(?:Enabled)?\b[^;\n]{0,40}(?:\|\||&&)[^;\n]{0,40}paymentTracking(?:Enabled)?\b/.test(
            // The copy files build words from the flags they are handed.
            rel.startsWith("lib/i18n/") ? "" : text,
          )
        )
          offenders.push(`${rel}: payments rule`);
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});

// ── The credit command ("Amir paid for 4") ─────────────────────────────

describe("an organiser's credit for others follows the rule", () => {
  const credit = (features: { paymentTracking: boolean; paymentCollection?: boolean }) =>
    decide({
      now: NOW,
      state: world({
        confirmed: ["kemal", "elvin", "sait", "amir"],
        features,
        completedMatch: { id: "done-1", redScore: null, yellowScore: null, participantUserIds: ["u-kemal", "u-elvin", "u-sait", "u-amir"] },
      }),
      messages: [
        msg({
          from: "elvin",
          body: "@Match Time Amir paid for 4 players",
          route: "admin_ops",
          tagged: true,
          facts: { kind: "admin", action: "bulk_payment", payerRef: "Amir", count: 4 },
        }),
      ],
    });

  it("collection only (Sutton FC): the credit is recorded", () => {
    const r = credit({ paymentTracking: false, paymentCollection: true });
    expect(r.writes.some((w) => w.kind === "payment_credit")).toBe(true);
  });

  it("tracking only: the credit is recorded, as before", () => {
    const r = credit({ paymentTracking: true, paymentCollection: false });
    expect(r.writes.some((w) => w.kind === "payment_credit")).toBe(true);
  });

  it("both off: refused, and the reason names payments, not tracking", () => {
    const r = credit({ paymentTracking: false, paymentCollection: false });
    expect(r.writes).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/payments are off for this club/);
  });
});

// ── The help's payments topic ──────────────────────────────────────────

const FEATURES: HelpFeatures = {
  attendance: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  statsQa: true,
  reminders: true,
  bench: true,
  paymentTracking: false,
  paymentCollection: false,
};
const TRACKING_ONLY: HelpFeatures = { ...FEATURES, paymentTracking: true };
const COLLECTION_ONLY: HelpFeatures = { ...FEATURES, paymentCollection: true };
const LANGS = ["en", "tr"] as const;

describe("help payments follows the rule", () => {
  for (const lang of LANGS) {
    it(`${lang}: tracking only, the topic is on and explains what MatchTime does for that club`, () => {
      const group = buildHelpReply("payments", TRACKING_ONLY, lang, { audience: "group" });
      const off = buildHelpReply("payments", FEATURES, lang, { audience: "group" });
      // Not the "isn't switched on" lead the off state gets.
      expect(group).not.toContain(off.split("\n")[0]);
      // Not the fee collection explainer: this club sends no pay links.
      expect(group).not.toMatch(/link to pay|ödeme bağlantı/i);
      expect(group).toContain(lang === "en" ? "who has paid" : "kimin ödediğini");
      expect(group).not.toMatch(/[–—]/);
    });

    it(`${lang}: tracking only, bare help lists payments`, () => {
      const word = lang === "en" ? "help payments" : "yardım ödeme";
      expect(buildHelpReply(null, TRACKING_ONLY, lang, { audience: "group" })).toContain(word);
      expect(buildHelpReply(null, FEATURES, lang, { audience: "group" })).not.toContain(`*@Match Time ${word}*:`);
    });

    it(`${lang}: an organiser hears how to record a payment made for others, with either flag`, () => {
      for (const f of [TRACKING_ONLY, COLLECTION_ONLY]) {
        const admin = buildHelpReply("payments", f, lang, { audience: "admin", links: { topic: "https://mt/s" } });
        expect(admin).toContain(lang === "en" ? "@Match Time Amir paid for Sam and Alex" : "@Match Time Amir, Sam ve Alex için ödedi");
        // A player is not told about an organiser's command.
        const player = buildHelpReply("payments", f, lang, { audience: "player" });
        expect(player).not.toContain("Amir");
      }
    });
  }

  it("collection only: unchanged for players (fee collection explained, on)", () => {
    const r = buildHelpReply("payments", COLLECTION_ONLY, "en", { audience: "group" });
    expect(r).toContain("*Match fees: how it works*");
    expect(r).toContain("It's on for this club.");
  });
});

// ── The settings page's Payments line ──────────────────────────────────

describe("the settings page's Payments line follows the rule", () => {
  it("tracking only is on, in both languages", () => {
    const en = paymentsSummary("en", { tracking: true, collecting: false, bankConnected: false });
    const tr = paymentsSummary("tr", { tracking: true, collecting: false, bankConnected: false });
    expect(en).toBe("Keeping track of who has paid");
    expect(tr).toBe("Kimin ödediği takip ediliyor");
  });

  it("both off is off; collection reads as before", () => {
    expect(paymentsSummary("en", { tracking: false, collecting: false, bankConnected: true })).toBe("Not collecting match fees");
    expect(paymentsSummary("en", { tracking: false, collecting: true, bankConnected: true })).toBe("Collecting match fees, bank connected");
    expect(paymentsSummary("en", { tracking: true, collecting: true, bankConnected: false })).toBe("Collecting match fees, bank not connected yet");
  });
});
