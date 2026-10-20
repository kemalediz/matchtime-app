/**
 * ═══════════════════════════════════════════════════════════════════════
 * LIVE VALIDATION: the scheduled chase post, against the real model.
 *
 * Started 2026-09-06 for the at-risk call-off warning on the 17:00 chase;
 * widened 2026-10-20 to every chase kind, English and Turkish, when the
 * composer was rewritten so code renders the squad list and the model
 * writes only the opening line.
 *
 * A stubbed test proves the PROMPT changed. It cannot prove the model
 * writes a call-off warning when told to, or (the direction that matters)
 * never writes one when it wasn't. Each scenario's post is judged by code:
 *
 *   warning    a call-off warning exactly when the server says "at risk",
 *              and never "I will cancel", never blame;
 *   squad      every numbered row is a player of this squad, every
 *              confirmed and bench player is listed, in order;
 *   numbers    every number outside the list and the format-switch line
 *              is one the facts hold (counts, places open, kickoff time
 *              and date, days to go);
 *   switch     the server's format-switch line, verbatim, exactly when it
 *              applies (short, within 24h, viable), and no switch talk
 *              otherwise;
 *   style      no em or en dash, no send-time stamp, no time-of-day
 *              greeting, the right day word, Turkish written in Turkish.
 *
 * ── ZERO WRITES, AND ZERO READS ──────────────────────────────────────
 * There is no Prisma client in this file. The squad state is built in
 * memory and handed to `composeChaseFromMatch`, the exact function
 * `composeChaseText` calls once it has read the database.
 *
 * ── IT COSTS REAL MONEY ──────────────────────────────────────────────
 * Every compose is a real model call on ANTHROPIC_API_KEY_DEV, the
 * developer's key. It refuses to run without one. One pass is 12 calls.
 *
 * ── HOW TO RUN ───────────────────────────────────────────────────────
 *   DATABASE_URL=postgresql://none@127.0.0.1:1/none \
 *     node --env-file=.env ./node_modules/.bin/tsx scripts/chase-at-risk-live.ts
 *
 *   ARM=sonnet|haiku  the model the composer is called with (default: the
 *                     shipped one)
 *   RUNS=1            runs per scenario (default 1)
 *   ONLY=AT-RISK,TR-MORNING  run only these scenarios
 *   OUT=/path.json    write every post and verdict here
 *   FULL=1            print every post, not just the failures
 * ═══════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { ARMS, armModel } from "../e2e/helpers/arm-model.ts";
import { composeChaseFromMatch, type ChaseComposeMatch, type ChaseKind } from "../src/lib/message-analyzer.ts";
import { computeChaseRisk } from "../src/lib/chase-risk.ts";
import { buildFormatSwitchFacts } from "../src/lib/format-switch.ts";

const EN_NAMES = [
  "Ali Kaya", "Dan Moore", "Sam Price", "Joe Hart", "Tom Reed", "Ben Cole", "Luke Shaw",
  "Matt Fox", "Ravi Shah", "Owen Hale", "Nick Dunn", "Theo Lamb", "Will Ash", "Kai Ford",
  "Max Bell", "Leo Park",
];
const TR_NAMES = [
  "Emre Şahin", "Burak Öztürk", "Çağrı Yılmaz", "Oğuz Demir", "İlker Aydın", "Serkan Güneş",
  "Mert Koç", "Barış Çelik", "Uğur Kılıç", "Gökhan Ateş", "Tolga Erdoğan", "Kerem Uçar",
  "Hakan Doğru", "Sinan Akın", "Ferhat Işık", "Onur Tekin",
];

const H = 3_600_000;
/** Now, snapped down to the hour, so a synthetic kickoff reads like a real one. */
const REJUDGE = process.env.REJUDGE ? JSON.parse(fs.readFileSync(process.env.REJUDGE, "utf8")) : null;
/** The wall clock of the run (a re-judge reuses the original run's). */
const NOW = REJUDGE ? new Date(REJUDGE.summary.now) : new Date();

/** `days` from today at hh:mm in London: a kickoff the way clubs book them. */
function londonAt(days: number, hour: number, minute = 0): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(NOW.getTime() + days * 24 * H),
  );
  const probe = new Date(`${ymd}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  const londonHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(probe));
  return new Date(probe.getTime() - (londonHour - hour) * H);
}
/** Now plus `hours`, on the next half hour: the pre-kickoff kinds. */
const soon = (hours: number) => new Date(Math.ceil((NOW.getTime() + hours * H) / (H / 2)) * (H / 2));

interface Club {
  lang: "en" | "tr";
  /** The match's name for a kickoff: clubs name their games by the weekday. */
  activity: (kickoff: Date) => string;
  venue: string;
  names: string[];
}
const weekday = (d: Date, locale: string) => new Intl.DateTimeFormat(locale, { timeZone: "Europe/London", weekday: "long" }).format(d);
const EN: Club = { lang: "en", activity: (k) => `${weekday(k, "en-GB")} 7-a-side`, venue: "Sim Arena", names: EN_NAMES };
const TR: Club = { lang: "tr", activity: (k) => `${weekday(k, "tr-TR")} Halısaha`, venue: "Ataşehir Spor", names: TR_NAMES };

interface Scenario {
  id: string;
  what: string;
  club: Club;
  kind: ChaseKind;
  kickoff: Date;
  confirmed: number;
  bench?: number;
  maxPlayers?: number;
  alternatives?: Array<{ sportName: string; totalPlayers: number }>;
  /** What the SERVER decides. Asserted before any call. */
  expectAtRisk: boolean;
}

const FIVE = [{ sportName: "Football 5-a-side", totalPlayers: 10 }];
const SIX = [{ sportName: "Football 6-a-side", totalPlayers: 12 }];
const SCENARIOS: Scenario[] = [
  { id: "AT-RISK", what: "daily, 6/14, tomorrow 21:00, no viable smaller format", club: EN, kind: "daily-in-list", kickoff: londonAt(1, 21), confirmed: 6, alternatives: FIVE, expectAtRisk: true },
  { id: "HEALTHY", what: "daily, 6/14, in 4 days: same shortfall, too early to be at risk", club: EN, kind: "daily-in-list", kickoff: londonAt(4, 21), confirmed: 6, alternatives: FIVE, expectAtRisk: false },
  { id: "AT-RISK+SWITCH", what: "daily, 10/14, today 21:00, 5-a-side viable", club: EN, kind: "daily-in-list", kickoff: londonAt(0, 21), confirmed: 10, alternatives: FIVE, expectAtRisk: true },
  { id: "SWITCH-ONLY", what: "daily, 11/14, today 21:00, not at risk, 5-a-side viable", club: EN, kind: "daily-in-list", kickoff: londonAt(0, 21), confirmed: 11, alternatives: FIVE, expectAtRisk: false },
  { id: "BENCH", what: "daily, 13/14 with 2 on the bench, in 2 days", club: EN, kind: "daily-in-list", kickoff: londonAt(2, 20, 30), confirmed: 13, bench: 2, expectAtRisk: false },
  { id: "MORNING", what: "match-day morning, 12/14, kickoff 21:00 today", club: EN, kind: "match-day-morning", kickoff: londonAt(0, 21), confirmed: 12, expectAtRisk: false },
  { id: "PRE-KICKOFF", what: "3-4h before kickoff, 12/14", club: EN, kind: "chase-pre-kickoff", kickoff: soon(3.5), confirmed: 12, expectAtRisk: false },
  { id: "LAST-CALL", what: "about 2h before, 13/14, 6-a-side viable", club: EN, kind: "pre-kickoff-short", kickoff: soon(1.5), confirmed: 13, alternatives: SIX, expectAtRisk: false },
  { id: "TR-AT-RISK", what: "Turkish daily, 6/14, tomorrow 21:00", club: TR, kind: "daily-in-list", kickoff: londonAt(1, 21), confirmed: 6, expectAtRisk: true },
  { id: "TR-HEALTHY", what: "Turkish daily, 9/14 with 1 on the bench, in 4 days", club: TR, kind: "daily-in-list", kickoff: londonAt(4, 21), confirmed: 9, bench: 1, expectAtRisk: false },
  { id: "TR-MORNING", what: "Turkish match-day morning, 12/14, kickoff 21:00 today", club: TR, kind: "match-day-morning", kickoff: londonAt(0, 21), confirmed: 12, expectAtRisk: false },
  { id: "TR-LAST-CALL", what: "Turkish, about 2h before, 13/14, 6-a-side viable", club: TR, kind: "pre-kickoff-short", kickoff: soon(1.5), confirmed: 13, alternatives: SIX, expectAtRisk: false },
];

function matchFor(s: Scenario): ChaseComposeMatch {
  const bench = s.bench ?? 0;
  return {
    date: s.kickoff,
    status: "UPCOMING",
    maxPlayers: s.maxPlayers ?? 14,
    activity: { name: s.club.activity(s.kickoff), venue: s.club.venue },
    attendances: s.club.names.slice(0, s.confirmed + bench).map((name, i) => ({
      status: i < s.confirmed ? "CONFIRMED" : "BENCH",
      user: { id: `u${i}`, name, phoneNumber: "+447700900000" },
    })),
  };
}

/** MatchTime saying the match may not go ahead. */
const CALL_OFF = {
  en: /\b(?:call(?:ed|ing)?\s+(?:it|this|the\s+(?:match|game|fixture))\s+off|calling\s+it\s+off|(?:match|game|fixture)(?:'s| is| will be| gets)?\s+off\b|cancel\w*)/i,
  tr: /iptal|ertele/i,
};
/** MatchTime claiming IT is the one cancelling. The organisers cancel. */
const BOT_CANCELS = {
  en: /\bI(?:'ll| will| am| have to| may have to| might have to|'m)?\s+(?:going to\s+)?cancel\w*/i,
  tr: /iptal\s+ed(?:iyorum|eceğim|erim)/i,
};
const BLAME = /\b(?:let(?:ting)?\s+(?:us|the\s+lads|everyone)\s+down|no thanks to|blame|because\s+\w+\s+(?:bailed|dropped out|pulled out))\b/i;
const SEND_STAMP = /\b(?:\d{1,2}(?::\d\d)?\s?(?:am|pm)\s+update|\d{1,2}:\d\d\s+update|(?:quick\s+)?(?:morning|evening|afternoon)\s+update)\b/i;
const GREETING = {
  en: /\b(?:good\s+)?(?:morning|afternoon|evening)\s+(?:all|everyone|lads|guys|team)\b/i,
  tr: /günaydın|tünaydın|iyi akşamlar|iyi sabahlar/i,
};
const SWITCH_TALK = { en: /\bswitch(?:ing)?\s+to\b|\bsmaller\s+format\b/i, tr: /formatına|formata geç/i };
/** A handful of English words that cannot appear in a Turkish line (names
 *  stripped first). Letter boundaries, not `\b`: `\b` treats "ı" as a
 *  non-word character, so "say" would match inside "sayıya". */
const ENGLISH_IN_TR = /(?<!\p{L})(?:the|we|need|squad|more|players?|still|say|tonight|tomorrow|places?|spots?|kickoff|last call)(?!\p{L})/iu;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const WEEKDAYS = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Pazartesi|Salı|Çarşamba|Perşembe|Cuma|Cumartesi|Pazar)$/u;

function londonParts(d: Date): { hh: number; mm: number; day: number; ymd: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", day: "numeric", hour12: false })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return { hh: Number(p.hour), mm: Number(p.minute), day: Number(p.day), ymd };
}

interface Verdict {
  ok: boolean;
  problems: string[];
  warned: boolean;
  leadChars: number;
}

function judge(s: Scenario, text: string, proposal: string | null, switchExpected: boolean): Verdict {
  const lang = s.club.lang;
  const problems: string[] = [];
  const m = matchFor(s);
  const confirmed = m.attendances.filter((a) => a.status === "CONFIRMED").map((a) => a.user.name!);
  const bench = m.attendances.filter((a) => a.status === "BENCH").map((a) => a.user.name!);
  const need = Math.max(0, m.maxPlayers - confirmed.length);

  const lines = text.split("\n");
  const firstRow = lines.findIndex((l) => NUMBERED.test(l));
  // The lead: everything above the list's header (or the whole post).
  const leadEnd = firstRow > 0 ? firstRow - 1 : firstRow === 0 ? 0 : lines.length;
  const lead = lines.slice(0, leadEnd).join("\n").replace(proposal ?? "\u0000", "").trim();

  // warning
  const warned = CALL_OFF[lang].test(lead);
  if (warned !== s.expectAtRisk) problems.push(s.expectAtRisk ? "no call-off warning although at risk" : "call-off warning although not at risk");
  if (BOT_CANCELS[lang].test(text)) problems.push("MatchTime says it will cancel");
  if (BLAME.test(text)) problems.push("blames someone");

  // squad
  const rows = lines.map((l) => NUMBERED.exec(l)).filter((r): r is RegExpExecArray => r !== null);
  const listed = rows.map((r) => r[2].trim()).filter((n) => !/^🥁/.test(n));
  const want = [...confirmed, ...bench];
  const missing = want.filter((n) => !listed.includes(n));
  const strangers = listed.filter((n) => !want.includes(n));
  if (missing.length) problems.push(`not listed: ${missing.join(", ")}`);
  if (strangers.length) problems.push(`listed but not in the squad: ${strangers.join(", ")}`);
  if (listed.slice(0, confirmed.length).join("|") !== confirmed.join("|")) problems.push("confirmed players out of order");
  for (const r of text.matchAll(/(\d+)\s*\/\s*(\d+)/g)) {
    if (Number(r[1]) !== confirmed.length || Number(r[2]) !== m.maxPlayers) problems.push(`count ${r[0]} is not ${confirmed.length}/${m.maxPlayers}`);
  }

  // numbers (outside the list rows and the code's switch line)
  const k = londonParts(s.kickoff);
  const daysOut = Math.round((Date.parse(k.ymd) - Date.parse(londonParts(NOW).ymd)) / 86_400_000);
  const allowed = new Set<number>([confirmed.length, m.maxPlayers, need, bench.length, k.hh, k.mm, k.day, daysOut]);
  const activity = m.activity.name;
  for (const src of [activity, s.club.venue]) for (const d of src.match(/\d+/g) ?? []) allowed.add(Number(d));
  const prose = lines
    .filter((l) => !NUMBERED.test(l))
    .join("\n")
    .replace(proposal ?? "\u0000", "")
    .replace(/\*?[^\n*]{1,40}\(\d+\s*\/\s*\d+\):\*?/g, "") // the list header carries the count (checked above)
    .replace(/\*?[^\n*]{1,40}\(\d+\):\*?/g, ""); // the bench header carries the bench count
  for (const d of prose.match(/\d+/g) ?? []) if (!allowed.has(Number(d))) problems.push(`number ${d} is not in the facts`);

  // switch
  if (switchExpected && proposal && !text.includes(proposal)) problems.push("format-switch line missing or reworded");
  if (!switchExpected && SWITCH_TALK[lang].test(text)) problems.push("talks about a format switch that does not apply");

  // the match's name: kept as given, or left out, never renamed
  const [first, ...restWords] = activity.split(" ");
  const rest = restWords.join(" ");
  for (const r of lead.matchAll(new RegExp(`(\\p{L}+)\\*?\\s+\\*?${rest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gu"))) {
    if (WEEKDAYS.test(r[1]) && r[1] !== first) problems.push(`renames the match: "${r[0]}"`);
  }
  if (lang === "tr" && /Halı Saha/.test(lead)) problems.push('renames the match: "Halı Saha"');

  // style
  if (/[—–]/.test(text)) problems.push("em or en dash");
  if (SEND_STAMP.test(text)) problems.push("send-time stamp");
  if (GREETING[lang].test(text)) problems.push("time-of-day greeting");
  const today = londonParts(NOW).ymd;
  const tomorrow = londonParts(new Date(NOW.getTime() + 86_400_000)).ymd;
  if (lang === "en") {
    if (k.ymd !== today && /\btonight\b|\bthis evening\b/i.test(lead)) problems.push("says tonight for another day");
    if (k.ymd !== tomorrow && /\btomorrow\b/i.test(lead)) problems.push("says tomorrow for another day");
  } else {
    if (k.ymd !== today && /(?<!\p{L})(?:bu akşam|bugün)/iu.test(lead)) problems.push("says bu akşam/bugün for another day");
    if (k.ymd !== tomorrow && /(?<!\p{L})yarın/iu.test(lead)) problems.push("says yarın for another day");
    let bare = lead;
    for (const n of [...want, activity, s.club.venue]) bare = bare.split(n).join("");
    if (ENGLISH_IN_TR.test(bare)) problems.push(`English in a Turkish line: ${ENGLISH_IN_TR.exec(bare)?.[0]}`);
  }
  return { ok: problems.length === 0, problems, warned, leadChars: lead.length };
}

interface Usage { inTok: number; outTok: number; cacheWrite: number; cacheRead: number; usd: number; model: string }

/** REJUDGE=<a run's OUT file>: score its saved posts again with this
 *  file's checks. No model call, no key needed. */
function rejudge(): void {
  const out = REJUDGE as { summary: Record<string, unknown>; results: Array<Record<string, unknown>> };
  let passed = 0;
  for (const r of out.results) {
    const s = SCENARIOS.find((x) => x.id === r.id)!;
    const match = matchFor(s);
    const confirmedNames = match.attendances.filter((a) => a.status === "CONFIRMED").map((a) => a.user.name ?? "?");
    const risk = computeChaseRisk({ kickoff: match.date, confirmedCount: confirmedNames.length, maxPlayers: match.maxPlayers, now: NOW });
    const proposal =
      buildFormatSwitchFacts({ confirmedNames, currentMaxPlayers: match.maxPlayers, alternatives: s.alternatives ?? [], lang: s.club.lang }).find((f) => f.proposal)
        ?.proposal ?? null;
    const v = r.text ? judge(s, r.text as string, proposal, proposal !== null && risk.need > 0 && risk.hoursToKickoff <= 24) : { ok: false, problems: ["no post (null)"], warned: false, leadChars: 0 };
    const kept = ((r.problems as string[] | undefined) ?? []).filter((p) => p.startsWith("model lead rejected"));
    const problems = [...v.problems, ...kept];
    r.problems = problems;
    r.ok = problems.length === 0;
    r.warned = v.warned;
    r.leadChars = v.leadChars;
    if (r.ok) passed++;
    console.log(`${r.ok ? "✅" : "❌"} ${r.id}${r.ok ? "" : ": " + (r.problems as string[]).join("; ")}`);
  }
  out.summary.passed = passed;
  fs.writeFileSync(process.env.REJUDGE!, JSON.stringify(out, null, 2));
  console.log(`${passed}/${out.results.length} posts behaved (re-judged, no calls).`);
}

async function run(): Promise<void> {
  if (REJUDGE) return rejudge();
  // Development model calls go on the DEVELOPER's key, before the first
  // model call. No fallback: see MDs/llm-spend-september-2026.md.
  spendDevApiKeyOrExit("scripts/chase-at-risk-live.ts");

  const runs = Math.max(1, Number(process.env.RUNS ?? 1));
  const printAll = process.env.FULL === "1";
  const arm = process.env.ARM ? ARMS[process.env.ARM] : undefined;
  if (process.env.ARM && !arm) throw new Error(`ARM must be one of ${Object.keys(ARMS).join(", ")}`);
  const metered = arm ? armModel(arm, 1) : null;
  const deps = metered ? { model: metered.model } : undefined;

  // Every real response logs one `[llm-usage]` line (pipeline/llm.ts);
  // it is read here so the old code path is metered the same way.
  const usages: Usage[] = [];
  const log = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    const line = String(args[0] ?? "");
    const u = /^\[llm-usage\] label=\S+ model=(\S+) in=(\d+) out=(\d+) cache_write=(\d+) cache_read=(\d+) usd=([\d.]+)/.exec(line);
    if (u) {
      usages.push({ model: u[1], inTok: +u[2], outTok: +u[3], cacheWrite: +u[4], cacheRead: +u[5], usd: +u[6] });
      return;
    }
    log(...args);
  };

  const only = process.env.ONLY?.split(",").map((s) => s.trim());
  const results: Array<Record<string, unknown>> = [];
  let failures = 0;
  for (const s of SCENARIOS) {
    if (only && !only.includes(s.id)) continue;
    const match = matchFor(s);
    const confirmedNames = match.attendances.filter((a) => a.status === "CONFIRMED").map((a) => a.user.name ?? "?");
    const risk = computeChaseRisk({ kickoff: match.date, confirmedCount: confirmedNames.length, maxPlayers: match.maxPlayers });
    log(`\n${"═".repeat(72)}\n${s.id}: ${s.what}\nserver verdict: atRisk=${risk.atRisk} (need ${risk.need}, ${risk.hoursToKickoff.toFixed(1)}h out)\n${"═".repeat(72)}`);
    if (risk.atRisk !== s.expectAtRisk) {
      log(`  ❌ the ARITHMETIC is wrong before a single call was made`);
      failures++;
      continue;
    }
    const proposal =
      buildFormatSwitchFacts({ confirmedNames, currentMaxPlayers: match.maxPlayers, alternatives: s.alternatives ?? [], lang: s.club.lang }).find((f) => f.proposal)
        ?.proposal ?? null;
    const switchExpected = proposal !== null && risk.need > 0 && risk.hoursToKickoff <= 24;

    for (let n = 0; n < runs; n++) {
      const before = usages.length;
      const rawBefore = metered?.calls.length ?? 0;
      const t0 = Date.now();
      const out = await composeChaseFromMatch(
        { kind: s.kind, match, alternatives: s.alternatives, lang: s.club.lang, logLabel: `live-check ${s.id}` },
        deps,
      );
      const ms = Date.now() - t0;
      const { text, fromModel } = out;
      const u = usages.slice(before);
      const usd = u.reduce((a, b) => a + b.usd, 0);
      const verdict = text
        ? judge(s, text, proposal, switchExpected)
        : { ok: false, problems: ["no post (null)"], warned: false, leadChars: 0 };
      if (text && !fromModel) verdict.problems.push("model lead rejected, fallback used"), (verdict.ok = false);
      if (!verdict.ok) failures++;
      // The model's own words, before code touched them (ARM runs only).
      const raw = metered?.calls.slice(rawBefore).map((c) => c.raw) ?? [];
      results.push({ id: s.id, lang: s.club.lang, kind: s.kind, ok: verdict.ok, problems: verdict.problems, warned: verdict.warned, leadChars: verdict.leadChars, ms, calls: u.length, usd, usage: u, raw, text });
      if (!verdict.ok || printAll) log(`\n── run ${n + 1}/${runs} ${verdict.ok ? "✅" : "❌ " + verdict.problems.join("; ")} (${ms} ms, $${usd.toFixed(5)})\n${text}${!fromModel && raw.length ? `\n   model wrote: ${raw.join(" | ")}` : ""}`);
    }
  }

  const calls = usages.length;
  const usd = usages.reduce((a, b) => a + b.usd, 0);
  const ms = results.map((r) => r.ms as number).sort((a, b) => a - b);
  const q = (p: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1)] : 0);
  const passed = results.filter((r) => r.ok).length;
  const summary = {
    arm: process.env.ARM ?? "shipped",
    now: NOW.toISOString(),
    models: [...new Set(usages.map((u) => u.model))],
    passed,
    total: results.length,
    calls,
    usd,
    costPerCall: calls ? usd / calls : 0,
    p50ms: q(0.5),
    p90ms: q(0.9),
    inputTokens: usages.reduce((a, b) => a + b.inTok, 0),
    outputTokens: usages.reduce((a, b) => a + b.outTok, 0),
    cacheWriteTokens: usages.reduce((a, b) => a + b.cacheWrite, 0),
    cacheReadTokens: usages.reduce((a, b) => a + b.cacheRead, 0),
  };
  log(`\n${"═".repeat(72)}\n${passed}/${results.length} posts behaved. ${calls} calls, $${usd.toFixed(5)}, p50 ${summary.p50ms} ms, p90 ${summary.p90ms} ms. Database writes: 0. Database reads: 0.`);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ summary, results }, null, 2));
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
