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
import { factRefs } from "../src/lib/pipeline/identify-batch.ts";
import { membersNamedIn } from "../src/lib/pipeline/identity.ts";
import { modelPersonPicker, type PersonPick } from "../src/lib/pipeline/who-is-who.ts";
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
/** A member called David who is not Kemal's family, beside Kemal Ediz. */
const DAVID_AKSOY: Member[] = [...CLUB.filter((x) => x.userId !== "u-davide" && x.userId !== "u-kemal"), m("kemal", "Kemal Ediz"), m("david-a", "David Aksoy")];
/** Turkish names for the case endings. */
const TURKISH: Member[] = [...CLUB, m("ali", "Ali Kaya"), m("mehmet", "Mehmet Yilmaz"), m("can", "Can Demir")];
/** A former member, marked so. */
const WITH_FORMER: Member[] = [...CLUB, m("oldham", "Oldham Jones")];
/** Lookalike names (round 3): Emrah and Ali Kaya, no Emre, no Alim. */
const LOOKALIKES: Member[] = [...TURKISH, m("emrah", "Emrah Kaya")];
/** A member the club knows by first name only. */
const TARIQ: Member[] = [...CLUB, m("tariq", "Tariq")];

/** What the name must come to: a member's key, "none" (nobody in the
 *  club, or not looked up at all because the extractor read a relation),
 *  or "ask" (ambiguous: nothing written, the sender asked). */
type Want = string;
interface Case {
  group: "NEW" | "REGRESSION";
  text: string;
  from: string;
  /** "sender": the WhatsApp name of a phoneless sender (`resolveSenders`). */
  route: Route | "sender";
  /** Keys of members marked (former). */
  former?: string[];
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
  // ── REVIEW OF #574: the new prompt rulings ─────────────────────────
  { group: "NEW", text: "David - Kemal's son, is on the bench", from: "Kemal", route: "other_att", roster: DAVID_AKSOY, want: [["david", "ask"]], why: "OUTSIDER vs a same-name member: Kemal's son would be an Ediz, the member is an Aksoy" },
  { group: "NEW", text: "David, Kemal'in oğlu, yedekte", from: "Kemal", route: "other_att", roster: DAVID_AKSOY, want: [["david", "ask"]], why: "the same, TR" },
  { group: "NEW", text: "@Match Time Ali'yi kadroya ekle", from: "Kemal", route: "other_att", roster: TURKISH, want: [["ali", "ali"]], why: "Turkish accusative" },
  { group: "NEW", text: "Mehmet'in yerine Can geliyor", from: "Kemal", route: "other_att", roster: TURKISH, want: [["mehmet", "mehmet"], ["can", "can"]], why: "Turkish genitive, a replacement" },
  { group: "NEW", text: "@Match Time Aydın'ı çıkar", from: "Kemal", route: "other_att", roster: TURKISH, want: [["aydın", "aydin"]], why: "Turkish accusative with ı" },
  { group: "NEW", text: "Oldham's back tonight, he's in", from: "Kemal", route: "other_att", roster: WITH_FORMER, former: ["oldham"], want: [["oldham", "oldham"]], why: "a FORMER member named again" },
  // ── ROUND 3: a sender's own WhatsApp name (strict), and lookalikes ──
  { group: "NEW", text: "I'm out tonight", from: "Kemal Ediz", route: "sender", roster: DAVID_AKSOY, want: [["kemal ediz", "kemal"]], why: "a WhatsApp name that is a member's FULL name is the member" },
  { group: "NEW", text: "I'm out tonight", from: "Kemal Ediz", route: "sender", want: [["kemal ediz", "ask"]], why: "B3c: first name plus a surname the club does not have (member 'Kemal'): not sure" },
  { group: "NEW", text: "IN", from: "Smiler", route: "sender", want: [["smiler", "nabz"]], why: "a WhatsApp name that is a listed nickname is the member" },
  { group: "NEW", text: "IN", from: "Davdie", route: "sender", want: [["davdie", "ask"]], why: "B3c: a misspelt WhatsApp name is not sure (a typo in a message would be)" },
  { group: "NEW", text: "bu hafta yokum", from: "Tariq Shah", route: "sender", roster: TARIQ, want: [["tariq shah", "ask"]], why: "B3c: WhatsApp 'Tariq Shah', member 'Tariq': not sure (TR)" },
  { group: "NEW", text: "Tariq Shah's in", from: "Shane", route: "other_att", roster: TARIQ, want: [["tariq shah", "tariq"]], why: "the same words typed in a message ARE the member" },
  { group: "NEW", text: "Emre is out", from: "Kemal", route: "other_att", roster: LOOKALIKES, want: [["emre", "none"]], why: "lookalike: Emre is not Emrah" },
  { group: "NEW", text: "Emre bu hafta yok", from: "Kemal", route: "other_att", roster: LOOKALIKES, want: [["emre", "none"]], why: "lookalike, TR" },
  { group: "NEW", text: "Alim's in", from: "Kemal", route: "other_att", roster: LOOKALIKES, want: [["alim", "none"]], why: "lookalike: Alim is not Ali" },
  { group: "NEW", text: "Alim geliyor", from: "Kemal", route: "other_att", roster: LOOKALIKES, want: [["alim", "none"]], why: "lookalike, TR" },
  { group: "NEW", text: "I'm out", from: "David", route: "sender", want: [["david", "ask"]], why: "a phoneless WhatsApp 'David' is never Davide; strict (B3c): not sure, an unknown sender, Davide untouched" },
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
  const who = roster.map((x) => ({ userId: x.userId, name: x.name, aliases: x.aliases ?? [], ...(c.former?.includes(x.userId.slice(2)) ? { former: true } : {}) }));
  let refs: string[];
  if (c.route === "sender") {
    refs = [c.from];
  } else {
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
    refs = factRefs(ex.facts);
  }
  const res = await modelPersonPicker(model)({
    roster: who,
    // A sender exactly as `resolveSenders` asks: the players' group, no
    // author, the name marked as a WhatsApp name.
    where: c.route === "sender" ? "the club's players' group" : "the players' group",
    messages: [
      c.route === "sender"
        ? { id: "wa-1", body: c.text, author: null, refs, waNames: true as const }
        : { id: "wa-1", body: c.text, author: c.from, senderUserId: sender?.userId ?? null, refs },
    ],
  });
  const people = res.picks.get("wa-1") ?? new Map<string, PersonPick>();
  const asked = [...people.keys()];
  const parts: string[] = [];
  let ok = true;
  for (const [name, want] of c.want) {
    const ref = asked.find((r) => fold(r) === fold(name) || fold(r).split(/\s+/).includes(fold(name)) || fold(r).endsWith(fold(name)) || fold(r).startsWith(fold(name)));
    let got: string;
    if (!ref) got = "none"; // not looked up: the extractor read no named person by it
    else {
      const p = people.get(ref);
      got = p?.kind === "member" ? p.userId.slice(2) : p?.kind === "none" ? "none" : "ask";
    }
    const pass = got === want;
    ok &&= pass;
    parts.push(`${name}: ${got}${pass ? "" : ` (want ${want})`}`);
  }
  const detail = ok ? "" : `  picks: ${JSON.stringify([...people])}`;
  return { ok, line: `${ok ? "PASS" : "FAIL"}  [${c.group}] ${c.text}  ->  ${parts.join(", ")}  (asked: ${JSON.stringify(asked)}; ${c.why})${detail}` };
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
