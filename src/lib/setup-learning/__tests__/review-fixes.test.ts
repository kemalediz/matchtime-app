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
 *   FIX 3  a number that is not a price counted as the fee ("7 a side").
 *          Since 2026-10-30 (no string parsing) the MODEL says the price
 *          and whether it is per player or for the whole pitch; the server
 *          checks only that each quote holds the number;
 *   FIX 4  the placeholder rule dropped ordinary chat quotes with a
 *          bracket in them: chat is never masked, so it no longer applies
 *          to chat (the parity with main is main-parity.test.ts);
 *   FIX 5  no fee is suggested for a club whose stored squad mode is
 *          monthly. (An out-of-date fee in the description was also stopped
 *          by reading the chat for other prices; since 2026-10-30 that is
 *          the model's ruling alone, as the prompt states it);
 *   FIX 8  WhatsApp formatting characters inside a quote broke the DM;
 *   FIX 9  the cases the reviewer found untested.
 */
import { describe, expect, it } from "vitest";
import {
  buildUserContent,
  parseDetection,
  planSetup,
  quoteHasAmount,
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
const fee = (amount: number, evidence: string[], confidence = "high", basis = "per_player") => ({
  match_fee: { amount, currency: "pounds", basis, confidence, evidence },
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

describe("FIX 3, REDONE 2026-10-30 (no string parsing): the model says what the price is; the server checks the number is in the quote", () => {
  it("quoteHasAmount: the number, written on its own", () => {
    for (const q of ["£6 each", "£ 6 a head", "6 quid each", "it's £6.00 now", "£6,00", "6 a head"]) expect(quoteHasAmount(q, 6), q).toBe(true);
    expect(quoteHasAmount("£6.50 each please", 6.5)).toBe(true);
  });
  it("quoteHasAmount: another number, or a number run into letters, is not this amount", () => {
    for (const q of ["£16 each", "£60 for the lot", "£6.50 each", "Six pounds a player", "pay before kick off", "drop out by Tuesday 6pm", "the 6th", "6v6"]) {
      expect(quoteHasAmount(q, 6), q).toBe(false);
    }
  });
  it("a price per player the model states is kept when its quote holds the number", () => {
    const h = [at("£6 each please", 7, "Kemal"), at("6 quid each lads", 14, "Kemal")];
    expect(plan(fee(6, ["£6 each please", "6 quid each"]), h, null).plan.suggestions).toEqual([
      { key: "matchFee", current: "", detected: "6", evidence: ["£6 each please", "6 quid each"] },
    ]);
  });
  it("the model says the price is for the whole pitch: no fee, in English or Turkish, whatever the quote", () => {
    for (const q of ["Pitch is £45 a week", "saha toplam £45"]) {
      expect(plan(fee(45, [q], "high", "whole_pitch"), [], q).detection.matchFee.amount, q).toBeNull();
    }
  });
  it("no basis, or a basis outside the list (a reading stored before 2026-10-30): no fee", () => {
    const d = "£6 a player, pay before kick off.";
    expect(plan({ match_fee: { amount: 6, currency: "pounds", confidence: "high", evidence: ["£6 a player"] } }, [], d).detection.matchFee.amount).toBeNull();
    expect(plan(fee(6, ["£6 a player"], "high", "per_head_maybe"), [], d).detection.matchFee.amount).toBeNull();
  });
  it("a quote that does not hold the number is dropped, and the rest are judged as usual", () => {
    const mixed = [at("£6 each please", 7, "Kemal"), at("see you at 7 lads", 14, "Kemal")];
    const m = plan(fee(6, ["£6 each", "at 7 lads"]), mixed, null);
    expect(m.detection.matchFee.evidence).toEqual(["£6 each"]);
    expect(m.plan.suggestions).toEqual([]);
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

describe("FIX 5, REDONE 2026-10-30: an out-of-date description is the model's ruling; a monthly club is the server's", () => {
  it("the chat's own fee, twice, is suggested over the description's", () => {
    const h = [at("£6 each from now on", 7, "Kemal"), at("£6 each lads", 14, "Kemal")];
    const { plan: p } = plan(fee(6, ["£6 each from now on", "£6 each lads"]), h, "£4 a game. Tuesdays.");
    expect(p.suggestions).toEqual([{ key: "matchFee", current: "", detected: "6", evidence: ["£6 each from now on", "£6 each lads"] }]);
  });
  it("the server no longer reads the chat for other prices: what the model answered, verified, is what counts", () => {
    const h = [at("£6 each lads", 7, "Kemal"), at("in", 7, "Joe")];
    const { detection } = plan(fee(4, ["£4 a game"]), h, "£4 a game. Tuesdays.");
    expect(detection.matchFee).toMatchObject({ amount: 4, fromDescription: ["£4 a game"] });
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
