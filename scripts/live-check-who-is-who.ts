/**
 * WHO IS WHO: THE PAID CHECK (2026-11-09, option B, Kemal).
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. Dev key only.
 *
 * Each case ONCE through the real extractor for its route (the one that
 * reads the message in production) and then the real who-is-who call
 * (`src/lib/pipeline/who-is-who.ts`) over the club's members, exactly as
 * the batches run it (`identifyFacts`), and finally the engine's resolver
 * (`resolvePerson`) on the pick. Two groups:
 *
 *   NEW         the cases option B is for: "David - Kemal's son" is not
 *               Davide; "habibi" is Habib; "Moham" is Mohammed; "Davdie"
 *               is Davide; two Davids is not a guess; "my brother Ali" is
 *               nobody. English and Turkish.
 *   REGRESSION  names the old code resolved by spelling, across every
 *               extractor that quotes a person (attendance, replacement,
 *               payments, teams, stats, Man of the Match, fee waiver), plus
 *               the near-miss the old code got wrong ("Sami" is not Samir).
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-who-is-who.ts
 *   MEASURE=1 ...   print each call's tokens and cost
 *   ONLY=<text> ... the cases whose text contains it
 *   MAX_USD=...     stop before spending more (default 1.00)
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { identifyFacts } from "../src/lib/pipeline/identify-batch.ts";
import { membersNamedIn, resolvePerson } from "../src/lib/pipeline/identity.ts";
import { modelPersonPicker } from "../src/lib/pipeline/who-is-who.ts";
import type { Member, Route } from "../src/lib/pipeline/types.ts";

const MAX_USD = Number(process.env.MAX_USD ?? 1.0);
spendDevApiKeyOrExit("the who-is-who live check");

let calls = 0;
let usd = 0;
const byLabel = new Map<string, { calls: number; usd: number }>();
const inner = anthropicModel();
const model: PipelineModel = {
  name: "metered",
  async complete(req) {
    if (usd >= MAX_USD) throw new Error(`stopped at $${MAX_USD}`);
    const r = await inner.complete(req);
    calls++;
    usd += r.costUsd ?? 0;
    const k = req.label.startsWith("extractor") ? "extractor" : req.label;
    const b = byLabel.get(k) ?? { calls: 0, usd: 0 };
    byLabel.set(k, { calls: b.calls + 1, usd: b.usd + (r.costUsd ?? 0) });
    if (process.env.MEASURE) {
      console.log(
        `[measure] ${req.label}: in ${r.usage.inputTokens} + cache read ${r.usage.cacheReadTokens} + cache write ${r.usage.cacheWriteTokens}, out ${r.usage.outputTokens}, $${(r.costUsd ?? 0).toFixed(5)}`,
      );
    }
    return r;
  },
};

const NOW = new Date("2026-11-09T17:30:00Z");
const m = (key: string, name: string, aliases: string[] = []): Member => ({ userId: `u-${key}`, name, aliases, isAdmin: false, hasPhone: true });

/** Vets MNF's real names (read-only lookup, 2026-11-09), plus the members
 *  the cases name. */
const CLUB: Member[] = [
  m("kemal", "Kemal"),
  m("davide", "Davide De Sousa", ["davide"]),
  m("stuart", "Stuart Belcher"),
  m("nabz", "Nabz", ["nabz", "smiler"]),
  m("shane", "Shane"),
  m("habib", "Habib Rahimi"),
  m("mohammed", "Mohammed Iqbal"),
  m("tom", "Tom Hughes"),
  m("glazers", "Glazers"),
  m("ah", "Abdul-Hafeez", ["ah"]),
  m("najib", "Najib"),
  m("mojib", "Mojib Jalali"),
  m("ehtisham", "Ehtisham Ul Haq"),
  m("c1", "C1"),
  m("c2", "C2"),
  m("amir", "Amir Shah"),
  m("adam", "Adam Clarke"),
  m("sait", "Sait Demir"),
  m("naim", "Naim Khan"),
  m("bilal", "Bilal Hussain"),
  m("samir", "Samir Khan"),
  m("aydin", "Aydin Celik"),
];
const TWO_DAVIDS: Member[] = [...CLUB.filter((x) => x.userId !== "u-davide"), m("david-a", "David Aksoy"), m("david-r", "David Russo")];

/** What the name must come to: a member's key, "none" (nobody in the
 *  club, or not looked up at all because the extractor read a relation),
 *  or "ask" (ambiguous: nothing written, the sender asked). */
type Want = string;
interface Case {
  group: "NEW" | "REGRESSION";
  text: string;
  from: string;
  route: Route;
  /** Each name the case is about, as the model may quote it (case-folded
   *  match on the quoted ref), and what it must come to. */
  want: Array<[string, Want]>;
  roster?: Member[];
  why: string;
}

const CASES: Case[] = [
  // ── NEW ────────────────────────────────────────────────────────────
  { group: "NEW", text: "David - Kemal's son, is on the bench", from: "Kemal", route: "other_att", want: [["david", "none"]], why: "THE INCIDENT: not Davide" },
  { group: "NEW", text: "David, Kemal'in oğlu, yedekte", from: "Kemal", route: "other_att", want: [["david", "none"]], why: "the incident, TR" },
  { group: "NEW", text: "habibi is in", from: "Shane", route: "other_att", want: [["habibi", "habib"]], why: "a nickname is the member" },
  { group: "NEW", text: "habibi bu hafta geliyor", from: "Shane", route: "other_att", want: [["habibi", "habib"]], why: "a nickname, TR" },
  { group: "NEW", text: "Moham can't make it", from: "Shane", route: "other_att", want: [["moham", "mohammed"]], why: "a shortening is the member" },
  { group: "NEW", text: "Moham gelemiyor", from: "Shane", route: "other_att", want: [["moham", "mohammed"]], why: "a shortening, TR" },
  { group: "NEW", text: "Davdie is out", from: "Shane", route: "other_att", want: [["davdie", "davide"]], why: "a typo is the member" },
  { group: "NEW", text: "Davdie bu hafta yok", from: "Shane", route: "other_att", want: [["davdie", "davide"]], why: "a typo, TR" },
  { group: "NEW", text: "David is in", from: "Shane", route: "other_att", roster: TWO_DAVIDS, want: [["david", "ask"]], why: "two Davids: no guess" },
  { group: "NEW", text: "David geliyor", from: "Shane", route: "other_att", roster: TWO_DAVIDS, want: [["david", "ask"]], why: "two Davids, TR" },
  { group: "NEW", text: "my brother Ali is coming", from: "Shane", route: "other_att", want: [["ali", "none"]], why: "no Ali in the club: a guest" },
  { group: "NEW", text: "kardeşim Ali de geliyor", from: "Shane", route: "other_att", want: [["ali", "none"]], why: "no Ali, TR" },
  // ── REGRESSION ─────────────────────────────────────────────────────
  { group: "REGRESSION", text: "@Match Time Tom OUT", from: "Kemal", route: "other_att", want: [["tom", "tom"]], why: "a first name" },
  { group: "REGRESSION", text: "Glazers OUT", from: "Kemal", route: "other_att", want: [["glazers", "glazers"]], why: "FNF HQ 2026-10-24: a name that is a word" },
  { group: "REGRESSION", text: "AH out", from: "Kemal", route: "other_att", want: [["ah", "ah"]], why: "the club's alias" },
  { group: "REGRESSION", text: "my dad Najib is also in", from: "Shane", route: "other_att", want: [["najib", "najib"]], why: "a member named with a relation" },
  { group: "REGRESSION", text: "Ul Haq is out this week", from: "Kemal", route: "other_att", want: [["ul haq", "ehtisham"]], why: "a surname" },
  { group: "REGRESSION", text: "@Match Time C1, C2 OUT", from: "Kemal", route: "other_att", want: [["c1", "c1"], ["c2", "c2"]], why: "names with digits" },
  { group: "REGRESSION", text: "Mojib is replacing Najib tonight", from: "Kemal", route: "other_att", want: [["mojib", "mojib"], ["najib", "najib"]], why: "a replacement" },
  { group: "REGRESSION", text: "Aydın bu hafta yok", from: "Kemal", route: "other_att", want: [["aydın", "aydin"]], why: "Turkish letters" },
  { group: "REGRESSION", text: "Sami is out", from: "Kemal", route: "other_att", want: [["sami", "none"]], why: "the old near miss: not Samir" },
  { group: "REGRESSION", text: "@Match Time Amir paid for 3: him, Adam and me", from: "Kemal", route: "admin_ops", want: [["amir", "amir"], ["adam", "adam"]], why: "a payment's payer and who it covers" },
  { group: "REGRESSION", text: "@Match Time make teams, put me and Sait on the same team", from: "Kemal", route: "balancer", want: [["sait", "sait"]], why: "a pairing" },
  { group: "REGRESSION", text: "@Match Time what's Sait's rating?", from: "Shane", route: "question", want: [["sait", "sait"]], why: "a stats question about a player" },
  { group: "REGRESSION", text: "Reds won 5-3, MoM Naim", from: "Kemal", route: "score", want: [["naim", "naim"]], why: "Man of the Match" },
  { group: "REGRESSION", text: "@Match Time Bilal washed the bibs, he's free this week", from: "Kemal", route: "admin_ops", want: [["bilal", "bilal"]], why: "a fee waiver" },
];

const fold = (s: string) => s.toLocaleLowerCase("tr").replace(/^@/, "").trim();

async function runCase(c: Case): Promise<{ ok: boolean; line: string }> {
  const roster = c.roster ?? CLUB;
  const sender = roster.find((x) => x.name.split(" ")[0] === c.from) ?? null;
  const ex = await extractForRoute(model, c.route, {
    id: "wa-1",
    body: c.text,
    authorName: c.from,
    tagged: /@Match Time/i.test(c.text),
    history: [],
    lastBotPost: null,
    members: membersNamedIn(c.text, roster),
    now: NOW,
  });
  const ided = await identifyFacts({
    picker: modelPersonPicker(model),
    roster,
    where: "the players' group",
    items: [{ id: "wa-1", body: c.text, author: c.from, senderUserId: sender?.userId ?? null, facts: ex.facts }],
  });
  const people = ided.people.get("wa-1");
  const asked = [...(people?.keys() ?? [])];
  const parts: string[] = [];
  let ok = true;
  for (const [name, want] of c.want) {
    const ref = asked.find((r) => fold(r) === fold(name) || fold(r).split(/\s+/).includes(fold(name)) || fold(r).endsWith(fold(name)));
    let got: string;
    if (!ref) got = "none"; // not looked up: the extractor read no named person by it
    else {
      const r = resolvePerson(ref, roster, people);
      got = r.kind === "resolved" ? r.member.userId.slice(2) : r.kind === "ambiguous" ? "ask" : "none";
    }
    const pass = got === want;
    ok &&= pass;
    parts.push(`${name}: ${got}${pass ? "" : ` (want ${want})`}`);
  }
  return { ok, line: `${ok ? "PASS" : "FAIL"}  [${c.group}] ${c.text}  ->  ${parts.join(", ")}  (asked: ${JSON.stringify(asked)}; ${c.why})` };
}

async function main() {
  const only = process.env.ONLY;
  let pass = 0;
  let fail = 0;
  for (const c of CASES.filter((x) => !only || x.text.includes(only))) {
    try {
      const r = await runCase(c);
      console.log(r.line);
      if (r.ok) pass++;
      else fail++;
    } catch (err) {
      console.log(`ERROR [${c.group}] ${c.text}: ${(err as Error).message}`);
      fail++;
      if (usd >= MAX_USD) break;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed. ${calls} model calls, $${usd.toFixed(4)}.`);
  for (const [k, v] of byLabel) console.log(`  ${k}: ${v.calls} calls, $${v.usd.toFixed(4)}`);
}

void main();
