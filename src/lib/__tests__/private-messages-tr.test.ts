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
import { dmSubAckMessage } from "../dm-subscriptions";
import { DM_INTENT_SYSTEM_PROMPT } from "../dm-intent";
import { reminderInstant } from "../reminder-time";
import { t } from "../i18n/t";

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
      { pendingMatch: async () => ({ id: "m1", name: "Cuma Maçı", feePendingConfirm: null, lang: "tr" }) },
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

// ── 2. DM subscription commands ──────────────────────────────────────

describe("DM subscription commands, Turkish (read by the one DM reader since 2026-10-30)", () => {
  it("the command each ack quotes is one of the reader's resume examples, in both languages", () => {
    for (const lang of ["en", "tr"] as const) {
      const quotedAll = /"([^"]+)"/.exec(dmSubAckMessage("opt-out-all", lang))![1];
      const quotedRatings = /"([^"]+)"/.exec(dmSubAckMessage("opt-out-ratings", lang))![1];
      expect(DM_INTENT_SYSTEM_PROMPT).toContain(`"${quotedAll}"`);
      expect(DM_INTENT_SYSTEM_PROMPT).toContain(`"${quotedRatings}"`);
    }
  });
  it("the English acks are unchanged", () => {
    expect(dmSubAckMessage("opt-out-all")).toContain('Text "start messages" anytime');
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

describe("reminder-time, Turkish (the extractor states the time since 2026-10-30)", () => {
  it("labels the time in Turkish", () => {
    const r = reminderInstant("2026-09-10 09:00", "tr");
    expect(r.ok && r.whenLabel).toBe("10 Eylül Perşembe 09:00");
  });
  it("English labels", () => {
    const r = reminderInstant("2026-09-11 18:00", "en");
    expect(r.ok && r.whenLabel).toBe("Fri 11 Sep at 18:00");
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
