/**
 * F3, learned setup: THE ADVERSARIAL REVIEW OF SLICE D3 (PR #238,
 * 2026-10-12). Hand-written model answers run through the rules, each one
 * a way the first version could be made to switch a setting, or suggest a
 * fee, that the group never stated. Pure: no database, no model.
 *
 *   FIX 1  a placeholder fragment with no bracket ("number removed") was
 *          accepted as description evidence: now decided by POSITION, any
 *          description quote that overlaps or touches a masked span;
 *   FIX 2  a quote was found by raw substring ("paid" inside "Unpaid"):
 *          now at word boundaries for every source, and a description
 *          quote needs two words or eight characters;
 *   FIX 3  a number that is not a price counted as the fee ("7 a side"):
 *          now a currency sign or word beside the amount, in each excerpt,
 *          and never the price of the whole pitch;
 *   FIX 4  the placeholder rule dropped ordinary chat quotes with a
 *          bracket in them: chat is never masked, so it no longer applies
 *          to chat (the parity with main is main-parity.test.ts);
 *   FIX 5  an out-of-date fee in the description was stopped only by the
 *          prompt: now also by the server, and no fee is suggested for a
 *          club whose stored squad mode is monthly;
 *   FIX 8  WhatsApp formatting characters inside a quote broke the DM;
 *   FIX 9  the cases the reviewer found untested.
 */
import { describe, expect, it } from "vitest";
import {
  buildUserContent,
  parseDetection,
  planSetup,
  pricesIn,
  statesPrice,
  verifyEvidence,
  verifyEvidenceTagged,
  type OrgSettingsState,
  type WeeklyGameState,
} from "../rules";
import { composeSetupDm, quoteForDm, splitEvidence } from "../dm";
import { blankAnswer } from "./stubs";

const at = (text: string, day: number, author = "A") => ({
  author,
  text,
  timestamp: new Date(Date.UTC(2026, 8, day, 9)).toISOString(),
});

const DEFAULTS: OrgSettingsState = {
  rollingSquadEnabled: false,
  benchPickMode: "first-come",
  dropOutDeadlineDay: null,
  dropOutDeadlineTime: null,
  listPublishDay: null,
  listPublishTime: null,
  paymentTrackingEnabled: false,
  language: "en",
  settingsSetByOrganiser: [],
};
const GAME: WeeklyGameState = { dayOfWeek: 2, time: "21:00", venue: "Goals", playersPerSide: 6, feePerPlayer: null };

function plan(
  answer: Record<string, unknown>,
  history: ReturnType<typeof at>[],
  description: string | null,
  opts: { org?: Partial<OrgSettingsState>; game?: WeeklyGameState } = {},
) {
  const detection = parseDetection({ ...blankAnswer(), ...answer }, history, description)!;
  const game = opts.game ?? GAME;
  return {
    detection,
    plan: planSetup({
      detection,
      org: { ...DEFAULTS, ...opts.org },
      weeklyGame: game,
      activities: [{ dayOfWeek: game.dayOfWeek, time: game.time }],
    }),
  };
}
const fee = (amount: number, evidence: string[], confidence = "high") => ({
  match_fee: { amount, currency: "pounds", confidence, evidence },
});

describe("FIX 1: a placeholder is decided by where the quote sits, not by how it is spelt", () => {
  const DESC = "Send subs to Dave [number removed] by Friday. See [link removed]. Same squad every week.";
  const CHAT = [at("same squad every week", 7, "Dave"), at("in", 7, "Joe")];

  it("the reviewer's case: a bare fragment with no bracket is not evidence, and switches nothing", () => {
    const { plan: p } = plan(
      { squad: { answer: "rolling", confidence: "high", evidence: ["number removed", "same squad every week"] } },
      CHAT,
      DESC,
    );
    expect(p.applied).toEqual([]);
    expect(p.kept).toEqual([{ key: "rollingSquad", reason: "thin-evidence" }]);
    expect(JSON.stringify(p)).not.toContain("removed");
  });
  it("every way of cutting into a masked span is refused", () => {
    for (const q of [
      "number removed",
      "link removed",
      "number removed] by Friday",
      "[number removed]",
      "Dave [number removed] by",
      "See [link",
      "to Dave [",
      "removed]. Same squad",
      "umber remove",
    ]) {
      expect(verifyEvidenceTagged([q], [], DESC), q).toEqual([]);
    }
  });
  it("words that TOUCH a masked span are refused too: they would imply what stood there", () => {
    for (const q of ["Send subs to Dave", "subs to Dave", "by Friday", "by Friday.", "See"]) {
      expect(verifyEvidenceTagged([q], [], DESC), q).toEqual([]);
    }
  });
  it("a fee excerpt left with a dangling bracket is refused", () => {
    const d = "£6 each to Dave [number removed] before kick off";
    expect(plan(fee(6, ["£6 each to Dave ["]), [], d).detection.matchFee.amount).toBeNull();
    expect(plan(fee(6, ["£6 each to Dave"]), [], d).detection.matchFee.amount).toBeNull();
  });
  it("a sentence end or a line break ends the touch: the next sentence and the next line may be quoted", () => {
    expect(verifyEvidence(["Same squad every week"], [], DESC)).toEqual(["Same squad every week"]);
    const lines = "£6 a player, pay before kick off.\nPay Kemal [number removed]\nDrop out by Tuesday 6pm or you still pay.";
    expect(verifyEvidence(["Drop out by Tuesday 6pm or you still pay."], [], lines)).toEqual(["Drop out by Tuesday 6pm or you still pay."]);
    expect(verifyEvidence(["£6 a player, pay before kick off"], [], lines)).toEqual(["£6 a player, pay before kick off"]);
    expect(verifyEvidence(["Pay Kemal"], [], lines)).toEqual([]);
  });
  it("a quote that is clean in one place and masked in another is kept for the clean place", () => {
    const d = "Pay Sam [number removed]. Pay Sam before kick off please.";
    expect(verifyEvidenceTagged(["Pay Sam before kick off"], [], d)).toEqual([{ quote: "Pay Sam before kick off", source: "description" }]);
  });
  it("the email marker is treated the same", () => {
    const d = "Questions to [email removed] any time. Teams go up Friday at noon.";
    for (const q of ["email removed", "Questions to", "any time"]) expect(verifyEvidenceTagged([q], [], d), q).toEqual([]);
    expect(verifyEvidence(["Teams go up Friday at noon"], [], d)).toEqual(["Teams go up Friday at noon"]);
  });
});

describe("FIX 2: a quote is whole words, and the description needs more than a scrap", () => {
  it("the reviewer's case: 'paid' cut out of 'Unpaid' in the description is not a second source", () => {
    const chat = [at("paid", 7, "Joe"), at("in", 7, "Dele")];
    const { plan: p, detection } = plan(
      { payments: { answer: "players_confirm_paying", confidence: "high", evidence: ["paid", "paid"] } },
      chat,
      "Unpaid players sit out",
    );
    expect(detection.payments.evidence).toEqual(["paid"]);
    expect(detection.payments.fromDescription).toBeUndefined();
    expect(p.applied).toEqual([]);
    expect(p.kept).toEqual([{ key: "paymentTracking", reason: "thin-evidence" }]);
  });
  it("a description quote needs two words or eight characters, even as a whole word", () => {
    const d = "Paid players only. Everyone pays monthly.";
    expect(verifyEvidenceTagged(["Paid"], [], d)).toEqual([]);
    expect(verifyEvidenceTagged(["monthly"], [], d)).toEqual([]);
    expect(verifyEvidenceTagged(["Everyone"], [], d)).toEqual([{ quote: "Everyone", source: "description" }]);
    expect(verifyEvidenceTagged(["pays monthly"], [], d)).toEqual([{ quote: "pays monthly", source: "description" }]);
  });
  it("a short quote still counts from a chat message, as it always did", () => {
    expect(verifyEvidenceTagged(["paid", "in"], [at("paid", 1), at("in", 2)], null)).toEqual([{ quote: "paid", source: "chat" }]);
    expect(verifyEvidence(["Ödedim"], [at("Ödedim", 1)], null)).toEqual(["Ödedim"]);
  });
  it("word boundaries hold in a chat message too, at both ends", () => {
    const h = [at("Unpaid lads sit out, repaid later", 1), at("He rolled in late", 2)];
    for (const q of ["paid", "paid lads", "sit ou", "olled in"]) expect(verifyEvidence([q], h, null), q).toEqual([]);
    expect(verifyEvidence(["Unpaid lads sit out"], h, null)).toEqual(["Unpaid lads sit out"]);
    expect(verifyEvidence(["sit out"], h, null)).toEqual(["sit out"]);
  });
  it("punctuation and an apostrophe are boundaries; a quote may start or end on one", () => {
    const h = [at("Same squad, lads (shout if you can't). £6 each!", 1)];
    for (const q of ["Same squad", "squad, lads", "(shout if you can't)", "shout if you can", "£6 each", "6 each!"]) {
      expect(verifyEvidence([q], h, null), q).toEqual([q]);
    }
  });
  it("Turkish letters are letters: a word is not cut at ı, ş, ğ, ç, ö or ü", () => {
    const h = [at("Kadro aynı, gelmeyenler ödeyecek", 1), at("Çarşamba günü sahadayız", 2)];
    for (const q of ["Kadro ayn", "elmeyenler", "ödeyece", "arşamba günü", "Çarşamba gün"]) expect(verifyEvidence([q], h, null), q).toEqual([]);
    for (const q of ["Kadro aynı", "gelmeyenler ödeyecek", "Çarşamba günü"]) expect(verifyEvidence([q], h, null), q).toEqual([q]);
    const d = "Ücretsiz değil: gelmeyenler ödeyecek.";
    expect(verifyEvidenceTagged(["ücret", "cretsiz değil"], [], d)).toEqual([]);
    expect(verifyEvidenceTagged(["Ücretsiz değil"], [], d)).toEqual([{ quote: "Ücretsiz değil", source: "description" }]);
  });
  it("a later whole-word occurrence is found past an earlier cut one", () => {
    expect(verifyEvidence(["paid"], [at("unpaid? no, paid", 1)], null)).toEqual(["paid"]);
  });
});

describe("FIX 3: a fee excerpt must state a PRICE, not just a number", () => {
  it("statesPrice: a currency sign or word beside the amount", () => {
    for (const q of ["£6 each", "£ 6 a head", "6 quid each", "6 pounds a game", "6 pound each", "GBP 6", "6 GBP a player", "it's £6.00 now", "£6,00"]) {
      expect(statesPrice(q, 6), q).toBe(true);
    }
    expect(statesPrice("£6.50 each please", 6.5)).toBe(true);
    expect(statesPrice("50p each for the bibs fund", 0.5)).toBe(true);
  });
  it("statesPrice: a bare number, a time, a date, a size or another amount is not this price", () => {
    for (const q of [
      "7 a side",
      "at 6 lads",
      "by 6/10 please",
      "closes 6 Oct",
      "6pm kick off",
      "6:30 start",
      "6 each",
      "first 6 get a game",
      "£16 each",
      "£60 for the lot",
      "£6.50 each",
      "pay 6 to £Dave",
    ]) {
      expect(statesPrice(q, 6) || statesPrice(q, 7), q).toBe(false);
    }
  });
  it("statesPrice: the price of the whole pitch is not a price per player, in English or Turkish", () => {
    for (const q of ["Pitch is £45", "£45 for the pitch", "pitch costs £45 a week", "Saha £45", "saha ücreti toplam £45", "£45 total"]) {
      expect(statesPrice(q, 45), q).toBe(false);
    }
    // A price per player that mentions the pitch is still a price per player.
    for (const q of ["Pitch has gone up, so it's £7 each", "£7 a head now the pitch went up", "saha zamlandı, kişi başı £7"]) {
      expect(statesPrice(q, 7), q).toBe(true);
    }
  });
  it("pricesIn: every price a text states, per player", () => {
    expect(pricesIn("£6 each, or £3 for under 16s")).toEqual([6, 3]);
    expect(pricesIn("see you at 6, 7 a side")).toEqual([]);
    expect(pricesIn("Pitch is £45")).toEqual([]);
  });

  const SIDE = [at("7 a side this week", 7, "Kemal"), at("7 a side again", 14, "Kemal")];
  it("the reviewer's cases: none of them is a fee", () => {
    expect(plan(fee(7, ["7 a side this week", "7 a side again"]), SIDE, null).detection.matchFee.amount).toBeNull();
    const mixed = [at("£6 each please", 7, "Kemal"), at("see you at 6 lads", 14, "Kemal")];
    const m = plan(fee(6, ["£6 each", "at 6 lads"]), mixed, null);
    expect(m.detection.matchFee.evidence).toEqual(["£6 each"]);
    expect(m.plan.suggestions).toEqual([]);
    const dates = [at("names by 6/10 please", 7, "Kemal"), at("list closes 6 Oct", 14, "Kemal")];
    expect(plan(fee(6, ["by 6/10 please", "closes 6 Oct"]), dates, null).detection.matchFee.amount).toBeNull();
    expect(plan(fee(45, ["Pitch is £45"]), [], "Pitch is £45 a week, split between us").detection.matchFee.amount).toBeNull();
  });
  it("two messages that each state the price still suggest it", () => {
    const h = [at("£6 each please", 7, "Kemal"), at("6 quid each lads", 14, "Kemal")];
    expect(plan(fee(6, ["£6 each please", "6 quid each"]), h, null).plan.suggestions).toEqual([
      { key: "matchFee", current: "", detected: "6", evidence: ["£6 each please", "6 quid each"] },
    ]);
  });
});

describe("FIX 4: the placeholder rule is for the description only", () => {
  it("a chat line with a bracket or the word 'removed' is quoted as it always was", () => {
    const h = [at("I removed] him from the list", 1), at("[link to pitch] here lads", 2), at("number removed from the gate, use the side door", 3)];
    expect(verifyEvidence(["I removed] him"], h, null)).toEqual(["I removed] him"]);
    expect(verifyEvidence(["[link to pitch] here"], h, null)).toEqual(["[link to pitch] here"]);
    expect(verifyEvidence(["number removed from the gate"], h, null)).toEqual(["number removed from the gate"]);
  });
  it("and counts as the chat even when the club has a description", () => {
    const h = [at("[number removed] is what the bot wrote, odd", 1)];
    expect(verifyEvidenceTagged(["is what the bot wrote"], h, "Pay Sam [number removed]")).toEqual([
      { quote: "is what the bot wrote", source: "chat" },
    ]);
  });
});

describe("FIX 5: the server stops an out-of-date fee, and a monthly club", () => {
  it("the reviewer's case: the description's £4 is not suggested when a message states £6 each", () => {
    const h = [at("£6 each lads", 7, "Kemal"), at("in", 7, "Joe")];
    const { plan: p, detection } = plan(fee(4, ["£4 a game"]), h, "£4 a game. Tuesdays.");
    expect(detection.matchFee.amount).toBeNull();
    expect(p.suggestions).toEqual([]);
  });
  it("a message stating the SAME price does not stop it, nor does a number that is no price", () => {
    const same = [at("£4 each as usual", 7, "Kemal"), at("see you at 6, 7 a side", 8, "Joe")];
    expect(plan(fee(4, ["£4 a game"]), same, "£4 a game. Tuesdays.").plan.suggestions.map((s) => [s.key, s.detected])).toEqual([["matchFee", "4"]]);
  });
  it("the chat's own fee, twice, is still suggested over the description's", () => {
    const h = [at("£6 each from now on", 7, "Kemal"), at("£6 each lads", 14, "Kemal")];
    const { plan: p } = plan(fee(6, ["£6 each from now on", "£6 each lads"]), h, "£4 a game. Tuesdays.");
    expect(p.suggestions).toEqual([{ key: "matchFee", current: "", detected: "6", evidence: ["£6 each from now on", "£6 each lads"] }]);
  });
  it("a fee backed by the description AND a message loses only the description when another message states another price", () => {
    const h = [at("£4 each", 7, "Kemal"), at("£6 each now", 14, "Kemal")];
    const { detection, plan: p } = plan(fee(4, ["£4 a game", "£4 each"]), h, "£4 a game. Tuesdays.");
    expect(detection.matchFee).toMatchObject({ amount: 4, evidence: ["£4 each"] });
    expect(detection.matchFee.fromDescription).toBeUndefined();
    expect(p.suggestions).toEqual([]);
  });
  it("no fee is suggested for a club whose stored squad mode is monthly, whatever the model says of a monthly list", () => {
    const d = "£6 a player, pay before kick off.";
    expect(plan(fee(6, ["£6 a player"]), [], d).plan.suggestions.map((s) => s.key)).toEqual(["matchFee"]);
    expect(plan(fee(6, ["£6 a player"]), [], d, { org: { monthlySquad: true } }).plan.suggestions).toEqual([]);
  });
});

describe("FIX 9: what the description is, and is not", () => {
  it("lines dressed up as messages inside the description are the description: one source", () => {
    const d = "[Mon 7 Sep 10:00] Steve Hart: Same squad as ever lads\n[Mon 14 Sep 10:00] Steve Hart: Same squad again, shout if out";
    const tagged = verifyEvidenceTagged(["Same squad as ever lads", "Same squad again, shout if out"], [at("in", 1)], d);
    expect(tagged).toEqual([{ quote: "Same squad as ever lads", source: "description" }]);
    const { plan: p } = plan(
      { squad: { answer: "rolling", confidence: "high", evidence: ["Same squad as ever lads", "Same squad again, shout if out"] } },
      [at("in", 1)],
      d,
    );
    expect(p.applied).toEqual([]);
  });
  it("the server's own labels and message headers are not anybody's words", () => {
    const h = [at("Same squad as ever lads", 7, "Steve Hart"), at("in", 8, "Joe")];
    const d = "Tuesdays at Goals, same squad every week.";
    const { text } = buildUserContent({ groupSubject: "Tuesday 6s", weeklyGame: GAME, history: h, description: d });
    // Each of these IS in what the model was sent, and none is in a message or the description.
    for (const q of [
      "Group description (one source, written by a group admin, maybe long ago)",
      "Weekly game the organiser entered: tuesday 21:00",
      "Group name: Tuesday 6s",
      "Messages (2, oldest first, London time)",
      "Steve Hart: Same squad as ever lads",
      "10:00] Steve Hart: Same squad",
    ]) {
      expect(text, q).toContain(q);
      expect(verifyEvidenceTagged([q], h, d), q).toEqual([]);
    }
  });
  it("a quote cannot span the description and the first message", () => {
    const h = [at("Same squad as ever lads", 7, "Steve")];
    const d = "Tuesdays at Goals.";
    for (const q of ["at Goals. Same squad", "Goals. Same squad as ever", "Tuesdays at Goals. Same squad as ever lads"]) {
      expect(verifyEvidenceTagged([q], h, d), q).toEqual([]);
    }
  });
});

describe("FIX 8: a quote is shown as the words it is, whatever characters are in it", () => {
  it("WhatsApp's formatting characters are swapped for look-alikes it does not act on", () => {
    expect(quoteForDm("*IN* for _Tuesday_ ~maybe~ `list`")).toBe("∗IN∗ for ˍTuesdayˍ ∼maybe∼ 'list'");
    expect(quoteForDm("*IN* for _Tuesday_ ~maybe~ `list`")).not.toMatch(/[*_~`]/);
  });
  it("a double quote inside becomes a single one, so the line's own quote marks stay a pair", () => {
    expect(quoteForDm('say "in')).toBe("say 'in");
    expect(quoteForDm("say “in” please")).toBe("say 'in' please");
  });
  it("an ordinary quote is not changed at all", () => {
    for (const q of ["Same lot as last week, let me know if you can't do Tuesday", "Kadro geçen haftakiyle aynı, olmayan yazsın", "£6 a player, pay before kick off."]) {
      expect(quoteForDm(q)).toBe(q);
    }
  });
  it("in the DM, for a message and for the description, in both languages; the stored quote is untouched for the page", () => {
    const item = {
      key: "dropOutDeadline" as const,
      from: null,
      to: { day: 1, time: "21:00" },
      evidence: ["*Drop out* by Monday 9pm", 'Out by _Monday 9pm_ or "pay'],
      fromDescription: ['Out by _Monday 9pm_ or "pay'],
      undoneAt: null,
      undoUrl: "https://mt.link/undo",
    };
    const dm = (lang: string) =>
      composeSetupDm({
        lang,
        group: "Tuesday 6s",
        applied: [item],
        suggestions: [],
        noted: [],
        scheduleUrl: "https://mt.link/activities",
        settingsUrl: "https://mt.link/settings",
        organiserPicksUrl: "https://mt.link/pick",
      });
    expect(dm("en")).toContain(
      `✅ *Drop-out deadline:* Monday 21:00. MatchTime reminds the group before it.\n` +
        `From messages like: "∗Drop out∗ by Monday 9pm"\n` +
        `From your group description: "Out by ˍMonday 9pmˍ or 'pay"\n` +
        `Undo or change: https://mt.link/undo`,
    );
    expect(dm("tr")).toContain(`Şu tür mesajlardan: "∗Drop out∗ by Monday 9pm"\nGrup açıklamanızdan: "Out by ˍMonday 9pmˍ or 'pay"\n`);
    // The only asterisks left are MatchTime's own bold, a pair.
    expect(dm("en").match(/\*/g)).toHaveLength(2);
    expect(splitEvidence(item)).toEqual({ chat: ["*Drop out* by Monday 9pm"], description: ['Out by _Monday 9pm_ or "pay'] });
  });
});
