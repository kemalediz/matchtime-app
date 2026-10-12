/**
 * GO-LIVE SLICE S3: the organiser's ONE setup DM, the pure half
 * (go-live plan 2.4 and 2.5, "Setup DM blocks"). No database, no model.
 *
 * The DM replaces both today's "you're live" DM and the separate "what I
 * learned from your chat" DM for a club that is held until its organiser
 * says GO. It is a deterministic template; these tests pin its shape, the
 * four reading outcomes, and the strings that go with the hold.
 */
import { describe, expect, it } from "vitest";
import { t } from "../i18n/t";
import {
  CHAT_READING_FINAL_STATUSES,
  READING_OFF_REASON,
  STANDARD_SETTING,
  composeSetupAskDm,
  isStandardSetup,
  readingFromRow,
  type SetupAskDmInput,
  type ChatReading,
  type StandardSetupColumns,
} from "../club-setup-dm-rules";
import { composeSetupDm } from "../setup-learning/dm";
import { LEARNED_KEYS, dataFor, type AppliedItem, type LearnedKey, type NotedPattern, type SettingValue, type Suggestion } from "../setup-learning/rules";

/** A club on every default: what `isStandardSetup` calls standard. */
const DEFAULTS: StandardSetupColumns = {
  rollingSquadEnabled: false,
  benchPickMode: "first-come",
  dropOutDeadlineDay: null,
  dropOutDeadlineTime: null,
  listPublishDay: null,
  listPublishTime: null,
  paymentTrackingEnabled: false,
  squadMode: "weekly",
  featureAttendance: true,
  featureBench: true,
  featureSquadFromList: false,
};

const applied: AppliedItem[] = [
  { key: "rollingSquad", from: false, to: true, evidence: ["Same lot as last week"] },
  { key: "dropOutDeadline", from: null, to: { day: 1, time: "21:00" }, evidence: ["Drop out by Monday 9pm"] },
];
const suggestions: Suggestion[] = [{ key: "weeklyGameTime", current: "19:00", detected: "20:00", evidence: [] }];
const noted: NotedPattern[] = [];

const input = (reading: ChatReading, over: Partial<SetupAskDmInput> = {}): SetupAskDmInput => ({
  lang: "en",
  club: "Riverside FC",
  group: "Riverside Tuesday 5s",
  reading,
  standard: true,
  scheduleUrl: "https://mt.link/sched",
  ratingsUrl: "https://mt.link/ratings",
  settingsUrl: "https://mt.link/settings",
  learnedUrl: "https://mt.link/learned",
  organiserPicksUrl: "https://mt.link/pick",
  ...over,
});
const findings = (a = applied, sg = suggestions): ChatReading => ({
  kind: "findings",
  applied: a.map((x, i) => ({ ...x, undoUrl: `https://mt.link/u${i + 1}` })),
  suggestions: sg,
  noted,
});

describe("readingFromRow: what the DM says about the chat reading", () => {
  it("no row, or one that is not final: there is no reading to report", () => {
    expect(readingFromRow(null)).toEqual({ kind: "none" });
    expect(readingFromRow({ status: "running", applied: null, suggestions: null, noted: null })).toEqual({ kind: "none" });
    expect(readingFromRow({ status: "deferred", applied: null, suggestions: null, noted: null })).toEqual({ kind: "none" });
  });

  it("applied: the findings, as stored", () => {
    expect(readingFromRow({ status: "applied", applied, suggestions, noted })).toEqual({
      kind: "findings",
      applied,
      suggestions,
      noted,
    });
  });

  it("nothing switched but something worth a look: still findings", () => {
    expect(readingFromRow({ status: "nothing", applied: [], suggestions, noted: [] })).toMatchObject({
      kind: "findings",
      applied: [],
      suggestions,
    });
  });

  it("nothing at all found", () => {
    expect(readingFromRow({ status: "nothing", applied: [], suggestions: [], noted: [] })).toEqual({ kind: "nothing" });
    expect(readingFromRow({ status: "nothing", applied: null, suggestions: null, noted: null })).toEqual({ kind: "nothing" });
  });

  it("skipped (too little chat) and failed (the model gave up): could not read", () => {
    expect(readingFromRow({ status: "skipped", applied: null, suggestions: null, noted: null })).toEqual({ kind: "unread" });
    expect(readingFromRow({ status: "failed", applied: null, suggestions: null, noted: null })).toEqual({ kind: "unread" });
  });

  it("review fix 4a: a setting the organiser already UNDID is not reported as on", () => {
    const undone = [{ ...applied[0], undoneAt: "2026-10-12T10:00:00.000Z" }, applied[1]];
    const r = readingFromRow({ status: "applied", applied: undone, suggestions: [], noted: [] });
    expect(r).toEqual({ kind: "findings", applied: [applied[1]], suggestions: [], noted: [] });
  });

  it("review fix 4a: a setting the organiser has CHANGED since (it no longer holds what was set) is not reported either", () => {
    // Rolling squad was switched on by the reading; the organiser has switched it off again on the website.
    const now = { ...DEFAULTS, dropOutDeadlineDay: 1, dropOutDeadlineTime: "21:00" };
    const r = readingFromRow({ status: "applied", applied, suggestions: [], noted: [] }, now);
    expect(r).toEqual({ kind: "findings", applied: [applied[1]], suggestions: [], noted: [] });
    // Still holding both: both are reported.
    const both = { ...now, rollingSquadEnabled: true };
    expect(readingFromRow({ status: "applied", applied, suggestions: [], noted: [] }, both)).toMatchObject({ applied });
  });

  it("review fix 4a: every switched setting undone, nothing else to tell: 'nothing', never an empty findings list", () => {
    const undone = applied.map((a) => ({ ...a, undoneAt: "2026-10-12T10:00:00.000Z" }));
    expect(readingFromRow({ status: "applied", applied: undone, suggestions: [], noted: [] })).toEqual({ kind: "nothing" });
  });

  it("a reading closed because the reading is switched off is 'none' (nothing was tried); closed at the 2-hour cap it is 'unread'", () => {
    expect(readingFromRow({ status: "skipped", reason: READING_OFF_REASON, applied: null, suggestions: null, noted: null })).toEqual({ kind: "none" });
    expect(readingFromRow({ status: "skipped", reason: "timed-out", applied: null, suggestions: null, noted: null })).toEqual({ kind: "unread" });
  });

  it("the final statuses are the four the plan names", () => {
    expect([...CHAT_READING_FINAL_STATUSES].sort()).toEqual(["applied", "failed", "nothing", "skipped"]);
  });
});

describe("isStandardSetup (review fix 4b: EVERY setting the DM's 'standard setup' line speaks for)", () => {
  it("a club on every default is standard", () => {
    expect(isStandardSetup(DEFAULTS)).toBe(true);
  });

  it("one default per learnable key, taken from the reading's own key list, so a new key cannot be forgotten", () => {
    expect(Object.keys(STANDARD_SETTING).sort()).toEqual([...LEARNED_KEYS].sort());
  });

  // A value that is NOT the default, for each learnable key. `Record<LearnedKey, ...>`:
  // adding a key to LEARNED_KEYS fails to compile here until it is given one.
  const MOVED: Record<LearnedKey, SettingValue> = {
    rollingSquad: true,
    organiserPicks: "organiser",
    dropOutDeadline: { day: 1, time: "21:00" },
    listPublish: { day: 2, time: "20:00" },
    paymentTracking: true,
  };
  for (const key of LEARNED_KEYS) {
    it(`${key} moved off its default: not standard`, () => {
      expect(isStandardSetup({ ...DEFAULTS, ...dataFor(key, MOVED[key]) })).toBe(false);
    });
  }

  it("the club's shape beyond the learnable keys: monthly squad, no In and Out tracking, no bench, a pasted list", () => {
    expect(isStandardSetup({ ...DEFAULTS, squadMode: "monthly" })).toBe(false);
    expect(isStandardSetup({ ...DEFAULTS, featureAttendance: false })).toBe(false);
    expect(isStandardSetup({ ...DEFAULTS, featureBench: false })).toBe(false);
    expect(isStandardSetup({ ...DEFAULTS, featureSquadFromList: true })).toBe(false);
  });
});

describe("composeSetupAskDm: the blocks, in order", () => {
  it("the reading applied settings: head, findings with quotes and undo links, settings, game, ratings, GO, free period", () => {
    const text = composeSetupAskDm(input(findings()));
    const blocks = text.split("\n\n");
    expect(blocks[0]).toBe(
      `Good news: Riverside FC is approved. I'm in "Riverside Tuesday 5s" and I'm staying quiet there until you tell me to start.`,
    );
    expect(blocks[1]).toBe(
      `I read the recent messages in "Riverside Tuesday 5s" to see how it runs, and set MatchTime up the same way.`,
    );
    expect(blocks[2]).toBe(
      "✅ *Rolling squad is on:* whoever played last time is in next time, unless they say OUT.\n" +
        'From messages like: "Same lot as last week"\n' +
        "Undo or change: https://mt.link/u1",
    );
    expect(blocks[3]).toContain("Undo or change: https://mt.link/u2");
    expect(blocks[4]).toMatch(/^Worth a check \(I changed nothing here\):\n🔎 /);
    // The findings link is the learned panel; the separate findings DM's outro is not repeated.
    expect(blocks[5]).toBe("⚙️ *Check or change how your group runs:*\nhttps://mt.link/learned");
    expect(text).not.toContain("Everything is on your settings page");
    expect(blocks[6]).toBe("📅 *Your weekly game:* check the day, time and venue, or change them:\nhttps://mt.link/sched");
    expect(blocks[7]).toBe(
      "⭐ *Starting ratings:* give each player a rough score out of 10 so the first teams are fair:\nhttps://mt.link/ratings",
    );
    expect(blocks[8]).toBe(
      "When you're happy, reply *GO* here and I'll introduce myself in the group, or press *Go live* on your settings page:\n" +
        "https://mt.link/settings\n" +
        "Until then I say nothing in the group.",
    );
    expect(blocks[9]).toBe("Your first two months are free. The free period starts when I go live in the group.");
    expect(blocks).toHaveLength(10);
    // Settings were switched, so "standard setup" would be false: never said.
    expect(text).not.toContain("Standard setup");
  });

  it("nothing found: says so, then what the standard setup is", () => {
    const blocks = composeSetupAskDm(input({ kind: "nothing" })).split("\n\n");
    expect(blocks[1]).toBe(
      `I read the recent messages in "Riverside Tuesday 5s" and found nothing that needs a setting changed, so MatchTime is on its standard setup.`,
    );
    expect(blocks[2]).toBe(
      "Standard setup: players say In or Out each week, and a free place goes to the first person on the bench.",
    );
    expect(blocks[3]).toBe("⚙️ *Check or change how your group runs:*\nhttps://mt.link/settings");
    expect(blocks).toHaveLength(8);
  });

  it("could not read: says so, then the standard setup", () => {
    const blocks = composeSetupAskDm(input({ kind: "unread" })).split("\n\n");
    expect(blocks[1]).toBe("I couldn't read your group's recent messages, so MatchTime is on its standard setup.");
    expect(blocks[2]).toMatch(/^Standard setup: /);
    expect(blocks).toHaveLength(8);
  });

  it("no reading at all (the chat reading is switched off): head, standard setup, the rest", () => {
    const blocks = composeSetupAskDm(input({ kind: "none" })).split("\n\n");
    expect(blocks[0]).toMatch(/^Good news: Riverside FC is approved\./);
    expect(blocks[1]).toMatch(/^Standard setup: /);
    expect(blocks[2]).toMatch(/^⚙️ /);
    expect(blocks).toHaveLength(7);
  });

  it("the organiser already changed how the club runs: 'standard setup' is never claimed", () => {
    const nothing = composeSetupAskDm(input({ kind: "nothing" }, { standard: false }));
    expect(nothing).toContain("found nothing that needs a setting changed, so I changed nothing.");
    expect(nothing).not.toMatch(/standard setup/i);
    const unread = composeSetupAskDm(input({ kind: "unread" }, { standard: false }));
    expect(unread).toContain("I couldn't read your group's recent messages, so I changed nothing.");
    expect(unread).not.toMatch(/standard setup/i);
  });

  it("nothing switched, something worth a look, standard settings: the findings, then the standard setup line", () => {
    const blocks = composeSetupAskDm(input(findings([], suggestions))).split("\n\n");
    expect(blocks[1]).toContain("I didn't change any settings, but a few things are worth a look.");
    expect(blocks[2]).toMatch(/^Worth a check/);
    expect(blocks[3]).toMatch(/^Standard setup: /);
    expect(blocks[4]).toBe("⚙️ *Check or change how your group runs:*\nhttps://mt.link/learned");
  });

  it("a group with no name", () => {
    const text = composeSetupAskDm(input({ kind: "nothing" }, { group: null }));
    expect(text).toMatch(/^Good news: Riverside FC is approved\. I'm in your group and I'm staying quiet there/);
    expect(text).toContain("I read the recent messages in your group and found nothing");
  });

  it("THE ADMIN GROUP INSERTION POINT: a block given by a later slice goes in right before the GO line", () => {
    const blocks = composeSetupAskDm(input({ kind: "nothing" }, { adminGroupBlock: "👥 ADMIN GROUP BLOCK" })).split("\n\n");
    const at = blocks.indexOf("👥 ADMIN GROUP BLOCK");
    expect(at).toBeGreaterThan(0);
    expect(blocks[at - 1]).toMatch(/^⭐ /);
    expect(blocks[at + 1]).toMatch(/^When you're happy, reply \*GO\* here/);
    // Absent (this slice): nothing is inserted.
    expect(composeSetupAskDm(input({ kind: "nothing" }))).not.toContain("👥");
  });

  it("Turkish, every block", () => {
    const blocks = composeSetupAskDm(input(findings(), { lang: "tr" })).split("\n\n");
    expect(blocks[0]).toBe(
      `Güzel haber: Riverside FC onaylandı. "Riverside Tuesday 5s" grubundayım ve siz başlamamı söyleyene kadar orada sessiz kalacağım.`,
    );
    expect(blocks[1]).toContain("MatchTime'ı aynı şekilde kurdum");
    expect(blocks[5]).toBe("⚙️ *Grubunuzun nasıl işlediğini kontrol edin ya da değiştirin:*\nhttps://mt.link/learned");
    expect(blocks[8]).toBe(
      "Hazır olduğunuzda buraya *BAŞLA* yazın, grupta kendimi tanıtayım; ya da ayarlar sayfanızdaki *Yayına al* düğmesine basın:\n" +
        "https://mt.link/settings\n" +
        "O zamana kadar grupta hiçbir şey yazmam.",
    );
    expect(blocks[9]).toBe("İlk iki ayınız ücretsiz. Ücretsiz dönem, grupta yayına geçtiğimde başlar.");

    const nothing = composeSetupAskDm(input({ kind: "nothing" }, { lang: "tr" })).split("\n\n");
    expect(nothing[1]).toBe(
      `"Riverside Tuesday 5s" grubundaki son mesajları okudum ve değiştirilmesi gereken bir ayar bulamadım, bu yüzden MatchTime standart düzeninde.`,
    );
    expect(nothing[2]).toBe(
      "Standart düzen: oyuncular her hafta VARIM ya da YOKUM der, boşalan yer yedek listesindeki ilk kişiye verilir.",
    );
    const unread = composeSetupAskDm(input({ kind: "unread" }, { lang: "tr" })).split("\n\n");
    expect(unread[1]).toBe("Grubunuzun son mesajlarını okuyamadım, bu yüzden MatchTime standart düzeninde.");
  });

  it("no em or en dashes anywhere, in either language", () => {
    for (const lang of ["en", "tr"]) {
      for (const reading of [findings(), { kind: "nothing" }, { kind: "unread" }, { kind: "none" }] as ChatReading[]) {
        for (const standard of [true, false]) {
          expect(composeSetupAskDm(input(reading, { lang, standard }))).not.toMatch(/[\u2013\u2014]/);
        }
      }
    }
  });
});

describe("the strings the setup DM shares with today's DMs cannot drift", () => {
  for (const lang of ["en", "tr"] as const) {
    it(`${lang}: the weekly game and starting ratings lines are the ones in today's "you're live" DM`, () => {
      const s = t(lang);
      const live = s.sj_dm_approved({ club: "C", group: "G", scheduleUrl: "S", ratingsUrl: "R", settingsUrl: "T" });
      expect(live).toContain(s.sj_dm_ready_schedule({ url: "S" }));
      expect(live).toContain(s.sj_dm_ready_ratings({ url: "R" }));
    });

    it(`${lang}: the findings blocks are the ones in today's findings DM`, () => {
      const f = findings();
      if (f.kind !== "findings") throw new Error("unreachable");
      const today = composeSetupDm({
        lang,
        group: "Riverside Tuesday 5s",
        applied: f.applied,
        suggestions: f.suggestions,
        noted: f.noted,
        scheduleUrl: "https://mt.link/sched",
        settingsUrl: "https://mt.link/learned",
        organiserPicksUrl: "https://mt.link/pick",
      }).split("\n\n");
      const held = composeSetupAskDm(input(f, { lang })).split("\n\n");
      // Today's DM is the findings plus its outro; the setup DM carries the same findings after its head.
      expect(held.slice(1, today.length)).toEqual(today.slice(0, -1));
    });
  }
});

describe("the organiser-facing lines that promise 'when it's live' have a held variant", () => {
  for (const lang of ["en", "tr"] as const) {
    it(`${lang}: the connect reply differs from today's only in its last paragraph`, () => {
      const s = t(lang);
      const today = s.sj_dm_connected({ name: "Ali", club: "Riverside FC" });
      const held = s.sj_dm_connected_held({ name: "Ali", club: "Riverside FC" });
      const cut = today.lastIndexOf("\n\n");
      expect(held.slice(0, cut)).toBe(today.slice(0, cut));
      expect(held.slice(cut)).not.toBe(today.slice(cut));
    });

    it(`${lang}: held variants exist for the in-group ack and the pending card`, () => {
      const s = t(lang);
      expect(s.sj_dm_in_group_held({ group: "G" })).not.toBe(s.sj_dm_in_group({ group: "G" }));
      expect(s.sj_dm_in_group_held({ group: null }).length).toBeGreaterThan(20);
      expect(s.sj_card_pending_held).not.toBe(s.sj_card_pending);
    });
  }

  it("English: under the hold nothing says 'when it's live' before approval", () => {
    const s = t("en");
    for (const text of [s.sj_dm_connected_held({ name: null, club: "C" }), s.sj_dm_in_group_held({ group: "G" }), s.sj_card_pending_held]) {
      expect(text).not.toMatch(/when it's live/);
      expect(text).toMatch(/approved/);
      expect(text).toMatch(/start/);
    }
  });
});
