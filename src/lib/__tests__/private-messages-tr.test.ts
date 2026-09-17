/**
 * PHASE 3: WHAT A TURKISH PLAYER RECEIVES PRIVATELY, AND WHAT THEY TYPE BACK.
 *
 * The copy itself is pinned by the golden snapshots (`copy.en.snap`,
 * `copy.tr.snap`). This file pins the SEAMS around it:
 *
 *   1. the words a Turkish DM tells the player to type are the words the
 *      reader accepts (*EVET* / *VARIM* / *YOKUM*, "mesajları aç",
 *      "puanlamayı aç", ✅ / "evet" for the collector);
 *   2. the money path: Turkish "evet" / "tamam" / "✅" / "hayır" behave
 *      like their English counterparts, and "harika maç 👍" releases
 *      nothing, exactly as "great game 👍" does;
 *   3. the English behaviour is untouched: a Turkish word means nothing
 *      to an English org's readers;
 *   4. the two places where English prose doubles as a key (the roster
 *      clarification dedupe probe, the fee prompt the model is shown)
 *      are built from the same table entry as the message.
 */
import { describe, it, expect } from "vitest";
import { anchoredFeeReply, buildFeeReplySystemPrompt, FEE_REPLY_SYSTEM_PROMPT } from "../fee-confirm";
import { runCollectorFeeReply, type CollectorFeeDeps } from "../payment-flow";
import { parseFeeReply } from "../payments";
import {
  buildFeeConfirmPrompt,
  buildRosterSurveyClarification,
  feeConfirmQuestionForPrompt,
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

describe("fee confirmation, Turkish: the anchored allowlist", () => {
  for (const yes of ["evet", "Evet", "EVET", "evet.", "tamam", "Tamam!", "tamamdır", "tmm", "✅", "👍", "✅ evet", "evet ✅", "evet gönder", "gönder", "olur", "onaylıyorum", "ok"]) {
    it(`${JSON.stringify(yes)} is a yes for a Turkish org`, () => {
      expect(anchoredFeeReply(yes, "tr")).toBe("yes");
    });
  }
  for (const no of ["hayır", "HAYIR", "Hayır.", "hayir", "yok", "bekle", "iptal", "dur", "şimdi değil", "henüz değil", "❌", "👎", "❌ hayır", "no"]) {
    it(`${JSON.stringify(no)} is a no for a Turkish org`, () => {
      expect(anchoredFeeReply(no, "tr")).toBe("no");
    });
  }
  for (const neither of [
    "harika maç 👍",
    "harika maç",
    "eline sağlık 👍",
    "tamam yarın hallederim",
    "evet, parayı Elvin topluyor",
    "kaç kişi ödüyor?",
    "hayır ✅",
    "👍❌",
    "e",
    "süper",
    "tamam 12",
  ]) {
    it(`${JSON.stringify(neither)} abstains (the fragment rule holds in Turkish)`, () => {
      expect(anchoredFeeReply(neither, "tr")).toBeNull();
    });
  }

  it("an English org does not read Turkish words: 'evet' and 'hayır' abstain", () => {
    expect(anchoredFeeReply("evet", "en")).toBeNull();
    expect(anchoredFeeReply("hayır", "en")).toBeNull();
    expect(anchoredFeeReply("evet")).toBeNull();
  });

  it("an English org still reads its own words exactly as before", () => {
    expect(anchoredFeeReply("yes", "en")).toBe("yes");
    expect(anchoredFeeReply("✅")).toBe("yes");
    expect(anchoredFeeReply("great game 👍", "en")).toBeNull();
    expect(anchoredFeeReply("no", "en")).toBe("no");
  });
});

const AMOUNT = 8;

function recorder(over: Partial<CollectorFeeDeps> = {}) {
  const calls = {
    released: [] as Array<{ matchId: string; amount: number }>,
    cancelled: [] as string[],
    staged: [] as Array<{ matchId: string; perPlayer: number }>,
    judged: [] as Array<{ text: string; lang: string }>,
  };
  const deps: CollectorFeeDeps = {
    pendingMatch: async () => ({ id: "m1", name: "Cuma Maçı", feePendingConfirm: AMOUNT, lang: "tr" }),
    headcount: async () => 13,
    judge: async (text, _amount, _name, lang) => {
      calls.judged.push({ text, lang });
      return "neither";
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

describe("runCollectorFeeReply, Turkish org", () => {
  for (const yes of ["evet", "tamam", "✅"]) {
    it(`${JSON.stringify(yes)} releases the links like "yes" does, without the model, and replies in Turkish`, async () => {
      const { deps, calls } = recorder();
      const res = await runCollectorFeeReply(yes, deps);
      expect(calls.released).toEqual([{ matchId: "m1", amount: AMOUNT }]);
      expect(calls.judged).toEqual([]);
      expect(res?.reply).toContain("13 ödeme linki gönderdim");
    });
  }

  it('"hayır" cancels like "no" does, and replies in Turkish', async () => {
    const { deps, calls } = recorder();
    const res = await runCollectorFeeReply("hayır", deps);
    expect(calls.cancelled).toEqual(["m1"]);
    expect(calls.released).toEqual([]);
    expect(res?.reply).toBe(t("tr").dm_fee_cancelled);
  });

  it('"harika maç 👍" releases NOTHING (the model is asked, in Turkish, and says neither)', async () => {
    const { deps, calls } = recorder();
    const res = await runCollectorFeeReply("harika maç 👍", deps);
    expect(calls.released).toEqual([]);
    expect(calls.cancelled).toEqual([]);
    expect(res).toBeNull();
    expect(calls.judged).toEqual([{ text: "harika maç 👍", lang: "tr" }]);
  });

  it('"harika maç 👍" releases nothing even when the model is unreachable', async () => {
    const { deps, calls } = recorder({
      judge: async () => {
        throw new Error("anthropic is down");
      },
    });
    expect(await runCollectorFeeReply("harika maç 👍", deps)).toBeNull();
    expect(calls.released).toEqual([]);
  });

  it("a Turkish total is split, not charged per head", async () => {
    const { deps, calls } = recorder({
      pendingMatch: async () => ({ id: "m1", name: "Cuma Maçı", feePendingConfirm: null, lang: "tr" }),
    });
    const res = await runCollectorFeeReply("toplam £104", deps);
    expect(calls.staged).toEqual([{ matchId: "m1", perPlayer: 8 }]);
    expect(res?.reply).toContain("kişi başı *£8* (13 kişiye bölündü)");
    expect(res?.reply).toContain('*✅* (ya da "evet")');
  });

  it("a Turkish per-head amount with no £ is still captured", async () => {
    const { deps, calls } = recorder({
      pendingMatch: async () => ({ id: "m1", name: "Cuma Maçı", feePendingConfirm: null, lang: "tr" }),
    });
    await runCollectorFeeReply("kişi başı 8", deps);
    expect(calls.staged).toEqual([{ matchId: "m1", perPlayer: 8 }]);
  });

  it("an English org's collector is unaffected: no lang means English", async () => {
    const { deps, calls } = recorder({
      pendingMatch: async () => ({ id: "m1", name: "Tuesday 7-a-side", feePendingConfirm: AMOUNT }),
    });
    const res = await runCollectorFeeReply("yes", deps);
    expect(calls.released).toHaveLength(1);
    expect(res?.reply).toContain("13 pay links");
    expect(await runCollectorFeeReply("evet", recorder({
      pendingMatch: async () => ({ id: "m1", name: "Tuesday 7-a-side", feePendingConfirm: AMOUNT }),
    }).deps)).toBeNull();
  });
});

describe("parseFeeReply, Turkish totals", () => {
  it("toplam / bölüş / hepsi / saha mean a total for a Turkish org", () => {
    expect(parseFeeReply("toplam £80", 10, "tr")).toEqual({ perPlayer: 8, wasTotal: true });
    expect(parseFeeReply("80 bölüşelim", 10, "tr")).toEqual({ perPlayer: 8, wasTotal: true });
    expect(parseFeeReply("£80, bölüşülsün", 10, "tr")).toEqual({ perPlayer: 8, wasTotal: true });
    expect(parseFeeReply("saha 80", 10, "tr")).toEqual({ perPlayer: 8, wasTotal: true });
    expect(parseFeeReply("kişi başı £8", 10, "tr")).toEqual({ perPlayer: 8, wasTotal: false });
  });
  it("an English org's parse is unchanged", () => {
    expect(parseFeeReply("toplam £80", 10)).toEqual({ perPlayer: 80, wasTotal: false });
    expect(parseFeeReply("£80 total", 10)).toEqual({ perPlayer: 8, wasTotal: true });
  });
});

describe("the fee prompt the model reads is built from the message the collector got", () => {
  it("English: byte for byte the line the prompt always quoted", () => {
    expect(feeConfirmQuestionForPrompt("en")).toBe(
      'Got it — £X per player for <match>, N players to charge. Reply ✅ (or \\"yes\\") to send everyone their pay link, or send a different amount to change it.',
    );
    expect(FEE_REPLY_SYSTEM_PROMPT).toBe(buildFeeReplySystemPrompt("en"));
    expect(FEE_REPLY_SYSTEM_PROMPT).toContain(feeConfirmQuestionForPrompt("en"));
  });
  it("Turkish: quotes the Turkish question and names the Turkish banter case", () => {
    const tr = buildFeeReplySystemPrompt("tr");
    expect(tr).toContain(feeConfirmQuestionForPrompt("tr"));
    expect(feeConfirmQuestionForPrompt("tr")).toContain("£X");
    expect(tr).toContain('"harika maç 👍"');
    expect(tr).not.toContain("Got it — £X");
    // The question the model is shown is the one the collector was sent.
    const sent = buildFeeConfirmPrompt({ perPlayer: 8, headcount: 13, matchName: "Cuma Maçı", wasTotal: false, lang: "tr" });
    expect(sent.replace(/\*/g, "").replace(/\n\n/g, " ")).toBe(
      feeConfirmQuestionForPrompt("tr").replace(/\\"/g, '"').replace("£X", "£8").replace("<match>", "Cuma Maçı").replace("N kişiden", "13 kişiden"),
    );
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
    expect(t("tr").dm_bench_unclear).toContain("*EVET*");
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
  it("the English probe is byte for byte the old prefix", () => {
    expect(rosterSurveyClarificationProbe("Sait", "en")).toBe(
      "Sorry Sait — wasn't sure if that was a reply to the roster check-in",
    );
    expect(rosterSurveyClarificationProbe(null, "en")).toBe(
      "Sorry mate — wasn't sure if that was a reply to the roster check-in",
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
    s.dm_bench_unclear,
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
