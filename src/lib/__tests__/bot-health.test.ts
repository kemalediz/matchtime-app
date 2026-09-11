/**
 * The alerting rules, tested as pure logic.
 *
 * The point of this file is the NEGATIVE cases. A health alert that fires
 * on a quiet Tuesday gets muted, and a muted alert is the same silence
 * that cost three days in August with extra steps. So every positive case
 * below is paired with the nearest healthy situation it must NOT fire on.
 */
import { describe, it, expect } from "vitest";
import {
  ALERT_REPEAT_MS,
  assessBotHealth,
  composeHealthAlert,
  dmAllowedNow,
  HEARTBEAT_SILENT_MS,
  NONE_SHADOW_SILENT_MS,
  parseHeartbeat,
  planHealthAlert,
  type HealthCounters,
  type HealthInput,
} from "../bot-health";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-09-09T12:00:00.000Z");

function counters(over: Partial<HealthCounters> = {}): HealthCounters {
  return {
    seen: 0,
    buffered: 0,
    synthetic: 0,
    reconstructed: 0,
    notGroup: 0,
    degradedEnrichment: 0,
    nameless: 0,
    reactFailures: 0,
    flushFailures: 0,
    droppedMessages: 0,
    ...over,
  };
}

/** A completely healthy org, mid-week, with a match on Thursday. */
function healthy(over: Partial<HealthInput> = {}): HealthInput {
  return {
    orgName: "Sutton FC",
    now: NOW,
    botEnabled: true,
    heartbeat: {
      at: new Date(NOW.getTime() - 5 * 60 * 1000),
      processStartedAt: new Date(NOW.getTime() - 3 * DAY),
      counters: counters({ seen: 400, buffered: 380, notGroup: 20 }),
      degradedCapabilities: [],
    },
    lastAnalyzedMessageAt: new Date(NOW.getTime() - 2 * HOUR),
    lastParticipantSweepAt: new Date(NOW.getTime() - 2 * DAY),
    nextMatchAt: new Date(NOW.getTime() + 2 * DAY),
    namelessUnattributed24h: 0,
    // The nightly `none`-bucket sweep is on, and filed its row at 03:00
    // this morning. Anything else is a finding — see the block at the
    // bottom of this file.
    noneShadowEnabled: true,
    lastNoneShadowAt: new Date(NOW.getTime() - 9 * HOUR),
    ...over,
  };
}

const codes = (i: HealthInput) => assessBotHealth(i).map((f) => f.code).sort();

describe("assessBotHealth — the healthy baseline", () => {
  it("says nothing at all about a healthy org", () => {
    expect(assessBotHealth(healthy())).toEqual([]);
  });

  it("says nothing about an org whose bot is switched off, whatever the data", () => {
    const churned = healthy({
      botEnabled: false,
      heartbeat: null,
      lastAnalyzedMessageAt: new Date(NOW.getTime() - 90 * DAY),
      lastParticipantSweepAt: null,
      nextMatchAt: new Date(NOW.getTime() + HOUR),
    });
    expect(assessBotHealth(churned)).toEqual([]);
  });
});

describe("assessBotHealth — false alarms it must not raise", () => {
  it("does NOT alert on a quiet group with no match coming up", () => {
    // Nobody has said anything for four days. There is no fixture. That is
    // a club on a break, not a broken bot.
    const quiet = healthy({
      lastAnalyzedMessageAt: new Date(NOW.getTime() - 4 * DAY),
      nextMatchAt: null,
      heartbeat: {
        at: new Date(NOW.getTime() - 60 * 1000),
        processStartedAt: new Date(NOW.getTime() - 6 * DAY),
        // seen === notGroup: the handler only ever saw DMs, never a group
        // message. A silent group produces exactly this.
        counters: counters({ seen: 12, buffered: 0, notGroup: 12 }),
        degradedCapabilities: [],
      },
    });
    expect(assessBotHealth(quiet)).toEqual([]);
  });

  it("does NOT alert on a quiet Tuesday morning when the match is still days away", () => {
    const quiet = healthy({
      lastAnalyzedMessageAt: new Date(NOW.getTime() - 20 * HOUR),
      nextMatchAt: new Date(NOW.getTime() + 3 * DAY),
    });
    expect(assessBotHealth(quiet)).toEqual([]);
  });

  it("does NOT alert on an overnight gap before an imminent match", () => {
    // 11pm to 12pm the next day is 13 hours of entirely normal silence.
    const overnight = healthy({
      lastAnalyzedMessageAt: new Date(NOW.getTime() - 13 * HOUR),
      nextMatchAt: new Date(NOW.getTime() + 9 * HOUR),
    });
    expect(assessBotHealth(overnight)).toEqual([]);
  });

  it("does NOT alert on a DORMANT club whose matches keep being generated", () => {
    // Sutton Lads churned in June; the Activity still exists so matches
    // keep appearing. The group has been dead for weeks. Silence there is
    // the truth, not a fault.
    const dormant = healthy({
      lastAnalyzedMessageAt: new Date(NOW.getTime() - 40 * DAY),
      nextMatchAt: new Date(NOW.getTime() + 6 * HOUR),
      lastParticipantSweepAt: new Date(NOW.getTime() - DAY),
    });
    expect(codes(dormant)).not.toContain("inbound-silent");
  });

  it("does NOT alert when no heartbeat has ever arrived (an older Pi build)", () => {
    // The server ships on merge; the Pi is deployed by hand. Between the
    // two there is a window where the Pi simply does not know about the
    // heartbeat endpoint. That must not page anyone.
    const oldPi = healthy({ heartbeat: null });
    expect(assessBotHealth(oldPi)).toEqual([]);
  });

  it("does NOT call a reconstructed id a fault", () => {
    // A reconstructed id still joins to reaction events, so the product
    // keeps working. It is a drift signal, not an outage, and paging on it
    // would train the reader to ignore the channel.
    const drift = healthy({
      heartbeat: {
        at: new Date(NOW.getTime() - 60 * 1000),
        processStartedAt: new Date(NOW.getTime() - DAY),
        counters: counters({ seen: 100, buffered: 90, notGroup: 10, reconstructed: 90 }),
        degradedCapabilities: [],
      },
    });
    expect(assessBotHealth(drift)).toEqual([]);
  });
});

describe("assessBotHealth — the Pi has stopped reporting", () => {
  it("raises pi-silent once the last heartbeat is older than the threshold", () => {
    const dead = healthy({
      heartbeat: {
        at: new Date(NOW.getTime() - HEARTBEAT_SILENT_MS - 60_000),
        processStartedAt: new Date(NOW.getTime() - 5 * DAY),
        counters: counters({ seen: 400, buffered: 380, notGroup: 20 }),
        degradedCapabilities: [],
      },
    });
    const found = assessBotHealth(dead);
    expect(found.map((f) => f.code)).toContain("pi-silent");
    expect(found.find((f) => f.code === "pi-silent")?.severity).toBe("critical");
  });

  it("does NOT raise pi-silent for a gap inside the threshold", () => {
    const blip = healthy({
      heartbeat: {
        at: new Date(NOW.getTime() - HEARTBEAT_SILENT_MS + 60_000),
        processStartedAt: new Date(NOW.getTime() - 5 * DAY),
        counters: counters({ seen: 400, buffered: 380, notGroup: 20 }),
        degradedCapabilities: [],
      },
    });
    expect(codes(blip)).not.toContain("pi-silent");
  });

  it("reports the dead Pi ONCE, not once per downstream symptom", () => {
    // A dead Pi also means no analyzed messages. Two alerts for one outage
    // is how a channel gets muted.
    const dead = healthy({
      heartbeat: {
        at: new Date(NOW.getTime() - 3 * HOUR),
        processStartedAt: new Date(NOW.getTime() - 5 * DAY),
        counters: counters({ seen: 400, buffered: 380, notGroup: 20 }),
        degradedCapabilities: [],
      },
      lastAnalyzedMessageAt: new Date(NOW.getTime() - 20 * HOUR),
      nextMatchAt: new Date(NOW.getTime() + 6 * HOUR),
    });
    expect(codes(dead)).toEqual(["pi-silent"]);
  });
});

describe("assessBotHealth — the layer is degraded but the Pi is alive", () => {
  it("raises seen-not-buffered when group messages arrive and none is buffered", () => {
    // The August signature exactly: the handler ran 340 times, the buffer
    // stayed empty, every flush logged nothing.
    const august = healthy({
      heartbeat: {
        at: new Date(NOW.getTime() - 60 * 1000),
        processStartedAt: new Date(NOW.getTime() - 2 * DAY),
        counters: counters({ seen: 340, buffered: 0, notGroup: 12 }),
        degradedCapabilities: [],
      },
    });
    expect(codes(august)).toContain("seen-not-buffered");
  });

  it("raises synthetic-ids on the FIRST synthesised id", () => {
    const synth = healthy({
      heartbeat: {
        at: new Date(NOW.getTime() - 60 * 1000),
        processStartedAt: new Date(NOW.getTime() - 2 * DAY),
        counters: counters({ seen: 100, buffered: 90, notGroup: 10, synthetic: 1 }),
        degradedCapabilities: [],
      },
    });
    expect(codes(synth)).toContain("synthetic-ids");
  });

  it("raises messages-dropped when the Pi says a batch never reached the analyzer", () => {
    const dropped = healthy({
      heartbeat: {
        at: new Date(NOW.getTime() - 60 * 1000),
        processStartedAt: new Date(NOW.getTime() - 2 * DAY),
        counters: counters({ seen: 100, buffered: 90, notGroup: 10, droppedMessages: 4 }),
        degradedCapabilities: [],
      },
    });
    const f = assessBotHealth(dropped).find((x) => x.code === "messages-dropped");
    expect(f?.severity).toBe("critical");
    expect(f?.headline).toContain("4");
  });

  it("raises enrichment-degraded on the first degraded enrichment", () => {
    const degraded = healthy({
      heartbeat: {
        at: new Date(NOW.getTime() - 60 * 1000),
        processStartedAt: new Date(NOW.getTime() - 2 * DAY),
        counters: counters({ seen: 100, buffered: 90, notGroup: 10, degradedEnrichment: 3 }),
        degradedCapabilities: [],
      },
    });
    expect(codes(degraded)).toContain("enrichment-degraded");
  });

  it("raises reactions-failing as a WARNING — attendance is still recorded", () => {
    const noReacts = healthy({
      heartbeat: {
        at: new Date(NOW.getTime() - 60 * 1000),
        processStartedAt: new Date(NOW.getTime() - 2 * DAY),
        counters: counters({ seen: 100, buffered: 90, notGroup: 10, reactFailures: 9 }),
        degradedCapabilities: [],
      },
    });
    const f = assessBotHealth(noReacts).find((x) => x.code === "reactions-failing");
    expect(f?.severity).toBe("warning");
  });

  it("forwards the capabilities the Pi itself declared degraded", () => {
    const cap = healthy({
      heartbeat: {
        at: new Date(NOW.getTime() - 60 * 1000),
        processStartedAt: new Date(NOW.getTime() - 2 * DAY),
        counters: counters({ seen: 100, buffered: 90, notGroup: 10 }),
        degradedCapabilities: ["participant-sync", "message-recovery"],
      },
    });
    const f = assessBotHealth(cap).find((x) => x.code === "capability-degraded");
    expect(f?.detail).toContain("participant-sync");
    expect(f?.detail).toContain("message-recovery");
  });
});

describe("assessBotHealth — the attribution hole", () => {
  it("raises nameless-senders when a message arrived with neither phone nor name", () => {
    const nameless = healthy({ namelessUnattributed24h: 2 });
    const f = assessBotHealth(nameless).find((x) => x.code === "nameless-senders");
    expect(f?.severity).toBe("critical");
    expect(f?.detail).toContain("attendance");
  });

  it("raises nameless-senders from the Pi's own counter too", () => {
    const nameless = healthy({
      heartbeat: {
        at: new Date(NOW.getTime() - 60 * 1000),
        processStartedAt: new Date(NOW.getTime() - 2 * DAY),
        counters: counters({ seen: 100, buffered: 90, notGroup: 10, nameless: 5 }),
        degradedCapabilities: [],
      },
    });
    expect(codes(nameless)).toContain("nameless-senders");
  });
});

describe("assessBotHealth — the participant sweep", () => {
  it("raises sweep-stale when the sweep has never run", () => {
    const never = healthy({ lastParticipantSweepAt: null });
    const f = assessBotHealth(never).find((x) => x.code === "sweep-stale");
    expect(f?.severity).toBe("warning");
    expect(f?.headline).toMatch(/never/i);
  });

  it("raises sweep-stale past the freshness window the self-IN gate uses", () => {
    const stale = healthy({ lastParticipantSweepAt: new Date(NOW.getTime() - 11 * DAY) });
    expect(codes(stale)).toContain("sweep-stale");
  });

  it("does NOT raise sweep-stale inside that window", () => {
    const fresh = healthy({ lastParticipantSweepAt: new Date(NOW.getTime() - 9 * DAY) });
    expect(codes(fresh)).not.toContain("sweep-stale");
  });
});

describe("assessBotHealth — the `none`-bucket shadow sweep", () => {
  // THE POINT OF THIS BLOCK IS THE FIRST TEST. The sweep's whole failure
  // mode is silence: it files a row when it runs, so the only evidence
  // that it did NOT run is a row that is not there. A test that only
  // proves the happy path would have passed against the code that let
  // the sweep file one row in five nights.

  it("ALERTS ON SILENCE — no row inside the expected window is the degradation", () => {
    const silent = healthy({
      lastNoneShadowAt: new Date(NOW.getTime() - (NONE_SHADOW_SILENT_MS + HOUR)),
    });
    const f = assessBotHealth(silent).find((x) => x.code === "none-shadow-stale");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.headline).toMatch(/hours|days/);
    // The sentence has to say what is LOST, not just that a cron is late:
    // nothing else re-reads the `none` bucket.
    expect(f?.detail).toMatch(/none/i);
  });

  it("alerts when the sweep has never filed a row at all", () => {
    const never = healthy({ lastNoneShadowAt: null });
    const f = assessBotHealth(never).find((x) => x.code === "none-shadow-stale");
    expect(f?.headline).toMatch(/never/i);
  });

  it("does NOT alert on a sweep that ran last night and found nothing", () => {
    // The case the old code could not express at all: a clean night wrote
    // no row, so "ran, found nothing" and "did not run" were the same
    // data. It files unconditionally now, so a clean night is silence
    // from the ALERT and a row in the table.
    const clean = healthy({ lastNoneShadowAt: new Date(NOW.getTime() - 9 * HOUR) });
    expect(codes(clean)).not.toContain("none-shadow-stale");
  });

  it("does NOT alert just because the cron ran a few hours late", () => {
    const lateButRan = healthy({
      lastNoneShadowAt: new Date(NOW.getTime() - (NONE_SHADOW_SILENT_MS - HOUR)),
    });
    expect(codes(lateButRan)).not.toContain("none-shadow-stale");
  });

  it("says NOTHING when the sweep is switched off — off is a decision, not a fault", () => {
    // `NONE_BUCKET_SHADOW_ENABLED` defaults OFF and is a deliberate act to
    // turn on. Paging hourly, forever, about a job nobody asked to run is
    // exactly the noise that gets this channel muted — and the four
    // capabilities that have been degraded for 65 days are already
    // testing Kemal's patience with it.
    const off = healthy({ noneShadowEnabled: false, lastNoneShadowAt: null });
    expect(codes(off)).not.toContain("none-shadow-stale");
    const offAndStale = healthy({
      noneShadowEnabled: false,
      lastNoneShadowAt: new Date(NOW.getTime() - 30 * DAY),
    });
    expect(codes(offAndStale)).not.toContain("none-shadow-stale");
  });

  it("rides the EXISTING dedupe rather than a channel of its own", () => {
    // New condition on top of a long-running one → speaks immediately.
    const known = ["capability-degraded", "sweep-stale"];
    const fresh = planHealthAlert({
      codes: [...known, "none-shadow-stale"],
      lastAlertAt: new Date(NOW.getTime() - 10 * 60 * 1000),
      lastAlertCodes: known,
      now: NOW,
    });
    expect(fresh.send).toBe(true);
    expect(fresh.reason).toContain("none-shadow-stale");

    // …and from then on it is one more line inside the same six-hourly
    // repeat, never its own email.
    const repeat = planHealthAlert({
      codes: [...known, "none-shadow-stale"],
      lastAlertAt: new Date(NOW.getTime() - 10 * 60 * 1000),
      lastAlertCodes: [...known, "none-shadow-stale"],
      now: NOW,
    });
    expect(repeat.send).toBe(false);
    expect(repeat.reason).toContain("repeat window");
  });
});

describe("assessBotHealth — the pipe is silent before a match", () => {
  it("raises inbound-silent when a live group goes quiet close to kickoff", () => {
    const silent = healthy({
      lastAnalyzedMessageAt: new Date(NOW.getTime() - 19 * HOUR),
      nextMatchAt: new Date(NOW.getTime() + 10 * HOUR),
    });
    const f = assessBotHealth(silent).find((x) => x.code === "inbound-silent");
    expect(f?.severity).toBe("critical");
  });

  it("does NOT raise it when the group has never been analysed at all", () => {
    // A brand-new org that has not started yet has nothing to be silent
    // about, and there is nothing to compare against.
    const brandNew = healthy({
      lastAnalyzedMessageAt: null,
      nextMatchAt: new Date(NOW.getTime() + 10 * HOUR),
    });
    expect(codes(brandNew)).not.toContain("inbound-silent");
  });
});

describe("composeHealthAlert", () => {
  it("returns null when there is nothing wrong", () => {
    expect(composeHealthAlert("Sutton FC", [])).toBeNull();
  });

  it("names the club, the worst severity and every finding", () => {
    const findings = assessBotHealth(
      healthy({
        heartbeat: {
          at: new Date(NOW.getTime() - 60 * 1000),
          processStartedAt: new Date(NOW.getTime() - 2 * DAY),
          counters: counters({ seen: 340, buffered: 0, notGroup: 12, synthetic: 4 }),
          degradedCapabilities: [],
        },
      }),
    );
    const alert = composeHealthAlert("Sutton FC", findings);
    expect(alert).not.toBeNull();
    expect(alert!.subject).toContain("Sutton FC");
    expect(alert!.text).toContain("Sutton FC");
    for (const f of findings) expect(alert!.text).toContain(f.headline);
  });

  it("follows house style: no em dashes and no slashes in the prose", () => {
    // Same rule the group-sync warning is held to. This lands in Kemal's
    // inbox and in a WhatsApp DM, so it is copy, not a log line.
    const findings = assessBotHealth(
      healthy({
        heartbeat: {
          at: new Date(NOW.getTime() - 3 * HOUR),
          processStartedAt: new Date(NOW.getTime() - 2 * DAY),
          counters: counters({
            seen: 340,
            buffered: 0,
            notGroup: 12,
            synthetic: 4,
            droppedMessages: 2,
            degradedEnrichment: 1,
            reactFailures: 3,
          }),
          degradedCapabilities: ["participant-sync"],
        },
        lastParticipantSweepAt: null,
        namelessUnattributed24h: 1,
      }),
    );
    const alert = composeHealthAlert("Sutton FC", findings)!;
    expect(alert.subject).not.toContain("—");
    expect(alert.subject).not.toContain("–");
    expect(alert.text).not.toContain("—");
    expect(alert.text).not.toContain("–");
  });

  it("does not read as a template — it says what to do next", () => {
    const findings = assessBotHealth(
      healthy({
        heartbeat: {
          at: new Date(NOW.getTime() - 3 * HOUR),
          processStartedAt: new Date(NOW.getTime() - 2 * DAY),
          counters: counters({ seen: 10, buffered: 10 }),
          degradedCapabilities: [],
        },
      }),
    );
    const alert = composeHealthAlert("Sutton FC", findings)!;
    expect(alert.text.toLowerCase()).toContain("bot.log");
  });
});

describe("planHealthAlert — dedupe", () => {
  const two = ["pi-silent", "sweep-stale"];

  it("sends the first time anything is wrong", () => {
    const p = planHealthAlert({ codes: two, lastAlertAt: null, lastAlertCodes: [], now: NOW });
    expect(p.send).toBe(true);
  });

  it("stays silent when nothing is wrong", () => {
    const p = planHealthAlert({ codes: [], lastAlertAt: null, lastAlertCodes: [], now: NOW });
    expect(p.send).toBe(false);
  });

  it("stays silent on the same conditions inside the repeat window", () => {
    const p = planHealthAlert({
      codes: two,
      lastAlertAt: new Date(NOW.getTime() - ALERT_REPEAT_MS + 60_000),
      lastAlertCodes: two,
      now: NOW,
    });
    expect(p.send).toBe(false);
  });

  it("repeats once the window has passed and it is still broken", () => {
    const p = planHealthAlert({
      codes: two,
      lastAlertAt: new Date(NOW.getTime() - ALERT_REPEAT_MS - 60_000),
      lastAlertCodes: two,
      now: NOW,
    });
    expect(p.send).toBe(true);
  });

  it("speaks immediately when a NEW condition appears, window or not", () => {
    const p = planHealthAlert({
      codes: [...two, "messages-dropped"],
      lastAlertAt: new Date(NOW.getTime() - 60_000),
      lastAlertCodes: two,
      now: NOW,
    });
    expect(p.send).toBe(true);
    expect(p.reason).toContain("new");
  });

  it("does NOT speak when a condition CLEARS — recovery is not an incident", () => {
    const p = planHealthAlert({
      codes: ["pi-silent"],
      lastAlertAt: new Date(NOW.getTime() - 60_000),
      lastAlertCodes: two,
      now: NOW,
    });
    expect(p.send).toBe(false);
  });
});

describe("parseHeartbeat — the wire", () => {
  it("rejects a body with no groupId", () => {
    expect(parseHeartbeat({ counters: {} })).toBeNull();
    expect(parseHeartbeat(null)).toBeNull();
    expect(parseHeartbeat("nope")).toBeNull();
  });

  it("accepts a minimal body — a Pi may send only what it has", () => {
    const p = parseHeartbeat({ groupId: "123@g.us" });
    expect(p?.groupId).toBe("123@g.us");
    expect(p?.counters).toEqual(counters());
    expect(p?.degradedCapabilities).toEqual([]);
    expect(p?.processStartedAt).toBeNull();
  });

  it("reads the counters it knows and ignores keys it does not", () => {
    // Forward compatibility: a newer Pi may add a counter this server has
    // never heard of, and that must be a no-op rather than a 400.
    const p = parseHeartbeat({
      groupId: "123@g.us",
      counters: { seen: 10, buffered: 9, notGroup: 1, somethingNew: 42 },
    });
    expect(p?.counters.seen).toBe(10);
    expect(p?.counters.buffered).toBe(9);
    expect(p?.counters).not.toHaveProperty("somethingNew");
  });

  it("refuses nonsense counters rather than storing them", () => {
    const p = parseHeartbeat({
      groupId: "123@g.us",
      counters: { seen: -5, buffered: "many", synthetic: 1.7, notGroup: NaN },
    });
    expect(p?.counters.seen).toBe(0);
    expect(p?.counters.buffered).toBe(0);
    expect(p?.counters.synthetic).toBe(1);
    expect(p?.counters.notGroup).toBe(0);
  });

  it("keeps a bad timestamp out of the database", () => {
    expect(
      parseHeartbeat({ groupId: "g@g.us", processStartedAt: "yesterday" })?.processStartedAt,
    ).toBeNull();
    expect(
      parseHeartbeat({
        groupId: "g@g.us",
        processStartedAt: "2026-09-09T00:00:00.000Z",
      })?.processStartedAt?.toISOString(),
    ).toBe("2026-09-09T00:00:00.000Z");
  });

  it("caps the degraded-capability list so a looping bot cannot bloat the row", () => {
    const many = Array.from({ length: 100 }, (_, i) => `cap-${i}`);
    const p = parseHeartbeat({ groupId: "g@g.us", degradedCapabilities: many });
    expect(p!.degradedCapabilities.length).toBeLessThanOrEqual(20);
    expect(p!.degradedCapabilities).toContain("cap-0");
  });

  it("drops non-string capabilities", () => {
    const p = parseHeartbeat({ groupId: "g@g.us", degradedCapabilities: ["ok", 5, null, ""] });
    expect(p!.degradedCapabilities).toEqual(["ok"]);
  });
});

describe("dmAllowedNow — quiet hours", () => {
  it("allows a DM during the day", () => {
    expect(dmAllowedNow(new Date("2026-09-09T13:00:00.000Z"))).toBe(true);
  });

  it("refuses a DM in the middle of the night, London time", () => {
    // 02:30 UTC in September is 03:30 BST.
    expect(dmAllowedNow(new Date("2026-09-09T02:30:00.000Z"))).toBe(false);
  });

  it("refuses a DM just before midnight, London time", () => {
    // 22:30 UTC is 23:30 BST.
    expect(dmAllowedNow(new Date("2026-09-09T22:30:00.000Z"))).toBe(false);
  });

  it("allows a DM from 07:00 London", () => {
    // 06:30 UTC is 07:30 BST.
    expect(dmAllowedNow(new Date("2026-09-09T06:30:00.000Z"))).toBe(true);
  });
});
