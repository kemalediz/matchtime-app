/**
 * PHASE 3: WHAT A TURKISH PLAYER RECEIVES PRIVATELY, AND WHAT THEY TYPE BACK.
 *
 * The copy itself is pinned by the golden snapshots (`copy.en.snap`,
 * `copy.tr.snap`). This file pins the SEAMS around it:
 *
 *   1. the words a Turkish DM tells the player to type are the words the
 *      reader accepts (*EVET* / *VARIM* / *YOKUM*, "mesajları aç",
 *      "puanlamayı aç", ✅ / "evet" for the collector);
 *   2. the money path: the collector's reply is read by the model
 *      (`fee-confirm.ts`, 2026-10-30) and a Turkish org's replies and
 *      acks are in Turkish; a Turkish total is split, not charged per head;
 *   3. the English behaviour is untouched: a Turkish word means nothing
 *      to an English org's readers;
 *   4. the two places where English prose doubles as a key (the roster
 *      clarification dedupe probe, the fee prompt the model is shown)
 *      are built from the same table entry as the message.
 */
import { describe, it, expect } from "vitest";
import { buildFeeReplySystemPrompt, FEE_REPLY_SYSTEM_PROMPT, type FeeReplyRead } from "../fee-confirm";
import { runCollectorFeeReply, type CollectorFeeDeps } from "../payment-flow";
import {
  buildFeeConfirmPrompt,
  buildRosterSurveyClarification,
  rosterSurveyClarificationProbe,
} from "../dm-copy";
import { readBenchDmReply, readTentativeFastPath } from "../dm-reply-words";
import { dmSubAckMessage, parseDmSubscriptionCommand } from "../dm-subscriptions";
import { looksLikeQuestion } from "../dm-qa";
import { classifyDmSelfAttendance } from "../dm-self-attendance";
import { resolveReminderPhrase } from "../reminder-time";
import { t } from "../i18n/t";
import { buildLegacyFeatureMenu, legacyEventQuestion, legacySetupLang } from "../onboarding-conversation";

// ── 1. the money path ────────────────────────────────────────────────

const AMOUNT = 8;

const reading = (intent: FeeReplyRead["intent"], amount: number | null = null, amountIs: "each" | "total" | null = null): FeeReplyRead => ({
  intent,
  amount,
  amountIs,
  confidence: 0.95,
  reasoning: "stub",
});

function recorder(over: Partial<CollectorFeeDeps> = {}, read: FeeReplyRead = reading("neither")) {
  const calls = {
    released: [] as Array<{ matchId: string; amount: number }>,
    cancelled: [] as string[],
    staged: [] as Array<{ matchId: string; perPlayer: number }>,
    judged: [] as Array<{ text: string; lang: string }>,
  };
  const deps: CollectorFeeDeps = {
    pendingMatch: async () => ({ id: "m1", name: "Cuma Maçı", feePendingConfirm: AMOUNT, lang: "tr" }),
    headcount: async () => 13,
    judge: async (text, ask) => {
      calls.judged.push({ text, lang: ask.lang });
      return read;
    },
    release: async (matchId, amount) => {
      calls.released.push({ matchId, amount });
      return 13;
    },
    cancel: async (matchId) => {
      calls.cancelled.push(matchId);
    },
    stage: async (matchId, perPlayer) => {
      calls.staged.push({ matchId, perPlayer });
    },
    ...over,
  };
  return { deps, calls };
}

describe("runCollectorFeeReply, Turkish org (the model reads; stubbed here)", () => {
  it("a yes releases the links and replies in Turkish; the model is told the org's language", async () => {
    const { deps, calls } = recorder({}, reading("yes"));
    const res = await runCollectorFeeReply("evet", deps);
    expect(calls.released).toEqual([{ matchId: "m1", amount: AMOUNT }]);
    expect(calls.judged).toEqual([{ text: "evet", lang: "tr" }]);
    expect(res?.reply).toContain("13 ödeme linki gönderdim");
  });

  it("a no cancels and replies in Turkish", async () => {
    const { deps, calls } = recorder({}, reading("no"));
    const res = await runCollectorFeeReply("hayır", deps);
    expect(calls.cancelled).toEqual(["m1"]);
    expect(calls.released).toEqual([]);
    expect(res?.reply).toBe(t("tr").dm_fee_cancelled);
  });

  it('"harika maç 👍" read as neither releases NOTHING', async () => {
    const { deps, calls } = recorder({}, reading("neither"));
    expect(await runCollectorFeeReply("harika maç 👍", deps)).toBeNull();
    expect(calls.released).toEqual([]);
    expect(calls.cancelled).toEqual([]);
  });

  it("releases nothing when the model is unreachable", async () => {
    const { deps, calls } = recorder({
      judge: async () => {
        throw new Error("anthropic is down");
      },
    });
    expect(await runCollectorFeeReply("evet", deps)).toBeNull();
    expect(calls.released).toEqual([]);
  });

  it("a Turkish total read as a total is split, not charged per head", async () => {
    const { deps, calls } = recorder(
      { pendingMatch: async () => ({ id: "m1", name: "Cuma Maçı", feePendingConfirm: null, feeAsked: true, lang: "tr" }) },
      reading("amount", 104, "total"),
    );
    const res = await runCollectorFeeReply("toplam £104", deps);
    expect(calls.staged).toEqual([{ matchId: "m1", perPlayer: 8 }]);
    expect(res?.reply).toContain("kişi başı *£8* (13 kişiye bölündü)");
    expect(res?.reply).toContain('*✅* (ya da "evet")');
  });
});

describe("the fee prompt the model reads (rewritten whole, quoted-reply context S3, 2026-10-20)", () => {
  it("is one prompt for every club, with the Turkish examples beside the English", () => {
    expect(FEE_REPLY_SYSTEM_PROMPT).toBe(buildFeeReplySystemPrompt());
    expect(FEE_REPLY_SYSTEM_PROMPT).toContain('"harika maç 👍"');
    expect(FEE_REPLY_SYSTEM_PROMPT).toContain('"great game 👍"');
  });
  it("the question's own words now reach the model in the user turn (the chat context), not as a template", () => {
    // The collector is sent this; the classifier is shown it among
    // MatchTime's recent messages (reply-context-s3.test.ts).
    const sent = buildFeeConfirmPrompt({ perPlayer: 8, headcount: 13, matchName: "Cuma Maçı", wasTotal: false, lang: "tr" });
    expect(sent).toContain("£8");
    expect(FEE_REPLY_SYSTEM_PROMPT).not.toContain("£X");
  });
});

// ── 2. the bench-offer DM's replies ──────────────────────────────────

describe("the bench DM reply, Turkish", () => {
  for (const yes of ["evet", "EVET", "Evet!", "varım", "VARIM", "varim", "ben varım", "tamam", "olur", "alırım", "👍", "✅"]) {
    it(`${JSON.stringify(yes)} claims the slot for a Turkish org`, () => {
      expect(readBenchDmReply(yes, "tr")).toBe("yes");
    });
  }
  for (const no of ["hayır", "HAYIR", "yok", "yokum", "ben yokum", "olmaz", "gelemem", "gelemiyorum", "👎"]) {
    it(`${JSON.stringify(no)} declines for a Turkish org`, () => {
      expect(readBenchDmReply(no, "tr")).toBe("no");
    });
  }
  for (const unclear of ["belki", "kaçta başlıyor?", "bilmiyorum"]) {
    it(`${JSON.stringify(unclear)} is unclear (the clarification goes out)`, () => {
      expect(readBenchDmReply(unclear, "tr")).toBeNull();
    });
  }
  it("English is read exactly as before, and Turkish words mean nothing to it", () => {
    expect(readBenchDmReply("yes", "en")).toBe("yes");
    expect(readBenchDmReply("in", "en")).toBe("yes");
    expect(readBenchDmReply("can't tonight", "en")).toBe("no");
    expect(readBenchDmReply("maybe", "en")).toBeNull();
    expect(readBenchDmReply("evet", "en")).toBeNull();
  });
  it("the Turkish DM asks for exactly the words the reader accepts", () => {
    const dm = t("tr").dm_bench_offer({ firstName: "Erdal", context: "bu akşamki Cuma Maçı için", reactions: false });
    expect(dm).toContain("*EVET*");
    expect(readBenchDmReply("EVET", "tr")).toBe("yes");
    expect(t("tr").dm_bench_unclear({ day: null })).toContain("*EVET*");
    expect(t("tr").dm_bench_unclear({ day: "6 Ekim Salı" })).toContain("*EVET*");
  });
});

// ── 3. the tentative follow-up's fast path ───────────────────────────

describe("the tentative follow-up fast path, Turkish", () => {
  it("VARIM / YOKUM (what the DM asks for) are read without the model", () => {
    expect(readTentativeFastPath("VARIM", "tr")).toBe("in");
    expect(readTentativeFastPath("varım", "tr")).toBe("in");
    expect(readTentativeFastPath("geliyorum", "tr")).toBe("in");
    expect(readTentativeFastPath("evet", "tr")).toBe("in");
    expect(readTentativeFastPath("YOKUM", "tr")).toBe("out");
    expect(readTentativeFastPath("gelemiyorum", "tr")).toBe("out");
    expect(readTentativeFastPath("hayır", "tr")).toBe("out");
  });
  it("anything else goes to the classifier (which reads Turkish)", () => {
    expect(readTentativeFastPath("belki", "tr")).toBeNull();
    expect(readTentativeFastPath("yarın söylerim", "tr")).toBeNull();
    expect(readTentativeFastPath("var mı yer?", "tr")).toBeNull();
  });
  it("English is read exactly as before", () => {
    expect(readTentativeFastPath("in", "en")).toBe("in");
    expect(readTentativeFastPath("yes", "en")).toBe("in");
    expect(readTentativeFastPath("count me in!", "en")).toBe("in");
    expect(readTentativeFastPath("out", "en")).toBe("out");
    expect(readTentativeFastPath("nope", "en")).toBe("out");
    expect(readTentativeFastPath("maybe", "en")).toBeNull();
    expect(readTentativeFastPath("varım", "en")).toBeNull();
  });
  it("the Turkish follow-up asks for VARIM / YOKUM", () => {
    const dm = t("tr").dm_tentative_followup({ firstName: "Mehmet", activityName: "Cuma Maçı", whenLabel: "18 Eylül Cuma 21:00" });
    expect(dm).toContain("*VARIM*");
    expect(dm).toContain("*YOKUM*");
    expect(t("tr").dm_tentative_reask).toContain("*VARIM*");
  });
});

// ── 4. DM "IN" with no pending prompt ────────────────────────────────

describe("DM self-attendance, Turkish courtesy and day words", () => {
  for (const [text, want] of [
    ["varım abi", "in"],
    ["varım kanka", "in"],
    ["cuma varım", null],
    ["varım cuma", "in"],
    ["bu hafta varım", null],
    ["varım bu akşam", "in"],
    ["yokum yarın", "out"],
    ["yokum bu hafta", "out"],
    ["evet varım", "in"],
    ["tamam geliyorum", "in"],
    ["gelemiyorum sağol", "out"],
    ["yokum teşekkürler", "out"],
    ["varım pazartesi", "in"],
  ] as const) {
    it(`${JSON.stringify(text)} → ${want}`, () => {
      expect(classifyDmSelfAttendance(text)).toBe(want);
    });
  }
});

// ── 5. DM subscription commands ──────────────────────────────────────

describe("DM subscription commands, Turkish", () => {
  it("the command each Turkish ack quotes turns the thing back on", () => {
    const ackAll = dmSubAckMessage("opt-out-all", "tr");
    const ackRatings = dmSubAckMessage("opt-out-ratings", "tr");
    const quotedAll = /"([^"]+)"/.exec(ackAll)![1];
    const quotedRatings = /"([^"]+)"/.exec(ackRatings)![1];
    expect(parseDmSubscriptionCommand(quotedAll, "tr")).toBe("opt-in-all");
    expect(parseDmSubscriptionCommand(quotedRatings, "tr")).toBe("opt-in-ratings");
  });
  for (const [text, want] of [
    ["bana bir daha mesaj atma", "opt-out-all"],
    ["mesaj gönderme lütfen", "opt-out-all"],
    ["sadece ödeme ile ilgili yaz", "opt-out-all"],
    ["puanlama mesajı istemiyorum", "opt-out-ratings"],
    ["puanlamayı kapat", "opt-out-ratings"],
    ["Mesajları aç", "opt-in-all"],
    ["mesajları başlat", "opt-in-all"],
    ["PUANLAMAYI AÇ", "opt-in-ratings"],
    ["tamam", null],
    ["varım", null],
    ["dur", null],
    ["maç kaçta?", null],
  ] as const) {
    it(`${JSON.stringify(text)} → ${want}`, () => {
      expect(parseDmSubscriptionCommand(text, "tr")).toBe(want);
    });
  }
  it("an English org never reads the Turkish words, and reads its own as before", () => {
    expect(parseDmSubscriptionCommand("mesaj atma")).toBeNull();
    expect(parseDmSubscriptionCommand("mesaj atma", "en")).toBeNull();
    expect(parseDmSubscriptionCommand("stop")).toBe("opt-out-all");
    expect(parseDmSubscriptionCommand("start ratings")).toBe("opt-in-ratings");
    expect(parseDmSubscriptionCommand("stop", "tr")).toBe("opt-out-all");
  });
  it("the English acks are unchanged", () => {
    expect(dmSubAckMessage("opt-out-all")).toContain('Text "start messages" anytime');
  });
});

// ── 6. the DM Q&A gate ───────────────────────────────────────────────

describe("the DM Q&A gate, Turkish", () => {
  for (const q of ["maç ne zaman", "saat kaçta başlıyoruz", "kadroda kim var", "kaç kişiyiz", "nerede oynuyoruz", "istatistiklerim", "skor neydi", "geçen hafta maçın adamı kim oldu"]) {
    it(`${JSON.stringify(q)} is a question for a Turkish org`, () => {
      expect(looksLikeQuestion(q, "tr")).toBe(true);
    });
  }
  for (const ack of ["tamam", "sağol", "sağ ol", "teşekkürler", "eyvallah", "süper", "👍", "ok"]) {
    it(`${JSON.stringify(ack)} is an ack, not a question`, () => {
      expect(looksLikeQuestion(ack, "tr")).toBe(false);
    });
  }
  it("English is gated exactly as before", () => {
    expect(looksLikeQuestion("when is the next match")).toBe(true);
    expect(looksLikeQuestion("thanks")).toBe(false);
    expect(looksLikeQuestion("maç ne zaman")).toBe(false);
    expect(looksLikeQuestion("maç ne zaman?")).toBe(true);
  });
});

// ── 7. the roster check-in dedupe probe ──────────────────────────────

describe("the roster clarification probe is the message's own opening", () => {
  for (const lang of ["en", "tr"] as const) {
    for (const firstName of ["Sait", null]) {
      it(`${lang}, first name ${firstName ?? "missing"}`, () => {
        const msg = buildRosterSurveyClarification({ firstName, orgName: "Sutton FC", lang });
        expect(msg.startsWith(rosterSurveyClarificationProbe(firstName, lang))).toBe(true);
      });
    }
  }
  it("the English probe is the clarification's own opening sentence", () => {
    expect(rosterSurveyClarificationProbe("Sait", "en")).toBe(
      "Sorry Sait, I wasn't sure if that was a reply to the roster check-in",
    );
    expect(rosterSurveyClarificationProbe(null, "en")).toBe(
      "Sorry mate, I wasn't sure if that was a reply to the roster check-in",
    );
  });
});

// ── 8. the reminder label, and the Turkish day words ─────────────────

describe("reminder-time, Turkish", () => {
  const now = new Date("2026-09-08T10:00:00.000Z"); // Tue 8 Sep 11:00 London
  it("labels the resolved time in Turkish", () => {
    const r = resolveReminderPhrase("perşembe saat 9", now, "tr");
    expect(r.ok && r.whenLabel).toBe("10 Eylül Perşembe 09:00");
    const bare = resolveReminderPhrase("thursday", now, "tr");
    expect(bare.ok && bare.whenLabel).toBe("10 Eylül Perşembe");
    const d = resolveReminderPhrase("tomorrow", now, "tr");
    expect(d.ok && d.statedTime).toBe(false);
    expect(d.ok && d.whenLabel).toBe("9 Eylül Çarşamba");
  });
  it("English labels are unchanged", () => {
    const r = resolveReminderPhrase("thursday", now);
    expect(r.ok && r.whenLabel).toBe("Thu 10 Sep");
    const r2 = resolveReminderPhrase("friday at 6pm", now, "en");
    expect(r2.ok && r2.whenLabel).toBe("Fri 11 Sep at 18:00");
  });
  for (const [phrase, iso] of [
    ["yarın", "2026-09-09T08:00:00.000Z"],
    ["yarın akşam", "2026-09-09T17:00:00.000Z"],
    ["yarın sabah", "2026-09-09T08:00:00.000Z"],
    ["bu akşam", "2026-09-08T17:00:00.000Z"],
    ["perşembe", "2026-09-10T08:00:00.000Z"],
    ["Perşembe", "2026-09-10T08:00:00.000Z"],
    ["cuma", "2026-09-11T08:00:00.000Z"],
    ["cumartesi", "2026-09-12T08:00:00.000Z"],
    ["pazartesi akşam", "2026-09-14T17:00:00.000Z"],
    ["2 saat sonra", "2026-09-08T12:00:00.000Z"],
    ["bir hafta sonra", "2026-09-15T10:00:00.000Z"],
    ["öbür gün", "2026-09-10T08:00:00.000Z"],
  ] as const) {
    it(`${JSON.stringify(phrase)} resolves for a Turkish org`, () => {
      const r = resolveReminderPhrase(phrase, now, "tr");
      expect(r.ok && r.at.toISOString()).toBe(iso);
    });
  }
  it("vague Turkish phrases are refused, not guessed", () => {
    expect(resolveReminderPhrase("sonra", now, "tr").ok).toBe(false);
    expect(resolveReminderPhrase("birazdan", now, "tr").ok).toBe(false);
  });
  it("an English org does not read Turkish day words", () => {
    expect(resolveReminderPhrase("cuma", now).ok).toBe(false);
  });
});

// ── 8b. the legacy "@Match Time setup" trigger picks the language ────

describe("legacy setup: the trigger decides the session language", () => {
  it("a Turkish trigger word starts a Turkish session", () => {
    expect(legacySetupLang(["@Match Time kurulum"])).toBe("tr");
    expect(legacySetupLang(["@MatchTime KURALIM"])).toBe("tr");
    expect(legacySetupLang(["@Match Time kuralım lütfen"])).toBe("tr");
  });
  it("Turkish chat around an English trigger reads as Turkish", () => {
    expect(legacySetupLang(["arkadaşlar bu hafta cuma maç var", "@Match Time setup"])).toBe("tr");
  });
  it("an English trigger starts an English session, as it always did", () => {
    expect(legacySetupLang(["@Match Time setup"])).toBe("en");
    expect(legacySetupLang(["hey @MatchTime set up this group please"])).toBe("en");
  });
  it("the Turkish flow asks its questions in Turkish, and the English flow is unchanged", () => {
    expect(legacyEventQuestion({}, "tr")).toContain("kuralım");
    expect(legacyEventQuestion({})).toContain("Let's get MatchTime set up");
    expect(buildLegacyFeatureMenu("x", "tr")).toContain('"hepsi"');
  });
});

// ── 8c. the day-one intro names the reaction the engine really gives ─

describe("the intro's reaction promise matches the engine (Phase 3c)", () => {
  // `pipeline/engine.ts` `reactFor`: the sender's own row gets ✅ when
  // confirmed (🪑 benched, 👋 dropped); 👍 is only for a third-party claim
  // or a score. The English intro said 👍 until 2026-09-17.
  for (const lang of ["en", "tr"] as const) {
    it(lang, () => {
      expect(t(lang).intro_attendance).toContain("✅");
      expect(t(lang).intro_attendance).not.toContain("👍");
    });
  }
});

// ── 9. no private message tells a Turkish player to type English ─────

describe("the Turkish DMs never ask for an English word", () => {
  const s = t("tr");
  const rendered = [
    s.dm_tentative_followup({ firstName: null, activityName: "Cuma Maçı", whenLabel: "x" }),
    s.dm_tentative_reask,
    s.dm_bench_offer({ firstName: "", context: "x", reactions: true }),
    s.dm_bench_offer({ firstName: "", context: "x", reactions: false }),
    s.dm_bench_unclear({ day: null }),
    s.dm_bench_unclear({ day: "6 Ekim Salı" }),
    s.dm_recruit_invite({ firstName: null, matchName: "x", matchWhen: "y", spotsLeft: 0, link: null, reactions: true }),
    s.dm_recruit_group_invite({ firstName: null, matchName: "x", matchWhen: "y" }),
    s.dm_recruit_chase({ firstName: null, count: 1, activityName: "x", matchWhen: "y" }),
    s.dm_survey_confirm({ category: "maybe", firstName: null }),
    s.dm_fee_confirm_prompt({ fee: "£8", headcount: 13, matchName: "x", wasTotal: false }),
    s.dm_fee_ask({ firstName: null, activityName: "x", headcount: 0 }),
  ];
  for (const text of rendered) {
    it(text.slice(0, 40), () => {
      expect(text).not.toMatch(/\*(IN|OUT|YES|NO)\*|"yes"|"start /);
      expect(text).not.toMatch(/[—–]/);
    });
  }
});
