/**
 * ONE A DAY, AND THE NEW THING FIRST.
 *
 * ── The complaint this file is the test for ──────────────────────────
 *
 * 2026-09-15, the owner:
 *
 *   "I keep getting so many emails and WhatsApp messages regarding the
 *    alerts. It should be composed to one a day."
 *
 * He was right, and the production numbers are worse than the sentence.
 * `ALERT_REPEAT_MS` was six hours, so the same alert re-fired about four
 * times a day, by email AND by WhatsApp DM. Sutton FC's
 * `BotHealth.lastAlertCodes` had read `["capability-degraded",
 * "sweep-stale"]` continuously, and `degradedCapabilities` had held the
 * same four strings since 2026-07-07. Between 2026-09-09 (the day the
 * alert shipped) and 2026-09-15 he received 24 emails and 15 WhatsApp
 * DMs, and exactly three of those 39 messages carried a sentence he had
 * not already read.
 *
 * One of the three is the whole argument. On 2026-09-14 at 09:00 the
 * alert carried:
 *
 *   🚨 Nothing from this group has been analysed for 40 hours, with a
 *      match in 35 hours.
 *
 * That is a live outage on the eve of a fixture, and it was the THIRD
 * line of the message, underneath two warnings that had been true since
 * July. A channel trained into noise is the August silence with extra
 * steps, which is the sentence `bot-health.ts` opens with.
 *
 * So the tests below pin two things, and the second matters more:
 *   1. an unchanged set of problems speaks once a day, at a predictable
 *      hour, and a genuinely new one still speaks the minute it appears;
 *   2. the message LEADS with what changed, and anything that has been
 *      true for days collapses to a single line underneath it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ALERT_MAX_SILENCE_MS,
  COLLAPSE_AFTER_MS,
  DAILY_DIGEST_HOUR,
  composeHealthAlert,
  labelForCode,
  planHealthAlert,
  trackFirstSeen,
  type HealthCode,
  type HealthFinding,
  type ResolvedFinding,
} from "../bot-health";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 2026-09-15 is BST, so London is UTC+1 all through this file. */
const NOON = new Date("2026-09-15T11:00:00.000Z"); // 12:00 London
/** The hour the digest is supposed to land on, as a UTC instant. */
const DIGEST_TIME = new Date("2026-09-15T07:00:00.000Z"); // 08:00 London

function finding(code: HealthCode, over: Partial<HealthFinding> = {}): HealthFinding {
  return {
    code,
    severity: "warning",
    label: labelForCode(code),
    headline: `${code} happened.`,
    detail: `What ${code} costs, and what to do about it.`,
    ...over,
  };
}

/** The two findings Sutton FC has carried since July. */
function sutton(now: Date): HealthFinding[] {
  const july = new Date("2026-07-07T15:08:13.683Z");
  return [
    finding("capability-degraded", { label: "4 bot capabilities", firstSeenAt: july }),
    finding("sweep-stale", { firstSeenAt: july }),
  ];
  void now;
}

const codesOf = (f: HealthFinding[]) => f.map((x) => x.code);

// ═══════════════════════════════════════════════════════════════════════
// 1. ONE A DAY
// ═══════════════════════════════════════════════════════════════════════

describe("planHealthAlert — an unchanged set speaks once a day", () => {
  it("produces exactly ONE alert across 24 hourly ticks, not four", () => {
    // The literal complaint, as a number. The cron is hourly
    // (`vercel.json`), so this walks a full day of ticks over a set of
    // problems that never changes and counts how many times the owner is
    // interrupted. Under the old six-hour `ALERT_REPEAT_MS` this was 4.
    const findings = sutton(NOON);
    let lastAlertAt = new Date("2026-09-14T07:00:00.000Z"); // yesterday's digest
    let lastAlertCodes = codesOf(findings);
    const fired: string[] = [];

    for (let i = 0; i < 24; i++) {
      const now = new Date(Date.UTC(2026, 8, 15, i, 0, 30));
      const plan = planHealthAlert({
        findings: sutton(now),
        resolved: [],
        lastAlertAt,
        lastAlertCodes,
        now,
      });
      if (plan.send) {
        fired.push(now.toISOString());
        lastAlertAt = now;
        lastAlertCodes = codesOf(findings);
      }
    }

    expect(fired).toHaveLength(1);
    // …and it lands at the hour a human can build a habit around, not 24
    // hours after whenever the last one happened to fire.
    expect(fired[0]).toBe("2026-09-15T07:00:30.000Z"); // 08:00 London
  });

  it("stays silent at every hour before the digest hour", () => {
    const findings = sutton(NOON);
    for (let h = 0; h < DAILY_DIGEST_HOUR; h++) {
      // London hour `h`, expressed in UTC (BST = UTC+1).
      const now = new Date(Date.UTC(2026, 8, 15, h - 1 < 0 ? 23 : h - 1, 0, 30));
      const plan = planHealthAlert({
        findings,
        resolved: [],
        lastAlertAt: new Date("2026-09-14T07:00:00.000Z"),
        lastAlertCodes: codesOf(findings),
        now,
      });
      if (h === 0) continue; // 00:00 London is the previous UTC day; skipped
      expect(plan.send, `London hour ${h} must be silent`).toBe(false);
    }
  });

  it("does not speak twice in one day just because the clock passed the hour", () => {
    const findings = sutton(NOON);
    const plan = planHealthAlert({
      findings,
      resolved: [],
      lastAlertAt: DIGEST_TIME, // this morning's digest already went
      lastAlertCodes: codesOf(findings),
      now: NOON,
    });
    expect(plan.send).toBe(false);
    expect(plan.reason).toContain("today");
  });

  it("catches up if the digest tick was missed entirely", () => {
    // Vercel does not promise a scheduled invocation, and a deploy can
    // eat one. Without this, a missed 08:00 would push the next word to
    // 08:00 TOMORROW, which is 48 hours of silence on something broken.
    const findings = sutton(NOON);
    const dawn = new Date("2026-09-15T05:00:30.000Z"); // 06:00 London, before the digest hour
    const plan = planHealthAlert({
      findings,
      resolved: [],
      lastAlertAt: new Date(dawn.getTime() - ALERT_MAX_SILENCE_MS - MINUTE),
      lastAlertCodes: codesOf(findings),
      now: dawn,
    });
    expect(plan.send).toBe(true);
    expect(plan.reason).toContain("catching up");
  });

  it("speaks the first time, whatever the hour", () => {
    const plan = planHealthAlert({
      findings: sutton(NOON),
      resolved: [],
      lastAlertAt: null,
      lastAlertCodes: [],
      now: new Date("2026-09-15T02:00:00.000Z"), // 03:00 London
    });
    expect(plan.send).toBe(true);
    expect(plan.reason).toContain("first");
  });
});

describe("planHealthAlert — a NEW failure still breaks through at once", () => {
  it("alerts immediately, without waiting for tomorrow's digest", () => {
    // This is 2026-09-14 09:00 in production: `inbound-silent` landed on
    // top of the two July warnings, 35 hours before a fixture. It must
    // not wait, and it must not be swallowed by the daily rule.
    const before = sutton(NOON);
    const after = [...before, finding("inbound-silent", { severity: "critical" })];
    const plan = planHealthAlert({
      findings: after,
      resolved: [],
      lastAlertAt: DIGEST_TIME, // the digest already went this morning
      lastAlertCodes: codesOf(before),
      now: NOON,
    });
    expect(plan.send).toBe(true);
    expect(plan.reason).toContain("inbound-silent");
  });

  it("breaks through in the middle of the night too", () => {
    const before = sutton(NOON);
    const after = [...before, finding("pi-silent", { severity: "critical" })];
    const threeAm = new Date("2026-09-15T02:00:00.000Z");
    const plan = planHealthAlert({
      findings: after,
      resolved: [],
      lastAlertAt: new Date(threeAm.getTime() - 20 * MINUTE),
      lastAlertCodes: codesOf(before),
      now: threeAm,
    });
    expect(plan.send).toBe(true);
    expect(plan.reason).toContain("pi-silent");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. WHICH CHANNEL. Email is cheap and archivable; a DM interrupts.
// ═══════════════════════════════════════════════════════════════════════

describe("planHealthAlert — the DM is reserved for news", () => {
  it("does NOT DM the daily digest when nothing changed and nothing is critical", () => {
    const findings = sutton(NOON);
    const plan = planHealthAlert({
      findings,
      resolved: [],
      lastAlertAt: new Date("2026-09-14T07:00:00.000Z"),
      lastAlertCodes: codesOf(findings),
      now: DIGEST_TIME,
    });
    expect(plan.send).toBe(true); // the email still goes
    expect(plan.dm).toBe(false); // the phone does not buzz
  });

  it("DOES DM when a new condition appears", () => {
    const before = sutton(NOON);
    const plan = planHealthAlert({
      findings: [...before, finding("messages-dropped", { severity: "critical" })],
      resolved: [],
      lastAlertAt: DIGEST_TIME,
      lastAlertCodes: codesOf(before),
      now: NOON,
    });
    expect(plan.dm).toBe(true);
  });

  it("DOES DM a daily digest that still carries a critical", () => {
    // A warning that has been true for 70 days does not deserve a daily
    // interruption. A CRITICAL that is still unfixed tomorrow does.
    const findings = [
      ...sutton(NOON),
      finding("seen-not-buffered", {
        severity: "critical",
        firstSeenAt: new Date(NOON.getTime() - 5 * DAY),
      }),
    ];
    const plan = planHealthAlert({
      findings,
      resolved: [],
      lastAlertAt: new Date("2026-09-14T07:00:00.000Z"),
      lastAlertCodes: codesOf(findings),
      now: DIGEST_TIME,
    });
    expect(plan.send).toBe(true);
    expect(plan.dm).toBe(true);
  });

  it("DMs the digest when the previous alert was swallowed by quiet hours", () => {
    // A new fault at 03:00 emails but cannot DM (`dmAllowedNow`). Under
    // the old six-hour repeat the morning re-fire delivered it. With one
    // alert a day that second chance is gone unless the digest takes it.
    // Deliberately all WARNINGS, so this proves the quiet-hours clause
    // and not the still-critical one.
    const findings = [...sutton(NOON), finding("reactions-failing")];
    const plan = planHealthAlert({
      findings,
      resolved: [],
      lastAlertAt: new Date("2026-09-14T02:00:00.000Z"), // 03:00 London
      lastAlertCodes: codesOf(findings),
      now: DIGEST_TIME,
    });
    expect(plan.send).toBe(true);
    expect(plan.dm).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. WHAT HAPPENS WHEN SOMETHING FINALLY CLEARS
// ═══════════════════════════════════════════════════════════════════════

describe("planHealthAlert — recovery", () => {
  it("still says nothing when a SHORT-lived condition clears", () => {
    // Unchanged judgement from the original module: a blip recovering is
    // what is supposed to happen, and a channel that announces good
    // outcomes is one whose alerts stop being read.
    const resolved: ResolvedFinding[] = [
      {
        code: "reactions-failing",
        label: labelForCode("reactions-failing"),
        firstSeenAt: new Date(NOON.getTime() - 2 * HOUR),
      },
    ];
    const plan = planHealthAlert({
      findings: sutton(NOON),
      resolved,
      lastAlertAt: DIGEST_TIME,
      lastAlertCodes: [...codesOf(sutton(NOON)), "reactions-failing"],
      now: NOON,
    });
    expect(plan.send).toBe(false);
  });

  it("DOES speak when something that had been collapsed finally clears", () => {
    // The line "Still broken since 7 Jul: the participant sweep" has been
    // in every digest for weeks. Its disappearance without a word reads
    // as a monitoring bug, not as a fix.
    const resolved: ResolvedFinding[] = [
      {
        code: "sweep-stale",
        label: labelForCode("sweep-stale"),
        firstSeenAt: new Date("2026-07-07T15:08:13.683Z"),
      },
    ];
    const plan = planHealthAlert({
      findings: [],
      resolved,
      lastAlertAt: DIGEST_TIME,
      lastAlertCodes: ["sweep-stale"],
      now: NOON,
    });
    expect(plan.send).toBe(true);
    expect(plan.reason).toContain("sweep-stale");
    expect(plan.dm).toBe(true);
  });

  it("goes quiet again once the all clear has been said", () => {
    const plan = planHealthAlert({
      findings: [],
      resolved: [],
      lastAlertAt: NOON,
      lastAlertCodes: [],
      now: new Date(NOON.getTime() + DAY),
    });
    expect(plan.send).toBe(false);
    expect(plan.reason).toBe("healthy");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. THE LEDGER. Where a first-seen timestamp comes from.
// ═══════════════════════════════════════════════════════════════════════

describe("trackFirstSeen", () => {
  const fallback = new Date("2026-09-09T12:00:30.853Z"); // BotHealth.createdAt

  it("stamps a finding it has never seen with now", () => {
    const out = trackFirstSeen({
      findings: [finding("messages-dropped")],
      ledger: {},
      knownCodes: [],
      fallbackFirstSeen: fallback,
      now: NOON,
    });
    expect(out.findings[0].firstSeenAt).toEqual(NOON);
    expect(out.ledger["messages-dropped"]).toBe(NOON.toISOString());
  });

  it("keeps the ORIGINAL timestamp on a finding that is still there", () => {
    const july = "2026-07-07T15:08:13.683Z";
    const out = trackFirstSeen({
      findings: [finding("sweep-stale")],
      ledger: { "sweep-stale": july },
      knownCodes: ["sweep-stale"],
      fallbackFirstSeen: fallback,
      now: NOON,
    });
    expect(out.findings[0].firstSeenAt?.toISOString()).toBe(july);
  });

  it("back-stamps a code that was already being alerted on before the ledger existed", () => {
    // The deploy case, and the only reason this feature works on day one
    // rather than in three days' time. Sutton FC's row carries
    // `lastAlertCodes = ["capability-degraded","sweep-stale"]` and no
    // ledger, so the honest answer to "since when" is "not later than
    // the moment this monitor first wrote the row", which is
    // `BotHealth.createdAt`. Claiming `now` would restart the clock on a
    // fault that is 70 days old.
    const out = trackFirstSeen({
      findings: [finding("capability-degraded"), finding("sweep-stale")],
      ledger: null,
      knownCodes: ["capability-degraded", "sweep-stale"],
      fallbackFirstSeen: fallback,
      now: NOON,
    });
    for (const f of out.findings) expect(f.firstSeenAt).toEqual(fallback);
  });

  it("reports what disappeared, with how long it had been there", () => {
    const out = trackFirstSeen({
      findings: [finding("sweep-stale")],
      ledger: {
        "sweep-stale": "2026-07-07T15:08:13.683Z",
        "pi-silent": "2026-09-15T09:00:00.000Z",
      },
      knownCodes: ["sweep-stale", "pi-silent"],
      fallbackFirstSeen: fallback,
      now: NOON,
    });
    expect(out.resolved.map((r) => r.code)).toEqual(["pi-silent"]);
    expect(out.ledger).not.toHaveProperty("pi-silent");
  });

  it("measures the MONITOR's clock, not the fault's, however old the fault is", () => {
    // The distinction that stops the feature eating its own explanation.
    // A `sweep-stale` whose `brokenSince` is 2026-07-07 but which is
    // being reported for the FIRST time must still get its paragraph:
    // collapsing it on its first alert would mean the reason was never
    // sent to anybody. `brokenSince` is the printed DATE and nothing
    // else; the composition tests below pin that half.
    const july = new Date("2026-07-07T15:08:13.683Z");
    const out = trackFirstSeen({
      findings: [finding("sweep-stale", { brokenSince: july })],
      ledger: {},
      knownCodes: [],
      fallbackFirstSeen: fallback,
      now: NOON,
    });
    expect(out.findings[0].firstSeenAt).toEqual(NOON);
    const alert = composeHealthAlert("Sutton Football Club", out.findings, { now: NOON })!;
    expect(alert.text).toContain("What sweep-stale costs"); // in full, not collapsed
  });

  it("survives whatever is actually in the JSON column", () => {
    // It is a `Json?` column, so the type system guarantees nothing. A
    // monitoring job that throws on its own bookkeeping reports nothing,
    // which is the failure this whole module exists to end.
    for (const junk of [null, undefined, "nope", 42, [], { "sweep-stale": "not-a-date" }]) {
      const out = trackFirstSeen({
        findings: [finding("sweep-stale")],
        ledger: junk,
        knownCodes: [],
        fallbackFirstSeen: fallback,
        now: NOON,
      });
      expect(out.findings[0].firstSeenAt).toEqual(NOON);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. THE SENTENCE. New first, old collapsed.
// ═══════════════════════════════════════════════════════════════════════

describe("composeHealthAlert — leads with what changed", () => {
  const july = new Date("2026-07-07T15:08:13.683Z");

  function mixed(): HealthFinding[] {
    return [
      finding("capability-degraded", { label: "4 bot capabilities", firstSeenAt: july }),
      finding("sweep-stale", { firstSeenAt: july }),
      finding("inbound-silent", {
        severity: "critical",
        headline: "Nothing from this group has been analysed for 40 hours.",
        firstSeenAt: new Date(NOON.getTime() - HOUR),
      }),
    ];
  }

  it("renders the hour-old finding in FULL, and the two-month-old ones as one line", () => {
    const alert = composeHealthAlert("Sutton Football Club", mixed(), { now: NOON })!;
    // The new one in full: headline AND its detail paragraph.
    expect(alert.text).toContain("Nothing from this group has been analysed for 40 hours.");
    expect(alert.text).toContain("What inbound-silent costs");
    // The old ones collapsed: named, dated, but no paragraphs.
    expect(alert.text).toContain("Still broken since 7 Jul");
    expect(alert.text).toContain("4 bot capabilities");
    expect(alert.text).toContain(labelForCode("sweep-stale"));
    expect(alert.text).not.toContain("What sweep-stale costs");
    expect(alert.text).not.toContain("What capability-degraded costs");
  });

  it("puts the new finding ABOVE the collapsed line, not underneath it", () => {
    // The whole point. Production put the 40-hour outage third, under two
    // warnings from July.
    const alert = composeHealthAlert("Sutton Football Club", mixed(), { now: NOON })!;
    const newAt = alert.text.indexOf("analysed for 40 hours");
    const oldAt = alert.text.indexOf("Still broken since");
    expect(newAt).toBeGreaterThan(-1);
    expect(oldAt).toBeGreaterThan(-1);
    expect(newAt).toBeLessThan(oldAt);
  });

  it("says so in the subject, so the inbox is skimmable without opening it", () => {
    const alert = composeHealthAlert("Sutton Football Club", mixed(), {
      now: NOON,
      freshCodes: ["inbound-silent"],
    })!;
    expect(alert.subject).toContain("Sutton Football Club");
    expect(alert.subject).toContain("1 new");
    expect(alert.subject).toContain("2 ongoing");
  });

  it("does NOT call a three-day-old finding new just because it is still in full", () => {
    // Day two and day three of a fault still get the paragraph (the
    // collapse threshold is 72 hours) but the owner has read it before,
    // and a subject line claiming otherwise is the thing that trains a
    // reader to stop reading subject lines.
    const twoDays = [
      finding("sweep-stale", { firstSeenAt: new Date(NOON.getTime() - 2 * DAY) }),
    ];
    const alert = composeHealthAlert("Sutton Football Club", twoDays, {
      now: NOON,
      freshCodes: [],
    })!;
    expect(alert.subject.toLowerCase()).toContain("nothing new");
    expect(alert.subject).toContain("1 ongoing");
    expect(alert.text).toContain("What sweep-stale costs"); // still in full
  });

  it("marks a digest with nothing new as exactly that", () => {
    const alert = composeHealthAlert("Sutton Football Club", sutton(NOON), { now: NOON })!;
    expect(alert.subject.toLowerCase()).toContain("nothing new");
    expect(alert.text).toContain("Still broken since 7 Jul");
    // And it is SHORT. The production digest was 987 characters of text
    // the owner had read 23 times.
    expect(alert.text.length).toBeLessThan(500);
  });

  it("keeps a finding younger than the threshold in full", () => {
    const young = [
      finding("sweep-stale", {
        firstSeenAt: new Date(NOON.getTime() - COLLAPSE_AFTER_MS + HOUR),
      }),
    ];
    const alert = composeHealthAlert("Sutton Football Club", young, { now: NOON })!;
    expect(alert.text).toContain("What sweep-stale costs");
    expect(alert.text).not.toContain("Still broken since");
  });

  it("collapses it the moment it crosses the threshold", () => {
    const old = [
      finding("sweep-stale", {
        firstSeenAt: new Date(NOON.getTime() - COLLAPSE_AFTER_MS - MINUTE),
      }),
    ];
    const alert = composeHealthAlert("Sutton Football Club", old, { now: NOON })!;
    expect(alert.text).not.toContain("What sweep-stale costs");
    expect(alert.text).toContain("Still broken since");
  });

  it("dates the roll-up from the FAULT, not from the day it started saying so", () => {
    // The Sutton line the owner's example asked for. The sweep last
    // succeeded 2026-07-07 and `lastParticipantSweepAt` has said so in
    // the database the whole time; this monitor only started on
    // 2026-09-09. "Still broken since 9 Sep" about a fault he dates to
    // July is the small wrongness that costs the rest of the message
    // its credibility.
    const sweep = finding("sweep-stale", {
      firstSeenAt: new Date("2026-09-09T12:00:30.853Z"), // when the monitor started
      brokenSince: july, // when the sweep actually died
    });
    const alert = composeHealthAlert("Sutton Football Club", [sweep], { now: NOON })!;
    expect(alert.text).toContain("Still broken since 7 Jul");
    expect(alert.text).not.toContain("9 Sep");
  });

  it("ignores a brokenSince in the future rather than printing it", () => {
    const bad = finding("sweep-stale", {
      firstSeenAt: july,
      brokenSince: new Date(NOON.getTime() + 30 * DAY),
    });
    const alert = composeHealthAlert("Sutton Football Club", [bad], { now: NOON })!;
    expect(alert.text).toContain("Still broken since 7 Jul");
    expect(alert.text).not.toContain("Oct");
  });

  it("dates each one separately when they did not start together", () => {
    const two = [
      finding("capability-degraded", { label: "4 bot capabilities", firstSeenAt: july }),
      finding("sweep-stale", { firstSeenAt: new Date("2026-09-01T09:00:00.000Z") }),
    ];
    const alert = composeHealthAlert("Sutton Football Club", two, { now: NOON })!;
    expect(alert.text).toContain("since 7 Jul");
    expect(alert.text).toContain("since 1 Sep");
  });

  it("still renders a finding with no first-seen timestamp in full", () => {
    // A row written before the ledger column existed, or an org whose
    // first alert this is. Nothing may be collapsed on a guess.
    const alert = composeHealthAlert("Sutton Football Club", [finding("sweep-stale")], {
      now: NOON,
    })!;
    expect(alert.text).toContain("What sweep-stale costs");
  });

  it("announces a long-running finding that cleared", () => {
    const alert = composeHealthAlert("Sutton Football Club", [], {
      now: NOON,
      resolved: [{ code: "sweep-stale", label: labelForCode("sweep-stale"), firstSeenAt: july }],
    })!;
    expect(alert.subject.toLowerCase()).toContain("all clear");
    expect(alert.text).toContain("Fixed");
    expect(alert.text).toContain(labelForCode("sweep-stale"));
    // "first reported", not "lasted": the cron only looks once an hour
    // and only alerts once a day, so the moment it ENDED is not a thing
    // this module knows. Claiming a duration would be making it up.
    expect(alert.text).toContain("first reported 70 days ago");
  });

  it("returns null when there is nothing at all to say", () => {
    expect(composeHealthAlert("Sutton Football Club", [], { now: NOON })).toBeNull();
  });

  it("holds house style on every shape it can produce", () => {
    const shapes: Array<[HealthFinding[], ResolvedFinding[]]> = [
      [mixed(), []],
      [sutton(NOON), []],
      [[], [{ code: "sweep-stale", label: labelForCode("sweep-stale"), firstSeenAt: july }]],
      [sutton(NOON), [{ code: "pi-silent", label: labelForCode("pi-silent"), firstSeenAt: july }]],
    ];
    for (const [f, r] of shapes) {
      const alert = composeHealthAlert("Sutton Football Club", f, { now: NOON, resolved: r })!;
      expect(alert.text).not.toContain("—");
      expect(alert.text).not.toContain("–");
      expect(alert.subject).not.toContain("—");
      expect(alert.subject).not.toContain("–");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. THE THING THAT MUST NOT BE BATCHED
// ═══════════════════════════════════════════════════════════════════════

describe("the operator note stays immediate", () => {
  // The owner drew this line himself, in the same message that asked for
  // one alert a day:
  //
  //   "I am not talking about the WhatsApp message when a message not
  //    recognised in the group, that can immediately come as a
  //    notification"
  //
  // It is a different system on a different trigger (the analyze route,
  // per batch, one hour of dedupe) and it has caught the last three
  // incidents. These assertions are source-level on purpose: the risk is
  // not that somebody breaks it today, it is that somebody tidying up
  // the health digest a year from now folds this into it as well.
  const root = process.cwd();
  const analyze = readFileSync(
    path.join(root, "src/app/api/whatsapp/analyze/route.ts"),
    "utf8",
  );
  const note = readFileSync(path.join(root, "src/lib/operator-note.ts"), "utf8");

  it("is dispatched from the analyze route, in the same request as the batch", () => {
    expect(analyze).toContain("composeOperatorNote");
    expect(analyze).toContain("botJob.create");
  });

  it("still dedupes on one hour, and on nothing longer", () => {
    expect(analyze).toContain("60 * 60 * 1000); // 1h dedupe window");
  });

  it("never queues itself behind a digest, a schedule or a quiet hour", () => {
    for (const forbidden of [
      "DAILY_DIGEST_HOUR",
      "ALERT_MAX_SILENCE_MS",
      "COLLAPSE_AFTER_MS",
      "planHealthAlert",
      "dmAllowedNow",
      "sendAfter",
    ]) {
      expect(note, `operator-note.ts must not know about ${forbidden}`).not.toContain(forbidden);
    }
    expect(note).not.toContain("bot-health");
  });
});
