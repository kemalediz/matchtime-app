/**
 * F3, learned setup: the prompt's shape and size, and the organiser's DM
 * in English and Turkish. No model.
 */
import { describe, expect, it } from "vitest";
import { estimateTokens, MIN_CACHEABLE_TOKENS, shouldCachePrompt } from "../../pipeline/llm";
import { SETUP_LEARNING_MODEL, SETUP_LEARNING_SCHEMA, SETUP_LEARNING_SYSTEM_PROMPT } from "../prompt";
import { composeSetupDm } from "../dm";
import { parseDetection, planSetup, type OrgSettingsState } from "../rules";
import { FIXTURE_NAMES, loadFixture, STUB_ANSWERS } from "./stubs";

describe("the prompt", () => {
  it("is Haiku, and is deliberately NOT cached: under Haiku's cacheable minimum, so no 2x cache write for a once-per-club call", () => {
    expect(SETUP_LEARNING_MODEL).toBe("claude-haiku-4-5");
    expect(shouldCachePrompt(SETUP_LEARNING_MODEL, SETUP_LEARNING_SYSTEM_PROMPT)).toBe(false);
    expect(estimateTokens(SETUP_LEARNING_SYSTEM_PROMPT)).toBeLessThan(MIN_CACHEABLE_TOKENS[SETUP_LEARNING_MODEL]);
  });

  it("carries no em or en dash", () => {
    expect(SETUP_LEARNING_SYSTEM_PROMPT).not.toMatch(/[—–]/);
  });

  it("defines every schema field, once each", () => {
    const fields = Object.keys(SETUP_LEARNING_SCHEMA.properties);
    expect(fields).toHaveLength(8);
    for (const f of fields) {
      expect(SETUP_LEARNING_SYSTEM_PROMPT.match(new RegExp(`\\d\\. ${f}:`, "g")) ?? [], f).toHaveLength(1);
    }
  });

  it("has no nullable type anywhere in the schema (the API rejects them at request time)", () => {
    expect(JSON.stringify(SETUP_LEARNING_SCHEMA)).not.toMatch(/"null"/);
  });

  it("does not quote any fixture's chat in its examples, so the live check tests reading, not recall", () => {
    const quoted = [...SETUP_LEARNING_SYSTEM_PROMPT.matchAll(/"([^"]{12,})"/g)].map((m) => m[1].toLowerCase());
    for (const name of FIXTURE_NAMES) {
      const chat = loadFixture(name).history.map((m) => m.text.toLowerCase());
      for (const q of quoted) {
        expect(chat.some((c) => c.includes(q)), `${name} contains the prompt example "${q}"`).toBe(false);
      }
    }
  });
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

function dmFor(name: (typeof FIXTURE_NAMES)[number], lang?: string): string {
  const fx = loadFixture(name);
  const language = lang ?? fx.language;
  const plan = planSetup({
    detection: parseDetection(STUB_ANSWERS[name], fx.history)!,
    org: { ...DEFAULTS, language },
    weeklyGame: fx.weeklyGame,
    activities: [{ dayOfWeek: fx.weeklyGame.dayOfWeek, time: fx.weeklyGame.time }],
    chatLanguage: { lang: fx.language, confident: true },
  });
  return composeSetupDm({
    lang: language,
    group: fx.groupSubject,
    applied: plan.applied.map((a) => ({ ...a, undoUrl: `https://mt.link/undo-${a.key}` })),
    suggestions: plan.suggestions,
    noted: plan.noted,
    scheduleUrl: "https://mt.link/activities",
    settingsUrl: "https://mt.link/settings",
  });
}

describe("the organiser's DM", () => {
  it("says what was set, why (one quote) and how to undo each, in English", () => {
    expect(dmFor("deadlines")).toBe(
      `I read the recent messages in "Thursday Ladies 5s" to see how it runs, and set MatchTime up the same way.\n\n` +
        `✅ *Drop-out deadline:* Monday 21:00. MatchTime reminds the group before it.\n` +
        `From messages like: "Drop out by Monday 9pm at the latest"\n` +
        `Undo or change: https://mt.link/undo-dropOutDeadline\n\n` +
        `✅ *Final list:* posted in the group on Tuesday at 20:00.\n` +
        `From messages like: "Final list goes up Tuesday at 8pm"\n` +
        `Undo or change: https://mt.link/undo-listPublish\n\n` +
        `✅ *Payment tracking is on:* MatchTime keeps track of who has paid and sends a friendly reminder to anyone who hasn't.\n` +
        `From messages like: "sent £6"\n` +
        `Undo or change: https://mt.link/undo-paymentTracking\n\n` +
        `Worth a check (I changed nothing here):\n` +
        `🔎 The chat says kickoff is at 20:00; your weekly game is set for 19:00.\n` +
        `Change it here: https://mt.link/activities\n\n` +
        `Everything is on your settings page, with the chat messages behind each one: https://mt.link/settings`,
    );
  });

  it("says it in Turkish for a Turkish club", () => {
    expect(dmFor("turkish")).toBe(
      `"Cuma Halısaha" grubundaki son mesajları okuyup grubun nasıl işlediğine baktım ve MatchTime'ı aynı şekilde kurdum.\n\n` +
        `✅ *Kadro devam ediyor:* geçen maçta oynayan herkes, YOKUM demedikçe bir sonrakinde de oynar.\n` +
        `Şu tür mesajlardan: "Kadro geçen haftakiyle aynı, olmayan yazsın"\n` +
        `Geri almak ya da değiştirmek için: https://mt.link/undo-rollingSquad\n\n` +
        `✅ *Ödeme takibi açık:* MatchTime kimin ödediğini takip eder ve ödemeyenlere nazikçe hatırlatır.\n` +
        `Şu tür mesajlardan: "Ödedim"\n` +
        `Geri almak ya da değiştirmek için: https://mt.link/undo-paymentTracking\n\n` +
        `Hepsi, her birinin dayandığı sohbet mesajlarıyla birlikte ayarlar sayfanızda: https://mt.link/settings`,
    );
  });

  it("reports a monthly list without changing anything, in both languages", () => {
    expect(dmFor("monthly-list")).toBe(
      `I read the recent messages in "Old Boys Monday" to see how it runs. I didn't change any settings, but a few things are worth a look.\n\n` +
        `📋 I also noticed a monthly list: regulars sign up and pay for the month, others pay as they go to fill spaces and a game a regular misses becomes credit. ` +
        `MatchTime can't run a monthly list yet, so nothing changed for it, and I left payment tracking off because it works game by game. We've made a note of it.\n\n` +
        `Everything is on your settings page, with the chat messages behind each one: https://mt.link/settings`,
    );
    expect(dmFor("monthly-list", "tr")).toContain(
      `📋 Ayrıca aylık bir liste olduğunu fark ettim: düzenli oyuncular aya yazılıp ayın ücretini peşin ödüyor, diğerleri boşlukları maç başı ödeyerek dolduruyor ve düzenli bir oyuncunun kaçırdığı maç alacak olarak kalıyor.`,
    );
  });

  it("no DM in any fixture, in either language, carries an em or en dash", () => {
    for (const name of ["rolling", "organiser-picks", "deadlines", "turkish", "monthly-list"] as const) {
      for (const lang of ["en", "tr"]) expect(dmFor(name, lang), `${name}/${lang}`).not.toMatch(/[—–]/);
    }
  });
});
