/**
 * THE TWO DETERMINISTIC DM READERS in `api/whatsapp/dm-reply/route.ts`,
 * per language (Phase 3 of MDs/multi-language-design-2026-09-16.md).
 *
 * Both answer a question MatchTime asked in writing a moment ago, which
 * is why a word list is tolerable here at all:
 *
 *   - the bench-offer DM said "reply *YES*" (Turkish: *EVET*). There is
 *     no model behind this reader: anything it does not recognise gets
 *     ONE clarification, so a miss costs a re-typed word;
 *   - the tentative follow-up said "reply *IN* or *OUT*" (Turkish:
 *     *VARIM* / *YOKUM*). This one is only a FAST PATH: anything it does
 *     not recognise goes to `classifyMatchAvailability`, which already
 *     reads Turkish.
 *
 * The ENGLISH readers are the route's inline regexes, moved here
 * verbatim and run only for an English org, so the English behaviour is
 * exactly what it was (prefix matches and all).
 *
 * The TURKISH readers are deliberately stricter: the whole message must
 * be one of the listed answers, optionally with a courtesy word. A
 * prefix match is not safe in Turkish: "tamam, gelemiyorum" (ok, I can't
 * come) starts with a yes, and the English "in" prefix would read
 * "inşallah" (a hedge) as a claim. Lower-cased with
 * `toLocaleLowerCase("tr")`, so "EVET", "VARIM" and "HAYIR" read right.
 */
import { normaliseLang, type Lang } from "./i18n/lang";

// ── English, verbatim from the route ─────────────────────────────────

function benchEn(text: string): "yes" | "no" | null {
  const t = text.trim().toLowerCase();
  const isYes =
    /^(y|yes+|yep|yeah|ya|sure|ok(ay)?|in|i'?m in|am in|confirm(ed)?|can do|deal|done|grab|i'?ll take|take it|👍|✅|✔️?|🙋)\b/.test(t) ||
    t === "👍" || t === "✅" || t === "🙋";
  const isNo =
    /^(n|no+|nope|nah|can'?t|cannot|cant|pass|sorry|out|not me|next time|unable|👎)\b/.test(t) ||
    t === "👎";
  if (isYes) return "yes";
  if (isNo) return "no";
  return null;
}

function tentativeEn(text: string): "in" | "out" | null {
  const t = (text ?? "").trim().toLowerCase().replace(/[!.\s]+$/g, "");
  const isIn = /^(in|i'?m in|count me in|in please|yes,?\s*(i'?m )?in|yes|y|👍|✅)\b/.test(t) || t === "in" || t === "yes";
  const isOut =
    /^(out|i'?m out|count me out|can'?t make it|cant make it|no,?\s*(i'?m )?out|no|nope|nah|👎)\b/.test(t) ||
    t === "out" ||
    t === "no";
  if (isIn) return "in";
  if (isOut) return "out";
  return null;
}

// ── Turkish, whole-message ───────────────────────────────────────────

/** Courtesy words a Turkish answer may end with. */
const TR_TAIL = String.raw`(?:\s+(?:abi|kanka|hocam|l[üu]tfen|sa[ğg]\s?ol|te[şs]ekk[üu]rler|eyvallah))*`;

function wholeTr(cores: string[]): RegExp {
  return new RegExp(String.raw`^(?:${cores.join("|")})${TR_TAIL}$`, "u");
}

function normTr(text: string): string {
  return (text ?? "")
    .toLocaleLowerCase("tr")
    .replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, "")
    .replace(/[,!.…\s]+$/gu, "")
    .replace(/[,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const BENCH_YES_TR = wholeTr([
  String.raw`evet(?:\s+(?:al[ıi]r[ıi]m|isterim|var[ıi]m))?`,
  String.raw`(?:ben\s+)?var(?:[ıi]m)?`,
  String.raw`tamam(?:d[ıi]r)?`,
  String.raw`tmm`,
  String.raw`olur`,
  String.raw`al[ıi]r[ıi]m`,
  String.raw`isterim`,
  String.raw`geliyorum`,
  String.raw`ok(?:ey)?`,
  String.raw`yes`,
  String.raw`👍`,
  String.raw`✅`,
  String.raw`✔`,
  String.raw`🙋`,
]);

const BENCH_NO_TR = wholeTr([
  String.raw`hay[ıi]r`,
  String.raw`(?:ben\s+)?yok(?:um)?`,
  String.raw`olmaz`,
  String.raw`gelemem`,
  String.raw`gelemiyorum`,
  String.raw`ge[çc]iyorum`,
  String.raw`istemiyorum`,
  String.raw`pas`,
  String.raw`no`,
  String.raw`👎`,
]);

const TENTATIVE_IN_TR = wholeTr([
  String.raw`(?:evet\s+)?(?:ben\s+)?var(?:[ıi]m)?`,
  String.raw`evet`,
  String.raw`(?:evet\s+)?geliyorum`,
  String.raw`say[ıi]n beni`,
  String.raw`yes`,
  String.raw`in`,
  String.raw`👍`,
  String.raw`✅`,
]);

const TENTATIVE_OUT_TR = wholeTr([
  String.raw`(?:ben\s+|bu hafta\s+)?yok(?:um)?`,
  String.raw`hay[ıi]r`,
  String.raw`gelemiyorum`,
  String.raw`gelemem`,
  String.raw`no`,
  String.raw`out`,
  String.raw`👎`,
]);

/**
 * The bench-offer DM reply: "yes" claims the slot, "no" declines, null
 * means "not sure what that was" (the route sends one clarification).
 * `lang` is the language of the match whose slot was offered.
 */
export function readBenchDmReply(text: string, lang?: Lang | string | null): "yes" | "no" | null {
  if (normaliseLang(lang) !== "tr") return benchEn(text);
  const t = normTr(text);
  if (BENCH_NO_TR.test(t)) return "no";
  if (BENCH_YES_TR.test(t)) return "yes";
  return null;
}

/**
 * The tentative follow-up's free fast path: "in" / "out", or null to ask
 * the classifier. `lang` is the language of the match that was asked about.
 */
export function readTentativeFastPath(text: string, lang?: Lang | string | null): "in" | "out" | null {
  if (normaliseLang(lang) !== "tr") return tentativeEn(text);
  const t = normTr(text);
  if (TENTATIVE_OUT_TR.test(t)) return "out";
  if (TENTATIVE_IN_TR.test(t)) return "in";
  return null;
}
