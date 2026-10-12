/**
 * F3, learned setup: THE GROUP DESCRIPTION AS EVIDENCE, AND THE MATCH FEE
 * (go-live slice D3, 2026-10-12). Pure: no database, no model.
 *
 * The owner's rulings pinned here:
 *   - the description is ONE of the two sources a setting needs, never
 *     both: description + one chat message switches a setting, the
 *     description twice does not, the description alone switches nothing;
 *   - the SERVER decides which source a quote came from, by finding it;
 *   - "[number removed]", "[link removed]" and "[email removed]" are not
 *     evidence, and a quote with bank-like digits is still dropped;
 *   - a per-player match fee is only ever SUGGESTED;
 *   - the findings say "From your group description" for such a quote,
 *     and are word for word what they were when there is none.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_DESCRIPTION_CHARS,
  SUGGESTION_KEYS,
  buildUserContent,
  descriptionForReading,
  parseDetection,
  planSetup,
  verifyEvidence,
  verifyEvidenceTagged,
  type OrgSettingsState,
  type WeeklyGameState,
} from "../rules";
import { composeSetupDm, splitEvidence, suggestionLine } from "../dm";
import { composeSetupAskDm } from "../../club-setup-dm-rules";
import { FEE_PATH, suggestionActionHref, suggestionActionLabel } from "../suggestion-action";
import { gradeFixture } from "./grade";
import { blankAnswer, loadFixture, STUB_ANSWERS } from "./stubs";

const at = (text: string, day: number, author = "A") => ({
  author,
  text,
  timestamp: new Date(Date.UTC(2026, 8, day, 9)).toISOString(),
});

const DESC = "Tuesday 6 a side, 9pm.\n£6 a player, pay before kick off.\nPay Kemal [number removed]\nDrop out by Monday 9pm or you still pay.";
const CHAT = [
  at("Drop out by Monday 9pm or you still pay, as always", 7, "Kemal"),
  at("in", 7, "Joe"),
  at("in please", 8, "Dele"),
];

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

function plan(answer: Record<string, unknown>, opts: { description?: string | null; game?: WeeklyGameState; history?: typeof CHAT } = {}) {
  const history = opts.history ?? CHAT;
  const detection = parseDetection({ ...blankAnswer(), ...answer }, history, opts.description === undefined ? DESC : opts.description)!;
  const game = opts.game ?? GAME;
  return {
    detection,
    plan: planSetup({
      detection,
      org: DEFAULTS,
      weeklyGame: game,
      activities: [{ dayOfWeek: game.dayOfWeek, time: game.time }],
      chatLanguage: null,
    }),
  };
}

const deadline = (evidence: string[], confidence = "high") => ({
  drop_out_deadline: { day: "monday", time: "21:00", confidence, evidence },
});
const fee = (amount: number, evidence: string[], confidence = "medium", currency = "pounds") => ({
  match_fee: { amount, currency, confidence, evidence },
});

describe("verifyEvidenceTagged: the server, not the model, says where a quote came from", () => {
  it("a quote that is only in the description is tagged description", () => {
    expect(verifyEvidenceTagged(["£6 a player, pay before kick off"], CHAT, DESC)).toEqual([
      { quote: "£6 a player, pay before kick off", source: "description" },
    ]);
  });
  it("a quote that is in a message is tagged chat, even when the description says it too", () => {
    expect(verifyEvidenceTagged(["Drop out by Monday 9pm or you still pay"], CHAT, DESC)).toEqual([
      { quote: "Drop out by Monday 9pm or you still pay", source: "chat" },
    ]);
  });
  it("the same sentence quoted twice, in one message and in the description: one of each", () => {
    expect(
      verifyEvidenceTagged(["Drop out by Monday 9pm or you still pay", "Drop out by Monday 9pm or you still pay"], CHAT, DESC),
    ).toEqual([
      { quote: "Drop out by Monday 9pm or you still pay", source: "chat" },
      { quote: "Drop out by Monday 9pm or you still pay", source: "description" },
    ]);
  });
  it("THE DESCRIPTION IS ONE SOURCE: two different sentences of it count once", () => {
    expect(verifyEvidenceTagged(["£6 a player, pay before kick off", "Tuesday 6 a side, 9pm"], CHAT, DESC)).toEqual([
      { quote: "£6 a player, pay before kick off", source: "description" },
    ]);
  });
  it("a later quote that is only in the message moves an earlier one onto the description", () => {
    expect(verifyEvidenceTagged(["Drop out by Monday 9pm", "as always"], CHAT, DESC)).toEqual([
      { quote: "Drop out by Monday 9pm", source: "description" },
      { quote: "as always", source: "chat" },
    ]);
  });
  it("without a description nothing changes: the chat is the only place to look", () => {
    expect(verifyEvidenceTagged(["£6 a player, pay before kick off"], CHAT, null)).toEqual([]);
    expect(verifyEvidence(["in please", "£6 a player"], CHAT)).toEqual(["in please"]);
  });
  it("a quote may cross the description's line breaks", () => {
    expect(verifyEvidence(["9pm. £6 a player"], [], DESC)).toEqual(["9pm. £6 a player"]);
  });
});

describe("placeholders and bank details are never evidence", () => {
  it("a quote made of, or carrying, a placeholder is dropped", () => {
    for (const q of ["[number removed]", "Pay Kemal [number removed]", "pay kemal [NUMBER REMOVED]", "Kemal [number", "removed] Drop out"]) {
      expect(verifyEvidenceTagged([q], CHAT, DESC), q).toEqual([]);
    }
    const links = "Pitch [link removed] and mail [email removed] for a place";
    for (const q of ["Pitch [link removed]", "mail [email removed] for a place", "[email removed]"]) {
      expect(verifyEvidenceTagged([q], CHAT, links), q).toEqual([]);
    }
  });
  it("the words beside a placeholder may be quoted, the placeholder never comes with them", () => {
    expect(verifyEvidence(["Pay Kemal"], [], DESC)).toEqual(["Pay Kemal"]);
  });
  it("a quote with bank-like digits is still dropped, whichever source it is in", () => {
    const leaky = "Pay Kemal 12-34-56 12345678";
    expect(verifyEvidenceTagged(["Pay Kemal 12-34-56"], [], leaky)).toEqual([]);
    expect(verifyEvidenceTagged(["Kemal 12-34-56 12345678"], [at(leaky, 1)], leaky)).toEqual([]);
  });
  it("a placeholder quoted as the reason for a setting leaves the setting off", () => {
    const { plan: p } = plan(deadline(["Pay Kemal [number removed]", "Drop out by Monday 9pm or you still pay"]));
    expect(p.applied).toEqual([]);
    expect(p.kept).toEqual([{ key: "dropOutDeadline", reason: "thin-evidence" }]);
  });
});

describe("the two-source rule, with the description as one source", () => {
  it("description + one chat message agreeing: high confidence switches the setting, and the item says which quote is the description's", () => {
    const { plan: p } = plan(deadline(["Drop out by Monday 9pm or you still pay, as always", "Drop out by Monday 9pm or you still pay."]));
    expect(p.applied).toEqual([
      {
        key: "dropOutDeadline",
        from: null,
        to: { day: 1, time: "21:00" },
        evidence: ["Drop out by Monday 9pm or you still pay, as always", "Drop out by Monday 9pm or you still pay."],
        fromDescription: ["Drop out by Monday 9pm or you still pay."],
        undoneAt: null,
      },
    ]);
    expect(p.data).toEqual({ dropOutDeadlineDay: 1, dropOutDeadlineTime: "21:00" });
  });
  it("the description twice is NOT two sources: nothing is switched", () => {
    const noChat = [at("in", 7, "Joe"), at("in please", 8, "Dele")];
    const { plan: p, detection } = plan(deadline(["Drop out by Monday 9pm", "or you still pay."]), { history: noChat });
    expect(detection.dropOutDeadline.evidence).toEqual(["Drop out by Monday 9pm"]);
    expect(detection.dropOutDeadline.fromDescription).toEqual(["Drop out by Monday 9pm"]);
    expect(p.applied).toEqual([]);
    expect(p.data).toEqual({});
    expect(p.kept).toEqual([{ key: "dropOutDeadline", reason: "thin-evidence" }]);
  });
  it("the description alone switches nothing, whatever confidence the model claims", () => {
    const noChat = [at("in", 7, "Joe"), at("in please", 8, "Dele")];
    for (const confidence of ["high", "medium"]) {
      const { plan: p } = plan(deadline(["Drop out by Monday 9pm or you still pay."], confidence), { history: noChat });
      expect(p.applied, confidence).toEqual([]);
      expect(p.data, confidence).toEqual({});
    }
  });
  it("the description alone can at most make a SUGGESTION: a weekly game it states differently from the organiser's entry", () => {
    const { plan: p } = plan(
      { weekly_game: { day: "tuesday", time: "21:00", venue: "", players_per_side: 0, confidence: "high", evidence: ["Tuesday 6 a side, 9pm"] } },
      { game: { ...GAME, time: "20:00" } },
    );
    expect(p.applied).toEqual([]);
    expect(p.suggestions).toEqual([
      { key: "weeklyGameTime", current: "20:00", detected: "21:00", evidence: ["Tuesday 6 a side, 9pm"], fromDescription: ["Tuesday 6 a side, 9pm"] },
    ]);
  });
  it("organisers pick is suggested on the description plus one message, never on the description alone", () => {
    const d = "Kemal picks the team each week, message him for a place.";
    const h = [at("Message me for a place and I'll pick the team", 7, "Kemal"), at("in", 7, "Joe")];
    const both = { open_places: { answer: "organisers_pick", confidence: "high", evidence: ["Kemal picks the team each week", "I'll pick the team"] } };
    expect(plan(both, { description: d, history: h }).plan.suggestions).toEqual([
      {
        key: "organiserPicks",
        current: "first-come",
        detected: "organiser",
        evidence: ["Kemal picks the team each week", "I'll pick the team"],
        fromDescription: ["Kemal picks the team each week"],
      },
    ]);
    const alone = { open_places: { answer: "organisers_pick", confidence: "high", evidence: ["Kemal picks the team each week", "message him for a place"] } };
    const p = plan(alone, { description: d, history: h }).plan;
    expect(p.suggestions).toEqual([]);
    expect(p.kept).toEqual([{ key: "organiserPicks", reason: "thin-evidence" }]);
  });
  it("a monthly list the description alone claims holds nothing off: the chat's own settings are still switched", () => {
    const d = "Monthly list: regulars pay for the month up front.";
    const h = [at("Same squad as ever, shout if you're out", 7, "Kemal"), at("Same squad as ever, shout if you're out", 14, "Kemal")];
    const { plan: p } = plan(
      {
        squad: { answer: "rolling", confidence: "high", evidence: ["Same squad as ever", "Same squad as ever"] },
        monthly_list: {
          answer: "monthly_list",
          prepay_for_month: true,
          pay_as_you_go_fill_ins: false,
          credit_for_missed_games: false,
          confidence: "high",
          evidence: ["regulars pay for the month up front"],
        },
      },
      { description: d, history: h },
    );
    expect(p.applied.map((a) => a.key)).toEqual(["rollingSquad"]);
    expect(p.noted.map((n) => [n.key, n.fromDescription])).toEqual([["monthlyList", ["regulars pay for the month up front"]]]);
  });
});

describe("the chat contradicts a stale description: the chat wins", () => {
  const stale = loadFixture("description-stale");
  it("the fixture's correct answer: the chat's deadline is switched, rolling squad is not, the chat's fee is suggested, nothing quotes the description", () => {
    const detection = parseDetection(STUB_ANSWERS["description-stale"], stale.history, stale.description)!;
    const p = planSetup({
      detection,
      org: DEFAULTS,
      weeklyGame: { ...stale.weeklyGame, feePerPlayer: null },
      activities: [{ dayOfWeek: stale.weeklyGame.dayOfWeek, time: stale.weeklyGame.time }],
      chatLanguage: null,
    });
    expect(gradeFixture(stale.expect, detection, p)).toEqual([]);
    expect(p.applied.map((a) => [a.key, a.to])).toEqual([["dropOutDeadline", { day: 4, time: "10:00" }]]);
    expect(p.suggestions).toEqual([
      { key: "matchFee", current: "", detected: "7", evidence: ["it's £7 each from now on", "Reminder it's £7 each now"] },
    ]);
    expect(JSON.stringify(p)).not.toContain("fromDescription");
  });
  it("a model that answers from the stale description anyway cannot switch its claim on: the description is one source", () => {
    const wrong = {
      ...blankAnswer(),
      squad: { answer: "rolling", confidence: "high", evidence: ["Squad is the same every week", "only message if you can't play"] },
      drop_out_deadline: { day: "wednesday", time: "12:00", confidence: "high", evidence: ["Drop out by Wednesday noon", "Drop out by Wednesday noon"] },
    };
    const detection = parseDetection(wrong, stale.history, stale.description)!;
    const p = planSetup({
      detection,
      org: DEFAULTS,
      weeklyGame: stale.weeklyGame,
      activities: [{ dayOfWeek: stale.weeklyGame.dayOfWeek, time: stale.weeklyGame.time }],
      chatLanguage: null,
    });
    expect(p.applied).toEqual([]);
    expect(p.data).toEqual({});
    expect(p.kept).toEqual([
      { key: "rollingSquad", reason: "thin-evidence" },
      { key: "dropOutDeadline", reason: "thin-evidence" },
    ]);
  });
});

describe("the match fee: only ever a suggestion", () => {
  it("is a suggestion kind, and never a setting the reading can switch", () => {
    expect(SUGGESTION_KEYS).toContain("matchFee");
    const { plan: p } = plan(fee(6, ["£6 a player, pay before kick off"], "high"));
    expect(p.applied).toEqual([]);
    expect(p.data).toEqual({});
  });
  it("THE DESCRIPTION ALONE IS ENOUGH TO SUGGEST: the weekly game has no fee", () => {
    const { plan: p } = plan(fee(6, ["£6 a player, pay before kick off"]));
    expect(p.suggestions).toEqual([
      {
        key: "matchFee",
        current: "",
        detected: "6",
        evidence: ["£6 a player, pay before kick off"],
        fromDescription: ["£6 a player, pay before kick off"],
      },
    ]);
  });
  it("suggested when it differs from the weekly game's fee, with both amounts", () => {
    const { plan: p } = plan(fee(6, ["£6 a player"]), { game: { ...GAME, feePerPlayer: 5 } });
    expect(p.suggestions.map((s) => [s.key, s.current, s.detected])).toEqual([["matchFee", "5", "6"]]);
    const pence = plan(fee(6.5, ["£6.50 each"]), { description: "£6.50 each", game: { ...GAME, feePerPlayer: 6 } }).plan;
    expect(pence.suggestions.map((s) => [s.current, s.detected])).toEqual([["6", "6.50"]]);
  });
  it("not suggested when the weekly game already has that fee", () => {
    expect(plan(fee(6, ["£6 a player"]), { game: { ...GAME, feePerPlayer: 6 } }).plan.suggestions).toEqual([]);
  });
  it("from the chat alone it takes TWO messages that state the amount: one could be a single week's price", () => {
    const one = [at("£8 each tonight lads", 7, "Kemal"), at("in", 7, "Joe")];
    expect(plan(fee(8, ["£8 each tonight"]), { description: null, history: one }).plan.suggestions).toEqual([]);
    const two = [at("£8 each please", 7, "Kemal"), at("£8 each please", 14, "Kemal")];
    expect(plan(fee(8, ["£8 each please", "£8 each please"]), { description: null, history: two }).plan.suggestions).toEqual([
      { key: "matchFee", current: "", detected: "8", evidence: ["£8 each please", "£8 each please"] },
    ]);
  });
  it("the amount must be IN a verified quote: a fee the model worked out or made up is nothing", () => {
    for (const a of [fee(7, ["£6 a player, pay before kick off"]), fee(6, ["pay before kick off"]), fee(6, ["Six pounds a player"])]) {
      const { plan: p, detection } = plan(a);
      expect(detection.matchFee.amount).toBeNull();
      expect(p.suggestions).toEqual([]);
    }
  });
  it("another currency, no amount, a silly amount or a guess is nothing", () => {
    const tl = "Kişi başı 200 TL";
    expect(plan(fee(200, [tl], "high", "other"), { description: tl }).detection.matchFee.amount).toBeNull();
    expect(plan(fee(200, ["£200 for the pitch"], "high"), { description: "£200 for the pitch" }).detection.matchFee.amount).toBeNull();
    expect(plan(fee(0, [], "low", "none")).detection.matchFee.amount).toBeNull();
    expect(plan(fee(6, ["£6 a player"], "low")).plan.suggestions).toEqual([]);
  });
  it("an answer with no match_fee at all (a reading stored before this slice, a stub) is no fee", () => {
    const d = parseDetection(blankAnswer(), CHAT, DESC)!;
    expect(d.matchFee).toEqual({ amount: null, confidence: "low", evidence: [] });
  });
  it("not suggested for a group that runs a monthly list, a club that splits the pitch cost, or a club with no weekly game", () => {
    const monthly = {
      ...fee(6, ["£6 a player"]),
      monthly_list: {
        answer: "monthly_list",
        prepay_for_month: true,
        pay_as_you_go_fill_ins: false,
        credit_for_missed_games: false,
        confidence: "medium",
        evidence: ["in please"],
      },
    };
    expect(plan(monthly).plan.suggestions).toEqual([]);
    expect(plan(fee(6, ["£6 a player"]), { game: { ...GAME, feeSplitTotal: true } }).plan.suggestions).toEqual([]);
    const d = parseDetection({ ...blankAnswer(), ...fee(6, ["£6 a player"]) }, CHAT, DESC)!;
    expect(planSetup({ detection: d, org: DEFAULTS, weeklyGame: null, activities: [], chatLanguage: null }).suggestions).toEqual([]);
  });
  it("comes after the weekly game and language suggestions and before organisers pick", () => {
    const h = [at("Message me for a place and I'll pick the team", 7, "Kemal"), at("I'll pick the team again this week", 14, "Kemal")];
    const { plan: p } = plan(
      {
        ...fee(6, ["£6 a player"]),
        open_places: { answer: "organisers_pick", confidence: "high", evidence: ["I'll pick the team", "I'll pick the team again"] },
        weekly_game: { day: "tuesday", time: "21:00", venue: "", players_per_side: 0, confidence: "high", evidence: ["Tuesday 6 a side, 9pm"] },
      },
      { history: h, game: { ...GAME, time: "20:00" } },
    );
    expect(p.suggestions.map((s) => s.key)).toEqual(["weeklyGameTime", "matchFee", "organiserPicks"]);
  });
});

describe("what the model is shown", () => {
  it("the description is its own labelled block, between the organiser's entry and the messages, line breaks kept", () => {
    const { text } = buildUserContent({ groupSubject: "Tuesday 6s", weeklyGame: GAME, history: CHAT, description: DESC });
    expect(text).toContain(`Group description (one source, written by a group admin, maybe long ago):\n"""\n${DESC}\n"""`);
    expect(text.indexOf("Weekly game the organiser entered")).toBeLessThan(text.indexOf("Group description"));
    expect(text.indexOf("Group description")).toBeLessThan(text.indexOf("Messages (3"));
  });
  it("says so when there is none", () => {
    for (const description of [null, undefined, "", "   \n "]) {
      const { text } = buildUserContent({ groupSubject: "Tuesday 6s", weeklyGame: GAME, history: CHAT, description });
      expect(text).toContain("Group description: (none)\n\nMessages (3");
    }
  });
  it("a very long description is cut, and quotes are checked against what was sent", () => {
    const long = `${"Rules. ".repeat(400)}Drop out by Monday 9pm.`;
    const sent = descriptionForReading(long)!;
    expect(sent.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    expect(buildUserContent({ groupSubject: null, weeklyGame: null, history: CHAT, description: long }).text).toContain(sent);
    expect(verifyEvidenceTagged(["Drop out by Monday 9pm."], [], long)).toEqual([]);
  });
});

// ── Rendering, English and Turkish ──────────────────────────────────────

const LINKS = {
  scheduleUrl: "https://mt.link/activities",
  settingsUrl: "https://mt.link/settings",
  organiserPicksUrl: "https://mt.link/pick",
  feeUrl: "https://mt.link/fee",
};
const APPLIED_BOTH = {
  key: "dropOutDeadline" as const,
  from: null,
  to: { day: 1, time: "21:00" },
  evidence: ["Drop out by Monday 9pm please", "Drop out by Monday 9pm or you still pay"],
  fromDescription: ["Drop out by Monday 9pm or you still pay"],
  undoneAt: null,
  undoUrl: "https://mt.link/undo",
};
const FEE_DESC = { key: "matchFee" as const, current: "", detected: "6", evidence: ["£6 a player, pay before kick off"], fromDescription: ["£6 a player, pay before kick off"] };
const FEE_CHAT = { key: "matchFee" as const, current: "5", detected: "6.50", evidence: ["£6.50 each please", "£6.50 each please"] };

describe("splitEvidence", () => {
  it("no description evidence: every quote is the chat's", () => {
    expect(splitEvidence({ evidence: ["a", "b"] })).toEqual({ chat: ["a", "b"], description: [] });
  });
  it("one of each, in either order, and the same words in both", () => {
    expect(splitEvidence({ evidence: ["a", "b"], fromDescription: ["b"] })).toEqual({ chat: ["a"], description: ["b"] });
    expect(splitEvidence({ evidence: ["b", "a"], fromDescription: ["b"] })).toEqual({ chat: ["a"], description: ["b"] });
    expect(splitEvidence({ evidence: ["a", "a"], fromDescription: ["a"] })).toEqual({ chat: ["a"], description: ["a"] });
  });
});

describe("the findings DM with description evidence", () => {
  const dm = (lang: string, rest: Partial<Parameters<typeof composeSetupDm>[0]>) =>
    composeSetupDm({ lang, group: "Tuesday 6s", applied: [], suggestions: [], noted: [], ...LINKS, ...rest });

  it("a switched setting backed by a message and the description shows both, each under its own label, in English", () => {
    expect(dm("en", { applied: [APPLIED_BOTH] })).toBe(
      `I read the recent messages in "Tuesday 6s" to see how it runs, and set MatchTime up the same way.\n\n` +
        `✅ *Drop-out deadline:* Monday 21:00. MatchTime reminds the group before it.\n` +
        `From messages like: "Drop out by Monday 9pm please"\n` +
        `From your group description: "Drop out by Monday 9pm or you still pay"\n` +
        `Undo or change: https://mt.link/undo\n\n` +
        `Everything is on your settings page, with the chat messages behind each one: https://mt.link/settings`,
    );
  });
  it("and in Turkish", () => {
    expect(dm("tr", { applied: [APPLIED_BOTH] })).toBe(
      `"Tuesday 6s" grubundaki son mesajları okuyup grubun nasıl işlediğine baktım ve MatchTime'ı aynı şekilde kurdum.\n\n` +
        `✅ *Son çıkış saati:* Pazartesi 21:00. MatchTime bundan önce gruba hatırlatır.\n` +
        `Şu tür mesajlardan: "Drop out by Monday 9pm please"\n` +
        `Grup açıklamanızdan: "Drop out by Monday 9pm or you still pay"\n` +
        `Geri almak ya da değiştirmek için: https://mt.link/undo\n\n` +
        `Hepsi, her birinin dayandığı sohbet mesajlarıyla birlikte ayarlar sayfanızda: https://mt.link/settings`,
    );
  });
  it("the fee suggestion from the description alone: its line, the description quote, its own link, in English", () => {
    expect(dm("en", { suggestions: [FEE_DESC] })).toBe(
      `I read the recent messages in "Tuesday 6s" to see how it runs. I didn't change any settings, but a few things are worth a look.\n\n` +
        `Worth a check (I changed nothing here):\n` +
        `🔎 The match fee looks like £6 a player; your weekly game has no fee set.\n` +
        `From your group description: "£6 a player, pay before kick off"\n` +
        `Set it here: https://mt.link/fee\n\n` +
        `Everything is on your settings page, with the chat messages behind each one: https://mt.link/settings`,
    );
  });
  it("and in Turkish", () => {
    expect(dm("tr", { suggestions: [FEE_DESC] })).toBe(
      `"Tuesday 6s" grubundaki son mesajları okuyup grubun nasıl işlediğine baktım. Hiçbir ayarı değiştirmedim, ama göz atmaya değer birkaç şey var.\n\n` +
        `Kontrol etmeye değer (burada hiçbir şeyi değiştirmedim):\n` +
        `🔎 Maç ücreti kişi başı £6 gibi görünüyor; haftalık maçınızda ücret girilmemiş.\n` +
        `Grup açıklamanızdan: "£6 a player, pay before kick off"\n` +
        `Buradan girebilirsiniz: https://mt.link/fee\n\n` +
        `Hepsi, her birinin dayandığı sohbet mesajlarıyla birlikte ayarlar sayfanızda: https://mt.link/settings`,
    );
  });
  it("the fee suggestion from the chat, against a fee already set: 'From messages like', both amounts, both languages", () => {
    expect(suggestionLine("en", FEE_CHAT)).toBe("The match fee looks like £6.50 a player; your weekly game says £5.");
    expect(suggestionLine("tr", FEE_CHAT)).toBe("Maç ücreti kişi başı £6.50 gibi görünüyor; haftalık maçınızda £5 yazıyor.");
    expect(dm("en", { suggestions: [FEE_CHAT] })).toContain(
      `🔎 The match fee looks like £6.50 a player; your weekly game says £5.\nFrom messages like: "£6.50 each please"\nSet it here: https://mt.link/fee\n\n`,
    );
    expect(dm("tr", { suggestions: [FEE_CHAT] })).toContain(
      `🔎 Maç ücreti kişi başı £6.50 gibi görünüyor; haftalık maçınızda £5 yazıyor.\nŞu tür mesajlardan: "£6.50 each please"\nBuradan girebilirsiniz: https://mt.link/fee\n\n`,
    );
  });
  it("order in the DM: the weekly game with its link, the fee with its own, organisers pick last with its own", () => {
    const text = dm("en", {
      suggestions: [
        { key: "weeklyGameTime", current: "20:00", detected: "21:00", evidence: ["9pm"] },
        FEE_DESC,
        { key: "organiserPicks", current: "first-come", detected: "organiser", evidence: ["I'll pick the team", "Kemal picks"], fromDescription: ["Kemal picks"] },
      ],
    });
    expect(text).toContain(
      `Worth a check (I changed nothing here):\n` +
        `🔎 The chat says kickoff is at 21:00; your weekly game is set for 20:00.\n` +
        `Change it here: https://mt.link/activities\n` +
        `🔎 The match fee looks like £6 a player; your weekly game has no fee set.\n` +
        `From your group description: "£6 a player, pay before kick off"\n` +
        `Set it here: https://mt.link/fee\n` +
        `🔎 It looks like the organisers choose who fills an open place. If that's right, switch on "The organisers pick".\n` +
        `From messages like: "I'll pick the team"\n` +
        `From your group description: "Kemal picks"\n` +
        `Switch it on here: https://mt.link/pick\n\n`,
    );
  });
  it("with no fee link minted, the fee line links to the weekly game page", () => {
    expect(dm("en", { suggestions: [FEE_DESC], feeUrl: undefined })).toContain("Set it here: https://mt.link/activities\n\n");
  });
  it("no rendering carries a placeholder, an em dash or an en dash", () => {
    for (const lang of ["en", "tr"]) {
      const text = dm(lang, { applied: [APPLIED_BOTH], suggestions: [FEE_DESC, FEE_CHAT] });
      expect(text).not.toMatch(/[—–]|removed\]/);
    }
  });
});

describe("the setup DM of a held club carries the same evidence lines", () => {
  const ask = (lang: string) =>
    composeSetupAskDm({
      lang,
      club: "Tuesday 6s FC",
      group: "Tuesday 6s",
      reading: { kind: "findings", applied: [APPLIED_BOTH], suggestions: [FEE_DESC], noted: [] },
      standard: false,
      scheduleUrl: "https://mt.link/activities",
      ratingsUrl: "https://mt.link/ratings",
      settingsUrl: "https://mt.link/settings",
      learnedUrl: "https://mt.link/learned",
    });
  it("in English: both labels under the switched setting, the fee with the weekly game page as its link", () => {
    expect(ask("en")).toContain(
      `From messages like: "Drop out by Monday 9pm please"\nFrom your group description: "Drop out by Monday 9pm or you still pay"\nUndo or change: https://mt.link/undo`,
    );
    expect(ask("en")).toContain(
      `🔎 The match fee looks like £6 a player; your weekly game has no fee set.\nFrom your group description: "£6 a player, pay before kick off"\nSet it here: https://mt.link/activities`,
    );
  });
  it("in Turkish", () => {
    expect(ask("tr")).toContain(
      `Şu tür mesajlardan: "Drop out by Monday 9pm please"\nGrup açıklamanızdan: "Drop out by Monday 9pm or you still pay"\n`,
    );
    expect(ask("tr")).toContain(
      `🔎 Maç ücreti kişi başı £6 gibi görünüyor; haftalık maçınızda ücret girilmemiş.\nGrup açıklamanızdan: "£6 a player, pay before kick off"\nBuradan girebilirsiniz: https://mt.link/activities`,
    );
  });
});

describe("the fee suggestion's button on the settings page", () => {
  it("goes to the weekly game page with the fee field open, and says what it does in both languages", () => {
    expect(suggestionActionHref("matchFee")).toBe(FEE_PATH);
    expect(FEE_PATH).toBe("/admin/activities?edit=fee");
    expect(suggestionActionLabel("en", "matchFee")).toBe("Set the match fee");
    expect(suggestionActionLabel("tr", "matchFee")).toBe("Maç ücretini gir");
  });
});

describe("the two description fixtures, with their correct answers", () => {
  for (const name of ["description-supports", "description-stale"] as const) {
    it(`${name}: passes its own expectations`, () => {
      const fx = loadFixture(name);
      const detection = parseDetection(STUB_ANSWERS[name], fx.history, fx.description)!;
      const p = planSetup({
        detection,
        org: DEFAULTS,
        weeklyGame: fx.weeklyGame,
        activities: [{ dayOfWeek: fx.weeklyGame.dayOfWeek, time: fx.weeklyGame.time }],
        chatLanguage: null,
      });
      expect(gradeFixture(fx.expect, detection, p)).toEqual([]);
    });
  }
  it("description-supports: the deadline is switched on a message plus the description, and the masked bank line is nowhere", () => {
    const fx = loadFixture("description-supports");
    expect(fx.description).toContain("Pay Kemal [number removed]");
    const detection = parseDetection(STUB_ANSWERS["description-supports"], fx.history, fx.description)!;
    const p = planSetup({
      detection,
      org: DEFAULTS,
      weeklyGame: fx.weeklyGame,
      activities: [{ dayOfWeek: fx.weeklyGame.dayOfWeek, time: fx.weeklyGame.time }],
      chatLanguage: null,
    });
    expect(p.applied.map((a) => [a.key, a.to, a.fromDescription])).toEqual([
      ["dropOutDeadline", { day: 2, time: "18:00" }, ["Drop out by Tuesday 6pm or you still pay."]],
    ]);
    expect(p.suggestions.map((s) => [s.key, s.detected, s.fromDescription])).toEqual([["matchFee", "6", ["£6 a player, pay before kick off."]]]);
    expect(JSON.stringify(p)).not.toMatch(/removed\]|Pay Kemal/);
  });
  it("the grader fails a plan whose description evidence is not where the fixture expects it", () => {
    const fx = loadFixture("description-supports");
    const answer = { ...STUB_ANSWERS["description-supports"], match_fee: { amount: 0, currency: "none", confidence: "low", evidence: [] } };
    const detection = parseDetection(answer, fx.history, fx.description)!;
    const p = planSetup({
      detection,
      org: DEFAULTS,
      weeklyGame: fx.weeklyGame,
      activities: [{ dayOfWeek: fx.weeklyGame.dayOfWeek, time: fx.weeklyGame.time }],
      chatLanguage: null,
    });
    expect(gradeFixture(fx.expect, detection, p)).toEqual([
      "matchFee: expected 6, got null",
      'suggestions: expected ["matchFee"], got []',
      'fromDescription: expected ["dropOutDeadline","matchFee"], got ["dropOutDeadline"]',
    ]);
  });
});
