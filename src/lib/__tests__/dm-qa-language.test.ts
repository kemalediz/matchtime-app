/**
 * THE DM Q&A IN THE ORG'S LANGUAGE (Phase 3).
 *
 * `composeScopedAnswer` is the model half of the scoped DM Q&A with the
 * database already read. These tests drive it with a recording call, so
 * they prove the WIRING: the English prompt is exactly what it was, a
 * Turkish org's prompt carries the language line in the user turn (the
 * system prompt is shared and unchanged), the Turkish answer is passed
 * through the house-style pass, and every failure degrades to the apology
 * in the org's language. Whether the real model actually answers in
 * Turkish is measured live by `scripts/dryrun-dm-qa.ts`.
 */
import { describe, it, expect } from "vitest";
import { composeScopedAnswer, dmQaLanguageLine, type DmQaCall } from "../dm-qa";
import { t } from "../i18n/t";

function recording(reply: { text: string | null; truncated: boolean }) {
  const seen: Array<{ system: string; user: string }> = [];
  const call: DmQaCall = async (system, user) => {
    seen.push({ system, user });
    return reply;
  };
  return { call, seen };
}

const BASE = { context: "GROUP: Cuma Futbol", question: "maç ne zaman?", askerName: "Mehmet Yılmaz", orgName: "Cuma Futbol" };

describe("composeScopedAnswer", () => {
  it("English: the user turn is the shipped shape, with no language line", async () => {
    const { call, seen } = recording({ text: "  Tuesday at 21:30 — see you there  ", truncated: false });
    const out = await composeScopedAnswer({ ...BASE, question: "when is the match?", askerName: "Sait Demir", lang: "en", call });
    expect(seen[0].user).toBe(
      [
        "CONTEXT (everything you're allowed to use — nothing else exists for you):",
        "GROUP: Cuma Futbol",
        "",
        "The player (Sait) asks:",
        "when is the match?",
        "",
        "Answer per your rules.",
      ].join("\n"),
    );
    // The English answer is trimmed and otherwise untouched (dash kept).
    expect(out).toEqual({ answer: "Tuesday at 21:30 — see you there", truncated: false });
  });

  it("Turkish: the language line rides in the user turn; the system prompt is the same", async () => {
    const en = recording({ text: "x", truncated: false });
    const tr = recording({ text: "x", truncated: false });
    await composeScopedAnswer({ ...BASE, lang: "en", call: en.call });
    await composeScopedAnswer({ ...BASE, lang: "tr", call: tr.call });
    expect(tr.seen[0].system).toBe(en.seen[0].system);
    expect(tr.seen[0].user).toContain(dmQaLanguageLine("tr", "Cuma Futbol")!);
    expect(tr.seen[0].user).toContain("TURKISH");
    expect(tr.seen[0].user).toContain('"sen"');
    // The turn still ENDS with the instruction, as the English one does:
    // a trailing section made the model invent a continuation (live, 4 in 60).
    expect(tr.seen[0].user.endsWith("\n\nAnswer per your rules.")).toBe(true);
    expect(tr.seen[0].user).not.toContain("## ");
    // Everything the English turn says, the Turkish turn says in the same order.
    const enLines = en.seen[0].user.split("\n").filter((l) => l !== "");
    const trLines = tr.seen[0].user.split("\n").filter((l) => enLines.includes(l));
    expect(trLines).toEqual(enLines);
  });

  it("Turkish: invented trailing markup is cut off (seen live, 3 in 30)", async () => {
    for (const junk of [
      "\n\n<rate_limit>\n<call>completion</call>\n</rate_limit>",
      "\n\n<budget:tokens input=1087 output=80 total=1167 percent=0.58%>",
      '\n\n<tool_call>\n{"name": "save_message_metadata"}\n</tool_call>',
    ]) {
      const { call } = recording({ text: `Maç: 18 Eylül Cuma 21:00, yer: Sim Arena ⚽${junk}`, truncated: false });
      const out = await composeScopedAnswer({ ...BASE, lang: "tr", call });
      expect(out.answer).toBe("Maç: 18 Eylül Cuma 21:00, yer: Sim Arena ⚽");
    }
  });

  it("Turkish: dashes and markdown bold are scrubbed from the answer", async () => {
    const { call } = recording({ text: "Maç **18 Eylül Cuma 21:00** — Sim Arena'da.", truncated: false });
    const out = await composeScopedAnswer({ ...BASE, lang: "tr", call });
    expect(out.answer).toBe("Maç *18 Eylül Cuma 21:00*, Sim Arena'da.");
  });

  it("Turkish: a fabricated next turn the model appended is cut off (seen live, 1 in 30)", async () => {
    const { call } = recording({
      text: "Geçen hafta maçın adamı *Mehmet Yılmaz* oldu 🎉\n\nUser: bugun kim mac oynuyor ve kac kisi",
      truncated: false,
    });
    const out = await composeScopedAnswer({ ...BASE, lang: "tr", call });
    expect(out.answer).toBe("Geçen hafta maçın adamı *Mehmet Yılmaz* oldu 🎉");
  });

  it("a truncated or empty answer becomes the apology, in the org's language", async () => {
    for (const lang of ["en", "tr"] as const) {
      const cut = await composeScopedAnswer({ ...BASE, lang, call: recording({ text: "half a sente", truncated: true }).call });
      expect(cut).toEqual({ answer: t(lang).dm_qa_apology, truncated: true });
      const none = await composeScopedAnswer({ ...BASE, lang, call: recording({ text: null, truncated: false }).call });
      expect(none.answer).toBe(t(lang).dm_qa_apology);
    }
  });

  it("Turkish: the language line says to copy dates, and quotes no date of its own (2026-09-17)", () => {
    // A concrete example date in the instructions ("18 Eylül Cuma") is a
    // date the model can copy into an answer about a different match.
    const line = dmQaLanguageLine("tr", "Cuma Futbol")!;
    expect(line).toContain("Write this match as");
    expect(line).toMatch(/never work out a weekday/i);
    expect(line).not.toMatch(/Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık/);
    expect(line).not.toMatch(/Pazartesi|Salı|Çarşamba|Perşembe|Cuma(?! Futbol)|Cumartesi|Pazar/);
    expect(line).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("English has no language line at all", () => {
    expect(dmQaLanguageLine("en", "Sutton FC")).toBeNull();
  });
});
