/**
 * THE ROUTER'S NAMED REGRESSIONS — real messages from the real club,
 * each one with the OWNER it has to reach and the incident that put it
 * on the list. Pure: the cases and the grader. The live runner is
 * `router-regressions-live.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY A LIST OF MESSAGES AND NOT A UNIT TEST
 * ─────────────────────────────────────────────────────────────────────
 *
 * Every rule in `ROUTER_SYSTEM_PROMPT` is a claim about what a model
 * does with a sentence. Nothing in `src/` can check that claim: the
 * router's only seams are `parseRouterResponse` (which never sees the
 * prompt) and a stub (which answers whatever the test told it to). A
 * unit test that greps the prompt for the words of a rule proves the
 * words are there and says nothing about whether they work — and
 * `MDs/router-accuracy-2026-09-11.md` §3.1 is the reason that matters:
 * its FIRST candidate prompt scored higher overall while TRIPLING the
 * number of real attendance messages routed `none`, and the held-out
 * 220-message split did not catch it.
 *
 * So the rules are tested live, here, against messages that really
 * arrived. `router-regressions.test.ts` covers the parts that are
 * genuinely pure — that every case names a route this codebase can
 * parse, and that the grader counts what it says it counts.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE BAR IS NOT "MOSTLY RIGHT"
 * ─────────────────────────────────────────────────────────────────────
 *
 * `gate.ts`: *"Missing a saving costs pennies. Missing a player's IN
 * costs them their place."* Every `A` case below is a message that must
 * never route `none`, and that is the only assertion the runner fails
 * on. The `N` cases are reported and NOT failed on, because a benign
 * message that escapes the `none` bucket costs one extractor call and
 * nothing else — grading them as hard failures would put cost and a
 * player's slot on the same footing, which is the trade this whole
 * pipeline refuses to make.
 */
import { normaliseRoute } from "../../src/lib/pipeline/router";
import type { Route } from "../../src/lib/pipeline/types";

/** Who has to end up handling the message. `gate.ts` throws the route
 *  away at the boundary, so `self_att` vs `other_att` is not a
 *  distinction any owner can see. */
export type Owner = "A" | "Q" | "B" | "S" | "D" | "N";

export const OWNER_OF: Record<Route, Owner> = {
  self_att: "A",
  other_att: "A",
  offer: "A",
  unsure: "A",
  question: "Q",
  balancer: "B",
  score: "S",
  admin_ops: "D",
  none: "N",
};

export interface RegressionCase {
  /** Verbatim, as it arrived in the group. */
  body: string;
  /** Any one of these satisfies the case. */
  allow: Owner[];
  /** What went wrong, and when. */
  why: string;
  /**
   * True when this exact sentence also appears in `ROUTER_SYSTEM_PROMPT`
   * as a worked example. Such a case still earns its place — it fails
   * the moment somebody deletes the rule that carries it — but it is
   * NOT evidence that the prompt generalises, and the runner prints the
   * two groups separately so nobody reads it as such.
   */
  inPrompt?: true;
}

export const ROUTER_REGRESSIONS: RegressionCase[] = [
  // ── Broken by candidate v1, and the reason v2 has Rule 0 and 11a ────
  // §3.1: v1 scored 92.0% overall — higher than the prompt that shipped
  // — while routing NINE real attendance messages `none` against the
  // baseline's three. Its person-to-person rule was swallowing stated
  // commitments because they were addressed to a person.
  {
    body: "Talha is coming please add him",
    allow: ["A"],
    why: "v1 called it banter: addressed to the group about a third party. It adds a player.",
    inPrompt: true,
  },
  {
    body: "@Kemal Ediz my brother can play if needed",
    allow: ["A"],
    why: "v1 called it banter: an @mention of a person. It offers a guest.",
    inPrompt: true,
  },
  {
    body: "Add these 2 boys pl",
    allow: ["A"],
    why: "v1 called it banter. Two more players.",
    inPrompt: true,
  },
  {
    body: "@Ehtisham Ul Haq in sha Allah I’ll play",
    allow: ["A"],
    why: "v1 called it banter: addressed to a person. The sender states he is playing.",
    inPrompt: true,
  },
  {
    body: "+1 (289) 888-3645  Rashad my cousin to add if poss",
    allow: ["A"],
    why: "v1 called it banter: a phone number and a name. It adds a guest.",
    inPrompt: true,
  },

  // ── Broken by candidate v2, byte-identical on all three of its runs ──
  // Named in §3.1 as prompt gaps rather than sampling noise. v3's rules
  // 10 (the buried ask), 14 (a correction) and 15 (an instruction to an
  // admin) exist for these three, and the worked examples added with
  // them are PARAPHRASES — the sentences below are not in the prompt, so
  // this is a held-out test of the rules and not a lookup.
  {
    body: "very good lads, same quality and friendliness as ours, come on, one player please",
    allow: ["A"],
    why: "A chase wrapped in praise. Lost by the shipped prompt AND by candidate v2, 3 runs of 3.",
  },
  {
    body: "Oops, I messed it up, it should be Zair not Baki, sorry. Now I play for 2 people Ismail and Ozgur. Classic issues having 2 names.",
    allow: ["A"],
    why: "A correction of a registration plus a stand-in for two people. v2 read the apology as banter.",
  },
  {
    body: "@Kemal Ediz please switch to 7 a side and include Amir as 14th player",
    allow: ["A", "D"],
    why: "A format change AND a 14th player. v2 let rule 12 (talk about settings) swallow the place.",
  },

  // ── The shapes the baseline prompt loses, from §1.4 ─────────────────
  {
    body: "So if anyone wants to play then they can take the last spot",
    allow: ["A"],
    why: "Routed none by the shipped prompt in 3 of 3 runs. It is an open offer of a real slot.",
  },
  {
    body: "Lemme know if we need more to make it 14. I can find another",
    allow: ["A"],
    why: "Routed none by the shipped prompt in 1 of 3 runs. A contingent offer of a guest.",
    inPrompt: true,
  },
  {
    body: "@all we need more players old",
    allow: ["A"],
    why: "Routed none by the shipped prompt in 1 of 3 runs. A chase.",
  },
  {
    body: "Bench",
    allow: ["A"],
    why: "A real registration in this group; the deterministic floor does not match it (§1.8).",
    inPrompt: true,
  },

  // ── The `A → Q` class: asking the group for a player (rule 10) ──────
  // §1.3's second-order finding and the 2026-09-01 incident class: a
  // replacement request routed `question` never reaches the attendance
  // extractor, so its `sideRequests` fact is never produced, and
  // `answer-batch` then refuses the message for being untagged.
  {
    body: "Hi, is there anyone who can replace me in today's match?",
    allow: ["A"],
    why: "Rule 10. Routed `question` by the shipped prompt; nothing happens at all.",
  },
  {
    body: "anybody would be willing to replace me ? my ankle is still a bit sore",
    allow: ["A"],
    why: "Rule 10. A question mark does not make it a question.",
  },

  // ── Rule 11: members talking to each other, settling nothing ────────
  {
    body: "Are you available to play @Enayem ?",
    allow: ["N"],
    why: "Rule 11. One member asking another. Nobody is in or out yet.",
    inPrompt: true,
  },
  {
    body: "@Zeeshan they asked can anyone step in I said in you can check up the messages",
    allow: ["N"],
    why: "Rule 11. A member narrating a past exchange to another member.",
  },

  // ── Rule 12: admin_ops is an instruction ADDRESSED TO THE BOT ───────
  // §1.3 ranks `N → D` the largest confusion pair in the system, and it
  // is the one pointed at the two mass-DM doors.
  {
    body: "£8.6 per person to Elvin",
    allow: ["N"],
    why: "Rule 12. Money between members. Routed admin_ops by the shipped prompt.",
  },
  {
    body: "wait guys sorry by mistake I enabled the tracking of squad in Match Time",
    allow: ["N"],
    why: "Rule 12. Talk ABOUT the bot, and about something already done.",
    inPrompt: true,
  },

  // ── Rule 16: a score is OUR result, not the one on television ───────
  {
    body: "DRC 1 Portugal 1",
    allow: ["N"],
    why: "The single message behind `score` precision falling to 57.9% on candidate v2.",
  },
  {
    body: "10-10",
    allow: ["S"],
    why: "Our own result, bare. Rule 16 must not take this with it.",
    inPrompt: true,
  },
];

export interface RegressionOutcome {
  case: RegressionCase;
  /** One entry per repeat. */
  routes: Route[];
}

export interface RegressionReport {
  /** Cases whose owner must never be `none`, and how many runs lost one. */
  attendanceLost: Array<{ body: string; runs: number; routes: Route[] }>;
  /** Non-attendance cases that missed, reported and not failed on. */
  softMisses: Array<{ body: string; allow: Owner[]; routes: Route[] }>;
  totalCases: number;
  repeats: number;
  /** Case-runs whose owner was in `allow`. */
  satisfied: number;
  caseRuns: number;
}

export function summariseRegressions(outcomes: RegressionOutcome[]): RegressionReport {
  const attendanceLost: RegressionReport["attendanceLost"] = [];
  const softMisses: RegressionReport["softMisses"] = [];
  let satisfied = 0;
  let caseRuns = 0;
  let repeats = 0;
  for (const o of outcomes) {
    repeats = Math.max(repeats, o.routes.length);
    const owners = o.routes.map((r) => OWNER_OF[r]);
    caseRuns += o.routes.length;
    satisfied += owners.filter((w) => o.case.allow.includes(w)).length;
    if (o.case.allow.includes("A")) {
      const lost = owners.filter((w) => w === "N").length;
      if (lost > 0) attendanceLost.push({ body: o.case.body, runs: lost, routes: o.routes });
    } else if (owners.some((w) => !o.case.allow.includes(w))) {
      softMisses.push({ body: o.case.body, allow: o.case.allow, routes: o.routes });
    }
  }
  return { attendanceLost, softMisses, totalCases: outcomes.length, repeats, satisfied, caseRuns };
}

/** The one thing that fails a run: a message that adds or removes a
 *  player from this squad, called banter. */
export function regressionsPass(report: RegressionReport): boolean {
  return report.attendanceLost.length === 0;
}

export function renderRegressions(report: RegressionReport): string {
  const out: string[] = [];
  out.push(
    `${report.satisfied} of ${report.caseRuns} case-runs reached an allowed owner ` +
      `(${report.totalCases} cases × ${report.repeats} runs).`,
  );
  out.push("");
  if (report.attendanceLost.length === 0) {
    out.push(`ATTENDANCE LOST TO none: 0 of ${report.totalCases} cases. PASS.`);
  } else {
    out.push(`ATTENDANCE LOST TO none: ${report.attendanceLost.length} case(s). FAIL.`);
    for (const l of report.attendanceLost) {
      out.push(`  ${l.runs} of ${l.routes.length} runs · ${JSON.stringify(l.body.slice(0, 110))}`);
      out.push(`      routes: ${l.routes.join(", ")}`);
    }
  }
  out.push("");
  out.push(
    report.softMisses.length === 0
      ? `non-attendance cases: all clean.`
      : `non-attendance cases that missed (reported, NOT failed on — each costs one extractor call):`,
  );
  for (const m of report.softMisses) {
    out.push(
      `  want ${m.allow.join("|")} · got ${m.routes.join(", ")} · ` +
        JSON.stringify(m.body.slice(0, 90)),
    );
  }
  return out.join("\n");
}

/** Guard: a case naming a route this codebase cannot parse is a case
 *  that can never be satisfied. Used by the unit test. */
export function unparseableOwners(): string[] {
  const known = new Set<Owner>(["A", "Q", "B", "S", "D", "N"]);
  const bad: string[] = [];
  for (const c of ROUTER_REGRESSIONS) {
    for (const w of c.allow) if (!known.has(w)) bad.push(`${c.body} → ${w}`);
  }
  for (const r of Object.keys(OWNER_OF)) {
    if (normaliseRoute(r) !== r) bad.push(`OWNER_OF has an unparseable route "${r}"`);
  }
  return bad;
}
