/**
 * LIVE dry run for the monthly reader (2026-10-29), on real Vets MNF
 * messages from the chat export (and Turkish equivalents of the notes).
 *
 * The unit and e2e tests stub the model: they prove what code does with a
 * reading. Only the real model can prove it reads "smiler 4 only" as 4
 * games, "Jon extra" as Jon's guest, a stale "List for 12 October" pasted
 * on the 19th as the 19th's list, and "November good for me" as a sign-up.
 * This asks it ONCE per case.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-monthly-reader.ts [--first]
 *
 * `--first` runs the first case only (measure one call before the rest).
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it), through the exact
 * production call (`readMonthlyMessage`, `MONTHLY_READER_CALL`, the
 * production prompt and checks). Touches no database and sends nothing.
 * Hard stop at MAX_USD.
 */
import { writeFileSync } from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { readMonthlyMessage, type MonthlyReading } from "../src/lib/monthly-reader.ts";
import type { MonthlyReaderContext, MonthlyReaderInput, ReaderMember } from "../src/lib/monthly-reader-prompt.ts";
import type { MonthlyListEntry } from "../src/lib/monthly-list.ts";

const MAX_USD = 0.6;

const NAMES: Array<[string, string[], boolean?]> = [
  ["Davide De Souza", ["Bossman"], true],
  ["Shane Walcountians", [], true],
  ["CJ Barber", ["Cj"]],
  ["Steff", []],
  ["Kemal Ediz", []],
  ["Oumesh Sauba", []],
  ["Jordan Daniels", ["YorDan", "Dan"]],
  ["Andrew", []],
  ["Steve", []],
  ["Sidney", ["Sydney"]],
  ["Sam Miles", ["Smiler"]],
  ["Ben", []],
  ["Ollie", []],
  ["Harry Sutton", []],
  ["David Ediz", []],
  ["Serg", []],
  ["Jon", []],
  ["Rory", []],
  ["Lucas", []],
  ["Dean", []],
  ["Craig", []],
  ["Erdal Yilmaz", []],
  ["Burak", []],
  ["Volkan", []],
  ["Emre", []],
];
const MEMBERS: ReaderMember[] = NAMES.map(([name, aliases, organiser], i) => ({
  ref: `p${i + 1}`,
  userId: `u-${name.split(" ")[0].toLowerCase()}`,
  name,
  aliases,
  organiser: !!organiser,
}));
const id = (first: string) => `u-${first.toLowerCase()}`;

const NOV_OPEN = `  November 2026 (month 11): sign-up open. 5 games: Mon 2 Nov, Mon 9 Nov, Mon 16 Nov, Mon 23 Nov, Mon 30 Nov; 5 still to play.
  Its list as MatchTime has it:
    📋 List for November (5 Mondays: 2, 9, 16, 23, 30)
    1. Davide De Souza
    2. Steff
    3. Jordan Daniels
    4. Shane Walcountians
    5. CJ Barber
    6. Steve`;
const NOV_RUNNING = `  November 2026 (month 11): under way. 5 games: Mon 2 Nov (played), Mon 9 Nov (played), Mon 16 Nov, Mon 23 Nov, Mon 30 Nov; 3 still to play.
  Its list as MatchTime has it:
    📋 List for November (5 Mondays: 2, 9, 16, 23, 30)
    1. Davide De Souza
    2. Steff
    3. Jordan Daniels
    4. Shane Walcountians
    5. CJ Barber
    6. Steve
    7. Sam Miles (4 games)
    8. Craig (4 games)
    9. Ben
    10. Kemal Ediz
    11. Jon`;
const OCT_RUNNING = `  October 2026 (month 10): under way. 4 games: Mon 5 Oct (played), Mon 12 Oct (played), Mon 19 Oct, Mon 26 Oct; 2 still to play.`;

const ctx = (months: string[], week: MonthlyReaderContext["week"]): MonthlyReaderContext => ({ orgId: "org-vets-dry", members: MEMBERS, months, week });
const OCT19 = ctx([OCT_RUNNING, NOV_OPEN.replace("sign-up open", "sign-up not open yet")], {
  game: "Mon 19 Oct 2026, 20:30",
  text: "📋 List for October: Mon 19 Oct, 20:30\n1. Davide De Souza\n2. Shane Walcountians\n3. CJ Barber\n4. Steff\n5. Kemal Ediz\n6.\n7. Jordan Daniels\n9. Steve\n10. Dean\n11. Sam Miles\n12. Ben\n\nPaid but can't play\n1. Serg",
});
const OCT5 = ctx([OCT_RUNNING.replace(/\(played\)/g, "").replace("2 still", "4 still")], {
  game: "Mon 5 Oct 2026, 20:30",
  text: "📋 List for October: Mon 5 Oct, 20:30\n1. Davide De Souza\n2. Shane Walcountians\n3. CJ Barber\n4. Steff",
});
const NOV_SIGNUP = ctx([NOV_OPEN], { game: "Mon 2 Nov 2026, 20:30", text: "📋 List for November: Mon 2 Nov, 20:30\n(sign-up still open)" });
const NOV_WEEK3 = ctx([NOV_RUNNING], { game: "Mon 16 Nov 2026, 20:30", text: "📋 List for November: Mon 16 Nov, 20:30\n1. Davide De Souza\n2. Steff\n3. Jordan Daniels" });

const OCT_LIST = `List for October:

1.⁠ ⁠Davide (Bossman)
2.⁠ ⁠⁠Shane (Paid £22.50)
3.⁠ ⁠⁠CJ (Paid £22.50)
4.⁠ ⁠Steff (paid pensioners rate)
 5. Kemal (Paid 30)
 6. ⁠Oumesh (PAYG)
 7. YorDan😁 (paid 22.50)
 8. Andrew (PAYG 5th only)
 9. ⁠Steve (paid £22.50)
10.⁠ ⁠Sydney PAYG
11.⁠ ⁠⁠Smiler paid
12.⁠ ⁠⁠Ben (paid)
13.⁠ ⁠⁠Ollie (PAYG)
14.⁠ ⁠Harry (PAYG)
15. David (PAYG)
16. ⁠Luca

Paid but can't play
 1.⁠ ⁠Serg
 2.⁠ ⁠⁠Jon
 3.⁠ ⁠⁠Rory
 4.⁠ ⁠Lucas
 5.⁠ ⁠⁠⁠Dean`;

const STALE = `List for 12 October:

1.⁠ ⁠Davide
2.⁠ ⁠⁠Shane (Paid £22.50)
3.⁠ ⁠⁠CJ (Paid £22.50)
4.⁠ ⁠Steff (paid pensioners rate)
 5. Kemal (Paid 30)
 6. ⁠
 7. YorDan😁 (paid 22.50)
 8. Andrew (PAYG 5th only)
 9. ⁠Steve (paid £22.50)
10. ⁠Dean (paid £22.50)
11. ⁠Smiler paid
12. ⁠Ben (paid)
13. ⁠Jon
14. Lucas ( paid )

Paid but can't play
1. Serg`;

const NOV_HALF = `List for November
1. Davide
2. ⁠Steff
3. ⁠Dan
4. Shane
5. ⁠CJ
6. ⁠Steve
7. ⁠smiler 4 only
8. ⁠Craig 4 only
9. ⁠Ben
10. Kemal
11. ⁠Jon`;

type Check = (r: MonthlyReading) => string | null;
const slot = (r: MonthlyReading, name: RegExp): MonthlyListEntry | undefined =>
  r.kind === "list" ? [...r.list.slots, ...r.list.sections.cantPlay].find((e) => name.test(e.name)) : undefined;
const all = (...checks: Check[]): Check => (r) => checks.map((c) => c(r)).find((x) => x) ?? null;
const isList = (month: number, listOf?: "week" | "month", gameDay?: number | null): Check => (r) =>
  r.kind !== "list"
    ? `kind ${r.kind}`
    : r.list.month?.month !== month
      ? `month ${r.list.month?.month}`
      : listOf && r.listOf !== listOf
        ? `listOf ${r.listOf}`
        : gameDay !== undefined && r.gameDay !== gameDay
          ? `gameDay ${r.gameDay}`
          : null;
const line = (name: RegExp, want: (e: MonthlyListEntry) => boolean, what: string): Check => (r) => {
  const e = slot(r, name);
  return !e ? `no line ${name}` : want(e) ? null : `${name} ${what}: ${JSON.stringify({ ...e.marks, ...e.facts })}`;
};
const member = (name: RegExp, first: string) => line(name, (e) => e.facts?.memberId === id(first), `member ${first}`);
const signup = (choice: string, month: number, games: number | null): Check => (r) =>
  r.kind !== "signup" ? `kind ${r.kind}` : r.choice !== choice || r.month !== month || r.games !== games ? `got ${r.choice} ${r.month} games ${r.games}` : null;
const none: Check = (r) => (r.kind === "none" ? null : `kind ${r.kind}`);
const anyOf = (...checks: Check[]): Check => (r) => (checks.some((c) => c(r) === null) ? null : checks.map((c) => c(r)).join(" | "));

const from = (first: string) => {
  const m = MEMBERS.find((x) => x.userId === id(first))!;
  return { userId: m.userId, name: m.name, organiser: m.organiser };
};
const at = (iso: string) => new Date(iso);

interface Case {
  name: string;
  input: MonthlyReaderInput;
  ctx: MonthlyReaderContext;
  check: Check;
}
const C = (name: string, body: string, sender: string, c: MonthlyReaderContext, now: string, check: Check, history: MonthlyReaderInput["history"] = []): Case => ({
  name,
  input: { body, sender: from(sender), history, reply: null, now: at(now) },
  ctx: c,
  check,
});

const CASES: Case[] = [
  C("4 only (Nov sign-up, Smiler's own)", NOV_HALF.split("\n8.")[0], "Sam", NOV_SIGNUP, "2026-10-28T03:41:00Z", all(isList(11, "month"), member(/smiler/i, "Sam"), line(/smiler/i, (e) => e.facts?.games === 4, "games 4"), member(/^Dan/i, "Jordan"))),
  C("November half list (11 names)", NOV_HALF, "Jon", NOV_SIGNUP, "2026-10-28T20:04:00Z", all(isList(11, "month"), (r) => (r.kind === "list" && r.list.slots.filter((e) => e.name).length === 11 ? null : "not 11 names"), line(/Craig/, (e) => e.facts?.games === 4, "games 4"))),
  // In a month under way, week or month does not change what is done with
  // the list (both go to the week's reconcile), so only the month is checked.
  C("every October note style", OCT_LIST, "Kemal", OCT5, "2026-10-05T23:30:00Z", all(
    isList(10),
    member(/^Davide/, "Davide"),
    line(/Shane/, (e) => e.marks.paid && e.marks.paidAmountPence === 2250, "paid 2250"),
    line(/Steff/, (e) => e.marks.paid && e.marks.tier === "concession", "paid concession"),
    line(/Kemal/, (e) => e.marks.paid && e.marks.paidAmountPence === 3000, "paid 3000"),
    line(/Oumesh/, (e) => e.marks.payg, "payg"),
    line(/YorDan/i, (e) => e.name.trim().toLowerCase() === "yordan" && e.facts?.memberId === id("Jordan"), "clean name, Jordan"),
    line(/Andrew/, (e) => e.marks.payg && e.marks.paygDates.some((d) => d.day === 5), "payg 5th"),
    line(/Sydney/, (e) => e.marks.payg && e.facts?.memberId === id("Sidney"), "payg, Sidney"),
    line(/Smiler/i, (e) => e.marks.paid && e.facts?.memberId === id("Sam"), "paid, Sam"),
    line(/Luca$/, (e) => !!e.facts?.guest && e.facts.memberId === null, "guest, not Lucas"),
    (r) => (r.kind === "list" && r.list.sections.cantPlay.map((e) => e.name.trim()).join(",") === "Serg,Jon,Rory,Lucas,Dean" ? null : "can't play section"),
  )),
  C("a blank line and a name moved to can't play", OCT_LIST.replace("3.⁠ ⁠⁠CJ (Paid £22.50)", "3.⁠ ⁠⁠").replace(" 5.⁠ ⁠⁠⁠Dean", " 5.⁠ ⁠⁠⁠Dean\n  6. Cj"), "CJ", OCT5, "2026-10-06T03:15:00Z", all(
    isList(10),
    (r) => (r.kind === "list" && r.list.slots.some((e) => e.slot === 3 && e.name === "") ? null : "slot 3 not blank"),
    (r) => (r.kind === "list" && r.list.sections.cantPlay.some((e) => e.facts?.memberId === id("CJ")) ? null : "CJ not in can't play"),
  ), [{ author: "CJ Barber", body: "Sorry I’m out for today I’m too rough" }]),
  C("stale 'List for 12 October' reused on the 19th", STALE, "Steve", OCT19, "2026-10-19T12:16:00Z", all(isList(10, "week", 19), line(/^Dean/, (e) => e.marks.paid, "paid")), [{ author: "Kemal Ediz", body: "List for today ?" }]),
  C("Jon extra (Jon's guest)", OCT_LIST.replace(/16\. \u2060Luca */, "16. Jon extra"), "Jon", OCT5, "2026-10-05T22:00:00Z", line(/Jon extra/i, (e) => e.slot === 16 && !!e.facts?.guest && e.facts.hostUserId === id("Jon"), "guest of Jon")),
  C("David (my son)", "List for October:\n1. Davide\n2. Shane\n3. Kemal\n4. David (my son)", "Kemal", ctx([OCT_RUNNING], OCT5.week), "2026-10-05T18:00:00Z", line(/David$|David \(/, (e) => (!!e.facts?.guest && e.facts.hostUserId === id("Kemal")) || e.facts?.memberId === id("David"), "Kemal's son")),
  C("November sign-up, just started", "List for November \n1. Davide \n2.", "Davide", NOV_SIGNUP, "2026-10-27T20:18:00Z", all(isList(11, "month"), (r) => (r.kind === "list" && r.list.slots.length === 2 && r.list.slots[1].name === "" ? null : "two lines, one blank"))),
  C("late joiner pastes the month's list in week 3", NOV_HALF + "\n12. Oumesh", "Oumesh", NOV_WEEK3, "2026-11-10T12:00:00Z", all(isList(11, "month"), member(/Oumesh/, "Oumesh")), [
    { author: "Davide De Souza", body: "Welcome Oumesh , please add your name if you are available to play November" },
    { author: "Davide De Souza", body: "If u can’t do all five pay for as many as you gonna do" },
  ]),
  C("November good for me", "November good for me", "Ben", NOV_SIGNUP, "2026-10-27T20:16:00Z", signup("in", 11, null)),
  C("except the last weekend", "I should be good for November except the last weekend", "Steve", NOV_SIGNUP, "2026-10-27T04:33:00Z", signup("in", 11, 4)),
  C("most weeks in November", "I can play most weeks in November", "Rory", NOV_SIGNUP, "2026-10-27T10:00:00Z", anyOf(signup("in", 11, null), signup("in", 11, 4), signup("payg", 11, null))),
  C("conditional maybe", "I am available in November, as long as my knee gets better 🤞", "Dean", NOV_SIGNUP, "2026-10-27T02:56:00Z", anyOf(none, signup("in", 11, null))),
  C("not a sign-up: are we off tonight", "Are we off for tonight?", "Ben", OCT19, "2026-10-27T03:28:00Z", none),
  C("not a sign-up: out for today", "Sorry I’m out for today I’m too rough", "CJ", OCT5, "2026-10-06T03:15:00Z", none),
  C("not a list: plain IN", "IN", "Andrew", OCT19, "2026-10-18T18:00:00Z", none),
  C("paid with an amount (Nov)", NOV_HALF.replace("10. Kemal", "10. Kemal (paid £37.50)"), "Kemal", NOV_SIGNUP, "2026-10-29T10:00:00Z", line(/Kemal/, (e) => e.marks.paid && e.marks.paidAmountPence === 3750, "paid 3750")),
  // ── Turkish equivalents ──
  C("TR: sadece 3 hafta", "Kasım listesi\n1. Davide\n2. Steff\n3. Erdal sadece 3 hafta", "Erdal", NOV_SIGNUP, "2026-10-28T10:00:00Z", all(isList(11, "month"), line(/Erdal/, (e) => e.facts?.games === 3 && e.facts.memberId === id("Erdal"), "games 3"))),
  C("TR: PAYG sadece 9'u", "Kasım listesi\n1. Davide\n2. Steff\n8. Burak (PAYG sadece 9'u)", "Burak", NOV_SIGNUP, "2026-10-28T10:00:00Z", line(/Burak/, (e) => e.marks.payg && e.marks.paygDates.some((d) => d.day === 9), "payg 9")),
  C("TR: ödedi emekli", "Kasım listesi\n1. Davide\n4. Steff (ödedi emekli)", "Steff", NOV_SIGNUP, "2026-10-28T10:00:00Z", line(/Steff/, (e) => e.marks.paid && e.marks.tier === "concession", "paid concession")),
  C("TR: ödedi gelemiyor bölümü", "Ekim listesi\n1. Davide\n2. Shane\n\nÖdedi gelemiyor\n1. Volkan", "Volkan", OCT19, "2026-10-19T12:00:00Z", (r) => (r.kind === "list" && r.list.sections.cantPlay.some((e) => e.facts?.memberId === id("Volkan")) ? null : "Volkan not in can't play")),
  C("TR: misafir (Emre'nin oğlu)", "Ekim listesi\n1. Davide\n2. Shane\n3. Emre\n4. Emre'nin oğlu Can", "Emre", OCT19, "2026-10-19T12:00:00Z", line(/Can/, (e) => !!e.facts?.guest && e.facts.hostUserId === id("Emre"), "Emre's guest")),
  C("TR: Kasım bana uyar", "Kasım bana uyar", "Burak", NOV_SIGNUP, "2026-10-27T12:00:00Z", signup("in", 11, null)),
  C("TR: son hafta hariç", "Kasım varım son hafta hariç", "Volkan", NOV_SIGNUP, "2026-10-27T12:00:00Z", signup("in", 11, 4)),
];

async function main() {
  const first = process.argv.includes("--first");
  const inner = anthropicModel({ apiKey: spendDevApiKeyOrExit("dryrun-monthly-reader") });
  let calls = 0;
  let usd = 0;
  let lastRaw = "";
  const model: PipelineModel = {
    name: "metered",
    complete: async (req) => {
      if (usd >= MAX_USD) throw new Error(`cost cap $${MAX_USD} reached after ${calls} calls`);
      const r = await inner.complete(req);
      calls++;
      usd += r.costUsd ?? 0.01;
      lastRaw = r.text;
      console.log(`   usage in=${r.usage.inputTokens} out=${r.usage.outputTokens} cache_w=${r.usage.cacheWriteTokens} cache_r=${r.usage.cacheReadTokens} usd=${(r.costUsd ?? 0).toFixed(5)} ms=${r.ms}`);
      return r;
    },
  };
  const results: Array<{ name: string; ok: boolean; why: string | null; raw: string }> = [];
  for (const c of first ? CASES.slice(0, 1) : CASES) {
    lastRaw = "";
    const got = await readMonthlyMessage(c.input, c.ctx, { model });
    const why = c.check(got);
    results.push({ name: c.name, ok: why === null, why, raw: lastRaw });
    console.log(`${why === null ? "PASS" : "FAIL"} ${c.name}${why ? `: ${why}` : ""}`);
  }
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} as expected. ${calls} live calls, cost ≈ $${usd.toFixed(4)}`);
  const out = process.env.DRYRUN_OUT;
  if (out) writeFileSync(out, JSON.stringify({ calls, usd, results }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
