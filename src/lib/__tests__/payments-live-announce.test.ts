/**
 * ONE group post when a club's payment collection goes live (2026-09-30).
 *
 * "Live" is BOTH switches: the organiser turned payment collection on in
 * settings AND the collector's Stripe account can take charges. Whichever
 * of the two happens second is the moment the club can actually be
 * charged, and that is when the group is told how it works. Never twice
 * for the same activation (a `SentNotification` key on the org and the
 * connected account), never for a club that was already live (Sutton FC
 * has been live since 2026-06-09 and is not told again), and in the
 * club's language.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const orgFindUnique = vi.fn();
const userFindUnique = vi.fn();
const sentCreate = vi.fn();
const botJobCreate = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    organisation: { findUnique: (...a: unknown[]) => orgFindUnique(...a) },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    sentNotification: { create: (...a: unknown[]) => sentCreate(...a) },
    botJob: { create: (...a: unknown[]) => botJobCreate(...a) },
  },
}));

import {
  announcePaymentsLiveIfJustLive,
  buildPaymentsLiveAnnouncement,
  isPaymentCollectionLive,
  paymentsLiveKey,
} from "@/lib/payments-live-announce";

const ORG = "org-mt-test";

function org(over: Record<string, unknown> = {}) {
  return {
    id: ORG,
    language: "en",
    whatsappGroupId: "120363408471622062@g.us",
    whatsappBotEnabled: true,
    paymentCollectionEnabled: true,
    stripeConnectAccountId: "acct_123",
    stripeChargesEnabled: true,
    payMethodCard: true,
    payMethodPayByBank: true,
    payMethodDirect: true,
    paymentHolderId: "u-kemal",
    ...over,
  };
}

beforeEach(() => {
  orgFindUnique.mockReset();
  userFindUnique.mockReset().mockResolvedValue({ name: "Kemal Ediz" });
  sentCreate.mockReset().mockResolvedValue({ id: "sn1" });
  botJobCreate.mockReset().mockResolvedValue({ id: "bj1" });
});

describe("isPaymentCollectionLive", () => {
  it("needs the feature on, an account, and charges enabled", () => {
    expect(isPaymentCollectionLive(org())).toBe(true);
    expect(isPaymentCollectionLive(org({ paymentCollectionEnabled: false }))).toBe(false);
    expect(isPaymentCollectionLive(org({ stripeConnectAccountId: null }))).toBe(false);
    expect(isPaymentCollectionLive(org({ stripeChargesEnabled: false }))).toBe(false);
    expect(isPaymentCollectionLive(null)).toBe(false);
  });
});

describe("the announcement text", () => {
  it("English, every method on", () => {
    expect(buildPaymentsLiveAnnouncement({ lang: "en", collector: "Kemal", card: true, bank: true, direct: true })).toBe(
      "💳 *Match fees now go through MatchTime*\n\n" +
        "Here's how it works:\n" +
        "• After each game I'll DM everyone who played a link to pay their share.\n" +
        "• You can pay by card, Apple Pay, Google Pay or straight from your bank.\n" +
        "• The amount is the match fee split between the players, with the card or bank fee added on top.\n" +
        "• If you haven't paid, I'll send you a reminder.\n" +
        "• Paying Kemal directly is fine too. Just DM me *Paid* and Kemal will confirm it.",
    );
  });

  it("Turkish, every method on", () => {
    expect(buildPaymentsLiveAnnouncement({ lang: "tr", collector: "Kemal", card: true, bank: true, direct: true })).toBe(
      "💳 *Maç ücretleri artık MatchTime üzerinden toplanıyor*\n\n" +
        "Nasıl işliyor:\n" +
        "• Her maçtan sonra oynayan herkese, payını ödemesi için özelden bir link gönderiyorum.\n" +
        "• Kartla, Apple Pay, Google Pay ile ya da doğrudan bankanızdan ödeyebilirsiniz.\n" +
        "• Tutar, maç ücretinin oyuncular arasında bölünmüş payı, üstüne de kart ya da banka ücreti.\n" +
        "• Ödemeyenlere hatırlatma gönderiyorum.\n" +
        "• Ödemeyi doğrudan Kemal ile halletmek de olur. Bana özelden *Ödedim* yazın, Kemal onaylasın.",
    );
  });

  it("follows the club's methods: card only, no direct line", () => {
    const text = buildPaymentsLiveAnnouncement({ lang: "en", collector: null, card: true, bank: false, direct: false });
    expect(text).toContain("• You can pay by card, Apple Pay or Google Pay.\n");
    expect(text).toContain("with the card fee added on top.");
    expect(text).not.toContain("directly");
    expect(text).not.toContain("bank");
  });

  it("bank only, and an unknown collector is 'the organiser'", () => {
    const text = buildPaymentsLiveAnnouncement({ lang: "en", collector: null, card: false, bank: true, direct: true });
    expect(text).toContain("• You can pay straight from your bank.\n");
    expect(text).toContain("with the bank fee added on top.");
    expect(text).toContain("Paying the organiser directly is fine too. Just DM me *Paid* and the organiser will confirm it.");
  });

  it("has no em or en dash in any variant", () => {
    for (const lang of ["en", "tr"] as const)
      for (const card of [true, false])
        for (const bank of [true, false])
          for (const direct of [true, false]) {
            const text = buildPaymentsLiveAnnouncement({ lang, collector: null, card, bank, direct });
            expect(text).not.toMatch(/[—–]/);
          }
  });
});

describe("announcePaymentsLiveIfJustLive", () => {
  it("posts once to the group when the club has just gone live", async () => {
    orgFindUnique.mockResolvedValue(org());
    const r = await announcePaymentsLiveIfJustLive(ORG, { wasLive: false });
    expect(r).toEqual({ announced: true });
    expect(sentCreate).toHaveBeenCalledWith({
      data: { key: paymentsLiveKey(ORG, "acct_123"), kind: "payments-live" },
    });
    expect(botJobCreate).toHaveBeenCalledTimes(1);
    const job = botJobCreate.mock.calls[0][0].data;
    expect(job.orgId).toBe(ORG);
    expect(job.kind).toBe("group");
    expect(job.text).toContain("Paying Kemal directly");
  });

  it("claims the ledger row BEFORE the post", async () => {
    orgFindUnique.mockResolvedValue(org());
    const order: string[] = [];
    sentCreate.mockImplementation(async () => order.push("ledger"));
    botJobCreate.mockImplementation(async () => order.push("post"));
    await announcePaymentsLiveIfJustLive(ORG, { wasLive: false });
    expect(order).toEqual(["ledger", "post"]);
  });

  it("never twice for the same activation: a taken key posts nothing", async () => {
    orgFindUnique.mockResolvedValue(org());
    sentCreate.mockRejectedValue(Object.assign(new Error("Unique constraint"), { code: "P2002" }));
    expect(await announcePaymentsLiveIfJustLive(ORG, { wasLive: false })).toEqual({
      announced: false,
      reason: "already-announced",
    });
    expect(botJobCreate).not.toHaveBeenCalled();
  });

  it("a club that was ALREADY live is not told (Sutton FC, retroactively)", async () => {
    orgFindUnique.mockResolvedValue(org());
    expect(await announcePaymentsLiveIfJustLive(ORG, { wasLive: true })).toEqual({
      announced: false,
      reason: "was-already-live",
    });
    expect(sentCreate).not.toHaveBeenCalled();
    expect(botJobCreate).not.toHaveBeenCalled();
  });

  it("not live yet (the other switch is still off): nothing", async () => {
    orgFindUnique.mockResolvedValue(org({ stripeChargesEnabled: false }));
    expect((await announcePaymentsLiveIfJustLive(ORG, { wasLive: false })).announced).toBe(false);
    expect(botJobCreate).not.toHaveBeenCalled();
  });

  it("no group, or the bot switched off: nothing, and the key is not spent", async () => {
    orgFindUnique.mockResolvedValue(org({ whatsappGroupId: null }));
    expect((await announcePaymentsLiveIfJustLive(ORG, { wasLive: false })).announced).toBe(false);
    orgFindUnique.mockResolvedValue(org({ whatsappBotEnabled: false }));
    expect((await announcePaymentsLiveIfJustLive(ORG, { wasLive: false })).announced).toBe(false);
    expect(sentCreate).not.toHaveBeenCalled();
    expect(botJobCreate).not.toHaveBeenCalled();
  });

  it("speaks the club's language", async () => {
    orgFindUnique.mockResolvedValue(org({ language: "tr" }));
    await announcePaymentsLiveIfJustLive(ORG, { wasLive: false });
    expect(botJobCreate.mock.calls[0][0].data.text).toMatch(/^💳 \*Maç ücretleri/);
  });

  it("uses the collector's first name", async () => {
    orgFindUnique.mockResolvedValue(org());
    userFindUnique.mockResolvedValue({ name: "Hilal Celep" });
    await announcePaymentsLiveIfJustLive(ORG, { wasLive: false });
    expect(botJobCreate.mock.calls[0][0].data.text).toContain("Paying Hilal directly");
  });

  it("never throws: a failure is logged and reported", async () => {
    orgFindUnique.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await announcePaymentsLiveIfJustLive(ORG, { wasLive: false })).announced).toBe(false);
    spy.mockRestore();
  });
});
