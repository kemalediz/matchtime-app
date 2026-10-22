/**
 * THE SETUP-ANSWER READING: THE PAID CHECK (2026-10-22).
 *
 * `EXTRACT_PROMPT` (onboarding-conversation.ts) reads the answers a group
 * gives while setting MatchTime up: the club's name, venue, day, kickoff,
 * size, how often, a one-off date, and the feature pick. It had no live
 * check. This drives the shipped `extractSetupAnswers` against the real
 * model, each case ONCE, and grades the MODEL'S OWN answer (before the
 * regex backfill, which would hide a miss), field by field:
 *   - `want`: fields that must have exactly this value;
 *   - `nulls`: fields that must be null (nothing stated, never guessed);
 *   - `maxConfidence` / `minConfidence` where the case is about it.
 * Every behaviour the prompt handles has a case, in English and Turkish.
 *
 *   TAG=old|new OUT=/path/result.json \
 *     DATABASE_URL=postgresql://none@127.0.0.1:1/none \
 *     node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-onboarding-extract.ts
 *
 *   ONLY=<case name> runs one case.
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it) and stops at
 * MAX_USD (default $0.20). Touches no database and sends nothing. Each
 * case is one call, on "today" = Thursday 22 October 2026, London.
 */
import fs from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { armModel } from "../e2e/helpers/arm-model.ts";
import {
  extractSetupAnswers,
  ONBOARDING_EXTRACT_CALL,
  type KnownSetup,
} from "../src/lib/onboarding-conversation.ts";
import { extractJson } from "../src/lib/pipeline/llm.ts";

spendDevApiKeyOrExit("the setup-answer reading live check");
const TAG = process.env.TAG ?? "new";
const { model, calls, usd } = armModel(ONBOARDING_EXTRACT_CALL, Number(process.env.MAX_USD ?? 0.2));

const NOW = new Date("2026-10-22T11:00:00Z");
const ALL8 = ["attendance", "bench", "teamBalancing", "momVoting", "playerRating", "reminders", "statsQa", "paymentTracking"];
const NOT_PAY = ALL8.filter((k) => k !== "paymentTracking");

type Field = "groupName" | "venue" | "dayOfWeek" | "kickoffTime" | "playersPerSide" | "recurrence" | "oneOffDate" | "featureSelection";
interface Case {
  name: string;
  teaches: string;
  known?: Partial<KnownSetup>;
  msgs: Array<[string, string]>;
  want?: Partial<Record<Field, unknown>>;
  nulls?: Field[];
  maxConfidence?: number;
  minConfidence?: number;
}

const EMPTY: KnownSetup = {
  groupName: null, venue: null, dayOfWeek: null, kickoffTime: null,
  playersPerSide: null, recurrence: null, oneOffDate: null, stage: "collecting",
};
const NAMED = { groupName: "Thursday Ballers" };
const ALL_EVENT = { groupName: "Thursday Ballers", playersPerSide: 7, dayOfWeek: 4, kickoffTime: "20:00", venue: "Goals Sutton" };

const CASES: Case[] = [
  // ── when and where, all in one answer ──
  { name: "en-details", teaches: "day, time, venue, size in one answer", known: { ...NAMED, stage: "details" },
    msgs: [["Olive", "We play tuesdays at 9:30pm at Goals Star City, 7 a side"]],
    want: { dayOfWeek: 2, kickoffTime: "21:30", venue: "Goals Star City", playersPerSide: 7 }, nulls: ["featureSelection", "oneOffDate"] },
  { name: "tr-details", teaches: "the same in Turkish, venue without its case ending", known: { ...NAMED, stage: "details" },
    msgs: [["Erdal", "Cumaları akşam 9 buçukta Sim Arena'da oynuyoruz, 7'ye 7"]],
    want: { dayOfWeek: 5, kickoffTime: "21:30", venue: "Sim Arena", playersPerSide: 7 }, nulls: ["featureSelection", "oneOffDate"] },
  { name: "tr-saat", teaches: "a Turkish clock time and day", known: { ...NAMED, stage: "details" },
    msgs: [["Erdal", "Salı saat 21:30, Hackney Marshes"]],
    want: { dayOfWeek: 2, kickoffTime: "21:30", venue: "Hackney Marshes" } },
  { name: "en-no-venue", teaches: "a venue nobody named stays null", known: { ...NAMED, stage: "details" },
    msgs: [["Olive", "Wednesday 8pm"]],
    want: { dayOfWeek: 3, kickoffTime: "20:00" }, nulls: ["venue", "oneOffDate", "featureSelection"] },
  { name: "tr-no-time", teaches: "a time nobody gave stays null", known: { ...NAMED, stage: "details" },
    msgs: [["Erdal", "Perşembe günleri oynuyoruz"]],
    want: { dayOfWeek: 4 }, nulls: ["kickoffTime", "venue", "featureSelection"] },
  // ── several messages, combined ──
  { name: "en-merge", teaches: "different messages answer different fields", known: { ...NAMED },
    msgs: [["Ali", "7 a side"], ["Ben", "thursdays"], ["Ali", "8:30pm kick off"]],
    want: { playersPerSide: 7, dayOfWeek: 4, kickoffTime: "20:30" }, nulls: ["venue", "featureSelection"] },
  { name: "tr-merge", teaches: "the same in Turkish", known: { ...NAMED },
    msgs: [["Hasan", "5'e 5 oynuyoruz"], ["Mert", "pazar"], ["Hasan", "akşam 7'de"]],
    want: { playersPerSide: 5, dayOfWeek: 0, kickoffTime: "19:00" }, nulls: ["venue", "featureSelection"] },
  // ── the name ──
  { name: "en-name", teaches: "a stated club name", known: {},
    msgs: [["Olive", "we're the Thursday Ballers"]],
    want: { groupName: "Thursday Ballers" }, nulls: ["venue", "dayOfWeek", "kickoffTime", "featureSelection"], minConfidence: 0.5 },
  { name: "tr-name", teaches: "a stated club name in Turkish", known: {},
    msgs: [["Erdal", "Takımın adı Cuma Kartalları"]],
    want: { groupName: "Cuma Kartalları" }, nulls: ["venue", "kickoffTime", "featureSelection"], minConfidence: 0.5 },
  // ── how often, and a single game ──
  { name: "en-weekly", teaches: "every week is weekly", known: ALL_EVENT,
    msgs: [["Olive", "every week"]], want: { recurrence: "weekly" }, nulls: ["oneOffDate", "featureSelection"] },
  { name: "tr-weekly", teaches: "her hafta is weekly", known: ALL_EVENT,
    msgs: [["Erdal", "her hafta"]], want: { recurrence: "weekly" }, nulls: ["oneOffDate", "featureSelection"] },
  { name: "en-oneoff-date", teaches: "a one-off with a date", known: ALL_EVENT,
    msgs: [["Olive", "just this once, Saturday 14 November"]], want: { recurrence: "oneoff", oneOffDate: "2026-11-14" } },
  { name: "tr-oneoff-date", teaches: "a one-off with a date, in Turkish", known: ALL_EVENT,
    msgs: [["Erdal", "tek seferlik, 14 Kasım cumartesi"]], want: { recurrence: "oneoff", oneOffDate: "2026-11-14" } },
  { name: "en-oneoff-relative", teaches: "a relative date needs today's date", known: ALL_EVENT,
    msgs: [["Olive", "it's a one-off this Saturday"]], want: { recurrence: "oneoff", oneOffDate: "2026-10-24" } },
  { name: "tr-oneoff-relative", teaches: "a relative date in Turkish", known: ALL_EVENT,
    msgs: [["Erdal", "bu cumartesi tek seferlik bir maç"]], want: { recurrence: "oneoff", oneOffDate: "2026-10-24" } },
  // ── a correction ──
  { name: "en-correction", teaches: "a corrected value replaces the collected one", known: { ...NAMED, playersPerSide: 7, dayOfWeek: 2 },
    msgs: [["Olive", "actually make it Thursdays"]], want: { dayOfWeek: 4 } },
  { name: "tr-correction", teaches: "a correction in Turkish", known: { ...NAMED, playersPerSide: 7, dayOfWeek: 2 },
    msgs: [["Erdal", "pardon, salı değil perşembe"]], want: { dayOfWeek: 4 } },
  // ── the feature pick ──
  { name: "en-everything", teaches: "everything is all eight keys", known: { ...ALL_EVENT, recurrence: "weekly", stage: "features" },
    msgs: [["Olive", "everything please"]], want: { featureSelection: ALL8 } },
  { name: "tr-hepsi", teaches: "hepsi is all eight keys", known: { ...ALL_EVENT, recurrence: "weekly", stage: "features" },
    msgs: [["Erdal", "hepsi olsun"]], want: { featureSelection: ALL8 } },
  { name: "en-except-payments", teaches: "everything except payments", known: { ...ALL_EVENT, recurrence: "weekly", stage: "features" },
    msgs: [["Olive", "everything except payments"]], want: { featureSelection: NOT_PAY } },
  { name: "tr-except-payments", teaches: "ödeme hariç hepsi", known: { ...ALL_EVENT, recurrence: "weekly", stage: "features" },
    msgs: [["Erdal", "ödeme hariç hepsi"]], want: { featureSelection: NOT_PAY } },
  { name: "en-named-features", teaches: "named features map to their keys", known: { ...ALL_EVENT, recurrence: "weekly", stage: "features" },
    msgs: [["Olive", "just Man of the Match and player ratings please"]], want: { featureSelection: ["momVoting", "playerRating"] } },
  { name: "tr-named-features", teaches: "named features in Turkish", known: { ...ALL_EVENT, recurrence: "weekly", stage: "features" },
    msgs: [["Erdal", "maçın adamı ve oyuncu puanları"]], want: { featureSelection: ["momVoting", "playerRating"] } },
  { name: "en-more-features", teaches: "attendance, teams, stats", known: { ...ALL_EVENT, recurrence: "weekly", stage: "features" },
    msgs: [["Olive", "attendance, teams and stats"]], want: { featureSelection: ["attendance", "teamBalancing", "statsQa"] } },
  { name: "tr-more-features", teaches: "yoklama, yedek, hatırlatma", known: { ...ALL_EVENT, recurrence: "weekly", stage: "features" },
    msgs: [["Erdal", "yoklama, yedek ve hatırlatma yeter"]], want: { featureSelection: ["attendance", "bench", "reminders"] } },
  { name: "en-features-not-asked", teaches: "no feature pick while the menu is not being answered", known: { ...NAMED, stage: "details" },
    msgs: [["Olive", "Thursday 8pm at Goals Sutton. We'll want MoM voting later"]],
    want: { dayOfWeek: 4, kickoffTime: "20:00" }, nulls: ["featureSelection"] },
  // ── chat that answers nothing ──
  { name: "en-chitchat", teaches: "chat answers nothing, low confidence", known: { ...NAMED },
    msgs: [["Ali", "haha nice one lads"], ["Ben", "see you all soon"]],
    nulls: ["venue", "dayOfWeek", "kickoffTime", "playersPerSide", "recurrence", "oneOffDate", "featureSelection"], maxConfidence: 0.49 },
  { name: "tr-chitchat", teaches: "the same in Turkish", known: { ...NAMED },
    msgs: [["Hasan", "tamam görüşürüz"], ["Mert", "eline sağlık abi"]],
    nulls: ["venue", "dayOfWeek", "kickoffTime", "playersPerSide", "recurrence", "oneOffDate", "featureSelection"], maxConfidence: 0.49 },
];

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && [...a].sort().join() === [...b].sort().join();
  if (typeof a === "string" && typeof b === "string") return a.trim().toLowerCase() === b.trim().toLowerCase();
  return a === b;
}

async function main() {
  const only = process.env.ONLY?.trim();
  const cases = only ? CASES.filter((c) => c.name === only) : CASES;
  const results: Array<Record<string, unknown>> = [];
  let pass = 0;
  for (const c of cases) {
    const before = calls.length;
    const known = { ...EMPTY, ...c.known };
    await extractSetupAnswers(known, c.msgs.map(([authorName, body]) => ({ authorName, body })), { model, now: NOW });
    const call = calls[before];
    const misses: string[] = [];
    let raw: Record<string, unknown> = {};
    if (!call || call.error) misses.push(`call failed: ${call?.error ?? "no call"}`);
    else {
      try {
        raw = extractJson(call.raw) as Record<string, unknown>;
      } catch (e) {
        misses.push(`not JSON: ${(e as Error).message}`);
      }
    }
    for (const [k, v] of Object.entries(c.want ?? {})) if (!same(raw[k], v)) misses.push(`${k}: want ${JSON.stringify(v)}, got ${JSON.stringify(raw[k])}`);
    for (const k of c.nulls ?? []) if (raw[k] != null) misses.push(`${k}: want null, got ${JSON.stringify(raw[k])}`);
    const conf = typeof raw.confidence === "number" ? raw.confidence : NaN;
    if (c.maxConfidence != null && !(conf <= c.maxConfidence)) misses.push(`confidence: want <= ${c.maxConfidence}, got ${raw.confidence}`);
    if (c.minConfidence != null && !(conf >= c.minConfidence)) misses.push(`confidence: want >= ${c.minConfidence}, got ${raw.confidence}`);
    if (misses.length === 0) pass++;
    console.log(`${misses.length === 0 ? "PASS" : "FAIL"} ${c.name.padEnd(22)} ${call ? `${call.inputTokens} in / ${call.outputTokens} out $${call.usd.toFixed(5)}` : ""}`);
    if (misses.length) console.log(`     ${misses.join("\n     ")}\n     raw: ${call?.raw}`);
    results.push({ name: c.name, teaches: c.teaches, raw: call?.raw, misses });
  }
  const out = process.env.OUT?.trim() || `/tmp/live-check-onboarding-extract-${TAG}-${Date.now()}.json`;
  fs.writeFileSync(out, JSON.stringify({ tag: TAG, pass, total: cases.length, calls: calls.length, usd: usd(), results }, null, 2));
  console.log(`\n${TAG}: ${pass}/${cases.length} pass. Model calls: ${calls.length}. Cost: $${usd().toFixed(4)}. Saved: ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
