/**
 * §11.1's fourth containment: shadow the `none` bucket forever.
 *
 * The gate's failure is silent by construction, so this sweep is the
 * only thing that can ever notice it. What these tests pin:
 *
 *   - it is OFF by default, and its own flag, not the gate's;
 *   - it looks only at messages the GATE skipped, never at the whole
 *     analyzed log;
 *   - it alerts on an attendance claim and stays quiet otherwise;
 *   - it NEVER writes to the squad — the failure mode of a regression
 *     detector that acts is worse than the regression.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimsOf,
  noneShadowBatchHash,
  NONE_SHADOW_BATCH_PREFIX,
  runNoneBucketShadow,
  sampleNoneBucket,
  toWindowShape,
  type NoneBucketDb,
  type NoneBucketRow,
} from "../none-shadow";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";

afterEach(() => {
  delete process.env.NONE_BUCKET_SHADOW_ENABLED;
  delete process.env.ROUTER_GATE_ENABLED;
  vi.restoreAllMocks();
});

function rows(n: number, bodies?: string[]): NoneBucketRow[] {
  return Array.from({ length: n }, (_, i) => ({
    waMessageId: `m${i}`,
    orgId: "org1",
    authorName: `p${i}`,
    body: bodies?.[i] ?? "😂",
    createdAt: new Date(Date.UTC(2026, 8, 1, 12, i)),
  }));
}

function fakeDb(rs: NoneBucketRow[]): NoneBucketDb & { args: unknown[] } {
  const args: unknown[] = [];
  return {
    args,
    analyzedMessage: {
      async findMany(a: unknown) {
        args.push(a);
        return rs;
      },
    },
  };
}

/** A model that returns whatever facts the test asks for. */
function fakeModel(facts: unknown, seen: ModelRequest[] = []): PipelineModel {
  return {
    name: "fake",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      seen.push(req);
      return {
        text: JSON.stringify(facts),
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0001,
        ms: 1,
      };
    },
  };
}

const NO_CLAIMS = { claims: [], affirmation: null, sideRequests: [] };
const ONE_IN_CLAIM = {
  claims: [
    {
      subject: "sender",
      personRef: "me",
      personNamed: false,
      polarity: "in",
      contingent: false,
      conditionOn: null,
      tense: "present",
      reported: false,
      confidence: 0.9,
    },
  ],
  affirmation: null,
  sideRequests: [],
};

describe("the flag", () => {
  it("is off by default, and the gate's flag does not turn it on", async () => {
    const db = fakeDb(rows(3));
    const r = await runNoneBucketShadow({ db, model: fakeModel(NO_CLAIMS) });
    expect(r.enabled).toBe(false);
    expect(r.checked).toBe(0);
    // Not one query, let alone one model call.
    expect(db.args).toHaveLength(0);

    process.env.ROUTER_GATE_ENABLED = "1";
    expect((await runNoneBucketShadow({ db, model: fakeModel(NO_CLAIMS) })).enabled).toBe(false);
  });

  it("runs when its own flag is on", async () => {
    process.env.NONE_BUCKET_SHADOW_ENABLED = "1";
    const r = await runNoneBucketShadow({ db: fakeDb(rows(2)), model: fakeModel(NO_CLAIMS) });
    expect(r.enabled).toBe(true);
    expect(r.checked).toBe(2);
  });
});

describe("what it looks at", () => {
  it("queries ONLY messages the gate skipped, within the lookback", async () => {
    const db = fakeDb(rows(1));
    const now = new Date("2026-09-02T00:00:00.000Z");
    await runNoneBucketShadow({
      db,
      now,
      lookbackHours: 24,
      force: true,
      model: fakeModel(NO_CLAIMS),
    });
    const where = (db.args[0] as { where: { handledBy: string; createdAt: { gte: Date } } }).where;
    expect(where.handledBy).toBe("router-gate");
    expect(where.createdAt.gte.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("skips bodiless rows rather than paying to extract from an empty string", async () => {
    const db = fakeDb([
      { ...rows(1)[0], body: null },
      { ...rows(1)[0], waMessageId: "m2", body: "   " },
      { ...rows(1)[0], waMessageId: "m3", body: "in" },
    ]);
    const r = await runNoneBucketShadow({ db, force: true, model: fakeModel(NO_CLAIMS) });
    expect(r.available).toBe(1);
    expect(r.checked).toBe(1);
  });

  it("caps the sample and says how many it did NOT look at", async () => {
    const db = fakeDb(rows(100));
    const r = await runNoneBucketShadow({ db, force: true, limit: 10, model: fakeModel(NO_CLAIMS) });
    expect(r.checked).toBe(10);
    expect(r.available).toBe(100);
  });
});

describe("sampleNoneBucket", () => {
  it("spreads across the window instead of taking the first N", async () => {
    // The gate skips whole banter bursts at once; `slice(0, n)` would
    // re-examine one evening and call it a night's coverage.
    const picked = sampleNoneBucket([...Array(100).keys()], 5);
    expect(picked).toEqual([0, 20, 40, 60, 80]);
  });

  it("is deterministic, so a fix can be verified against the same sample", () => {
    const a = sampleNoneBucket([...Array(37).keys()], 7);
    const b = sampleNoneBucket([...Array(37).keys()], 7);
    expect(a).toEqual(b);
  });

  it("returns everything when there is less than the cap, and nothing for a zero cap", () => {
    expect(sampleNoneBucket([1, 2, 3], 10)).toEqual([1, 2, 3]);
    expect(sampleNoneBucket([1, 2, 3], 0)).toEqual([]);
  });
});

describe("what it alerts on", () => {
  it("alerts when a skipped message turns out to carry an attendance claim", async () => {
    const db = fakeDb(rows(1, ["im in mate"]));
    const r = await runNoneBucketShadow({ db, force: true, model: fakeModel(ONE_IN_CLAIM) });
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0].waMessageId).toBe("m0");
    expect(r.alerts[0].body).toBe("im in mate");
    expect(r.alerts[0].claims[0].polarity).toBe("in");
  });

  it("stays quiet on real banter", async () => {
    const r = await runNoneBucketShadow({
      db: fakeDb(rows(3)),
      force: true,
      model: fakeModel(NO_CLAIMS),
    });
    expect(r.alerts).toEqual([]);
  });

  it("re-examines under the ATTENDANCE extractor — the only miss worth waking anyone for", async () => {
    const seen: ModelRequest[] = [];
    await runNoneBucketShadow({
      db: fakeDb(rows(1)),
      force: true,
      model: fakeModel(NO_CLAIMS, seen),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].label).toBe("extractor:attendance");
  });

  it("records an extractor failure rather than reading it as `no claim`", async () => {
    const broken: PipelineModel = {
      name: "broken",
      async complete() {
        throw new Error("boom");
      },
    };
    const r = await runNoneBucketShadow({ db: fakeDb(rows(1)), force: true, model: broken });
    expect(r.alerts).toEqual([]);
    expect(r.errors.join(" ")).toContain("boom");
  });
});

describe("what it must never do", () => {
  it("proposes no state change, ever", () => {
    const payload = toWindowShape({
      enabled: true,
      checked: 1,
      available: 1,
      windowStart: new Date(Date.UTC(2026, 8, 1, 3)),
      windowEnd: new Date(Date.UTC(2026, 8, 2, 3)),
      byOrg: [{ orgId: "org1", available: 1, checked: 1, alerts: 1, costUsd: 0.001, ms: 5 }],
      alerts: [
        {
          waMessageId: "m0",
          orgId: "org1",
          authorName: "p0",
          body: "im in",
          createdAt: "2026-09-01T12:00:00.000Z",
          claims: ONE_IN_CLAIM.claims as never,
        },
      ],
      costUsd: 0.001,
      ms: 5,
      errors: [],
    });
    // An alert is a message for a person. Acting on a day-old
    // attendance claim would be worse than missing it — the squad has
    // moved on — so the dashboard payload carries no proposed write.
    expect(payload.stateChanges).toEqual([]);
    expect(payload.reactions).toEqual([]);
    expect(payload.groupReply).toBeNull();
    expect(payload.alerts).toHaveLength(1);
  });

  it("claimsOf ignores every non-attendance fact shape", () => {
    expect(claimsOf({ kind: "none" })).toEqual([]);
    expect(
      claimsOf({ kind: "score", red: 1, yellow: 2, reportedBy: null } as never),
    ).toEqual([]);
  });
});

/**
 * 2026-09-11 — the sweep has to leave evidence that it RAN.
 *
 * §1.4 of `MDs/router-accuracy-2026-09-11.md` counted one filed
 * `WindowVerdict` in the sweep's whole life, 1 of 506 rows, because the
 * cron only filed when `result.alerts[0]` existed. A clean night and a
 * dead cron left identical evidence: none. Everything below exists so
 * that "ran, found nothing" is a different state in the data from "did
 * not run".
 */
describe("proof that it ran", () => {
  it("reports the window it covered, so a filed row says WHAT was swept", () => {
    const now = new Date("2026-09-11T03:00:00.000Z");
    return runNoneBucketShadow({
      db: fakeDb(rows(2)),
      now,
      lookbackHours: 24,
      force: true,
      model: fakeModel(NO_CLAIMS),
    }).then((r) => {
      expect(r.windowEnd.toISOString()).toBe("2026-09-11T03:00:00.000Z");
      expect(r.windowStart.toISOString()).toBe("2026-09-10T03:00:00.000Z");
    });
  });

  it("names the org it read, on a night with NO alerts", () => {
    // The org was always knowable from the rows the sweep read. The old
    // route took it from `alerts[0]`, which is exactly the value that is
    // missing on a healthy night.
    return runNoneBucketShadow({
      db: fakeDb(rows(3)),
      force: true,
      model: fakeModel(NO_CLAIMS),
    }).then((r) => {
      expect(r.alerts).toEqual([]);
      expect(r.byOrg).toHaveLength(1);
      expect(r.byOrg[0].orgId).toBe("org1");
      expect(r.byOrg[0].available).toBe(3);
      expect(r.byOrg[0].checked).toBe(3);
      expect(r.byOrg[0].alerts).toBe(0);
      expect(r.byOrg[0].costUsd).toBeCloseTo(0.0003, 6);
    });
  });

  it("splits coverage per org, so one row per org can be filed", async () => {
    const mixed: NoneBucketRow[] = [
      { ...rows(1)[0], waMessageId: "a1", orgId: "orgA" },
      { ...rows(1)[0], waMessageId: "b1", orgId: "orgB" },
      { ...rows(1)[0], waMessageId: "b2", orgId: "orgB" },
    ];
    const r = await runNoneBucketShadow({
      db: fakeDb(mixed),
      force: true,
      model: fakeModel(NO_CLAIMS),
    });
    expect(r.byOrg.map((o) => [o.orgId, o.checked])).toEqual([
      ["orgA", 1],
      ["orgB", 2],
    ]);
  });

  it("reports an EMPTY sweep as a real result, not as nothing happening", async () => {
    // A night with no gated traffic at all — production had exactly this
    // on 2026-09-10 and 2026-09-11. The row filed for it is the only
    // thing that distinguishes it from a cron that never fired.
    const r = await runNoneBucketShadow({
      db: fakeDb([]),
      force: true,
      model: fakeModel(NO_CLAIMS),
    });
    expect(r.enabled).toBe(true);
    expect(r.checked).toBe(0);
    expect(r.available).toBe(0);
    expect(r.byOrg).toEqual([]);
    expect(r.windowEnd.getTime()).toBeGreaterThan(r.windowStart.getTime());
  });

  it("stamps the batch hash with the sweep's own day, under one shared prefix", () => {
    // `bot-health` finds the sweep's rows by this prefix. Two spellings
    // of it in two files is how the watcher silently stops watching.
    const h = noneShadowBatchHash(new Date("2026-09-11T03:00:00.000Z"));
    expect(h).toBe(`${NONE_SHADOW_BATCH_PREFIX}2026-09-11`);
    expect(NONE_SHADOW_BATCH_PREFIX).toBe("none-bucket:");
  });

  it("scopes the filed payload to one org, and still says it ran when it found nothing", () => {
    const payload = toWindowShape(
      {
        enabled: true,
        checked: 0,
        available: 0,
        windowStart: new Date(Date.UTC(2026, 8, 10, 3)),
        windowEnd: new Date(Date.UTC(2026, 8, 11, 3)),
        byOrg: [],
        alerts: [],
        costUsd: 0,
        ms: 0,
        errors: [],
      },
      "org1",
    );
    expect(payload.pipeline).toBe("none-bucket-shadow");
    expect(payload.ran).toBe(true);
    expect(payload.checked).toBe(0);
    expect(payload.available).toBe(0);
    expect(payload.alerts).toEqual([]);
    expect(String(payload.windowSummary)).toMatch(/re-examined 0 of 0/);
  });

  it("keeps another org's alert out of this org's row", () => {
    const alert = {
      waMessageId: "m0",
      orgId: "orgB",
      authorName: "p0",
      body: "im in",
      createdAt: "2026-09-01T12:00:00.000Z",
      claims: ONE_IN_CLAIM.claims as never,
    };
    const r = {
      enabled: true,
      checked: 2,
      available: 2,
      windowStart: new Date(Date.UTC(2026, 8, 10, 3)),
      windowEnd: new Date(Date.UTC(2026, 8, 11, 3)),
      byOrg: [
        { orgId: "orgA", available: 1, checked: 1, alerts: 0, costUsd: 0.001, ms: 1 },
        { orgId: "orgB", available: 1, checked: 1, alerts: 1, costUsd: 0.001, ms: 1 },
      ],
      alerts: [alert],
      costUsd: 0.002,
      ms: 2,
      errors: [],
    };
    expect(toWindowShape(r, "orgA").alerts).toEqual([]);
    expect(toWindowShape(r, "orgB").alerts).toHaveLength(1);
  });
});

describe("claimsOf", () => {
  it("ignores every non-attendance fact shape", () => {
    expect(claimsOf({ kind: "none" })).toEqual([]);
    expect(
      claimsOf({ kind: "score", red: 1, yellow: 2, reportedBy: null } as never),
    ).toEqual([]);
  });
});
