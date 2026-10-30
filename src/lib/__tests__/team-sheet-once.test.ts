/**
 * ONE TEAM SHEET PER SET OF TEAMS (2026-10-30, FNF HQ, 29 Oct).
 *
 * The team sheet image went out twice in a row with the same teams:
 *
 *   18:09:13  the approval queued its team sheet ("auto"); "Make a graphic"
 *             at 18:09:34 queued a second ("asked"). Both were due on the
 *             same poll (claimed 18:09:42.325 and 18:09:42.471): two images.
 *   19:22:51  a swap queued the redraw ("auto"), its quiet period pushed to
 *             19:26:26 by the swaps after it; "Graphic please" at 19:24:56
 *             queued an "asked" one, sent 19:25:18; the redraw then went at
 *             19:26:49 showing the same teams.
 *
 * #468 made a request send the WAITING sheet instead of queuing a second.
 * On top of that, a team sheet whose teams are exactly those of the last
 * one actually drawn for the Pi is not sent again automatically, and an
 * admin asking within 10 minutes is told the teams have not changed.
 *
 * These tests run the real functions over a small in-memory BotJob and
 * SentNotification store, with the teams as a variable, and a `poll` that
 * does what the due-posts poll and the Pi do: emit the due jobs (with the
 * verdict), then fetch each emitted image, which records what it showed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Job = { id: string; orgId: string; kind: string; text: string; pollOptions: string[]; sendAfter: Date | null; sentAt: Date | null; createdAt: Date };
type Note = { key: string; kind: string; text: string | null; createdAt: Date };

const store = vi.hoisted(() => ({ jobs: [] as Job[], notes: [] as Note[], clock: new Date(0), seq: 0 }));

function matchesWhere(j: Job, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "pollOptions") {
      const every = (v as { hasEvery: string[] }).hasEvery;
      if (!every.every((x) => j.pollOptions.includes(x))) return false;
    } else if ((j as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn() },
  sentNotification: {
    create: vi.fn(async ({ data }: { data: { key: string; kind: string; text?: string } }) => {
      if (store.notes.some((n) => n.key === data.key)) throw new Error("P2002");
      store.notes.push({ key: data.key, kind: data.kind, text: data.text ?? null, createdAt: new Date(store.clock) });
      return {};
    }),
    findFirst: vi.fn(async ({ where }: { where: { kind: string; key: { startsWith: string } } }) => {
      const rows = store.notes
        .filter((n) => n.kind === where.kind && n.key.startsWith(where.key.startsWith))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return rows[0] ?? null;
    }),
  },
  botJob: {
    create: vi.fn(async ({ data }: { data: Partial<Job> }) => {
      const job: Job = { id: `job-${++store.seq}`, orgId: data.orgId!, kind: data.kind!, text: data.text!, pollOptions: data.pollOptions ?? [], sendAfter: data.sendAfter ?? null, sentAt: null, createdAt: new Date(store.clock) };
      store.jobs.push(job);
      return job;
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const rows = store.jobs.filter((j) => matchesWhere(j, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return rows[0] ?? null;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Job> }) => {
      const rows = store.jobs.filter((j) => matchesWhere(j, where));
      for (const j of rows) Object.assign(j, data);
      return { count: rows.length };
    }),
  },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

const teams = vi.hoisted(() => ({ red: [] as string[], yellow: [] as string[] }));
vi.mock("@/lib/match-graphics", async () => {
  const real = await vi.importActual<typeof import("../match-graphics")>("../match-graphics");
  return {
    teamSheetFingerprint: real.teamSheetFingerprint,
    nextGraphicMatch: vi.fn(async () => "m-1"),
    loadGraphicData: vi.fn(async (t: { kind: string }) => {
      if (t.kind !== "teams") return null;
      const labels: [string, string] = ["Non Bibs", "Bibs"];
      return {
        kind: "teams",
        clubName: "FNF",
        lang: "en",
        matchDate: DATE,
        kickoff: "20:30",
        venue: "Harris Merton",
        teams: [
          { label: labels[0], names: [...teams.red] },
          { label: labels[1], names: [...teams.yellow] },
        ],
        fingerprint: real.teamSheetFingerprint({ labels, red: teams.red, yellow: teams.yellow, matchDate: DATE, venue: "Harris Merton" }),
      };
    }),
  };
});
vi.mock("@/lib/group-postability-store", () => ({ isGroupPostable: vi.fn(async () => true) }));

import {
  SAME_SHEET_RESEND_MS,
  answerGraphicRequest,
  recordTeamSheetShown,
  sendGraphicToAdminChannel,
  teamSheetJobVerdict,
} from "../admin-group-graphics";
import { loadGraphicData } from "../match-graphics";
import { readGraphicJob } from "../graphic-job";

const DATE = new Date("2026-10-30T20:30:00Z");
const at = (hhmmss: string) => new Date(`2026-10-29T${hhmmss}Z`);

function swap(a: string, b: string) {
  const inRed = (x: string) => teams.red.includes(x);
  const side = (x: string) => (inRed(x) ? teams.red : teams.yellow);
  const sa = side(a);
  const sb = side(b);
  if (sa === sb) return;
  sa.splice(sa.indexOf(a), 1, b);
  sb.splice(sb.indexOf(b), 1, a);
}

/** One due-posts poll and what the Pi then does: each emitted image is fetched (and so recorded). */
async function poll(now: Date): Promise<string[]> {
  store.clock = now;
  const due = store.jobs
    .filter((j) => j.sentAt === null && (j.sendAfter === null || j.sendAfter.getTime() <= now.getTime()))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const emitted = new Set<string>();
  const sent: string[] = [];
  for (const job of due) {
    const verdict = await teamSheetJobVerdict({ job, orgId: "org-fnf", now, emitted });
    if (verdict !== "send") continue;
    const g = readGraphicJob(job.pollOptions);
    if (g) emitted.add(g.matchId);
    sent.push(job.id);
  }
  for (const id of sent) {
    const job = store.jobs.find((j) => j.id === id)!;
    const g = readGraphicJob(job.pollOptions)!;
    // The Pi fetches the image: /api/graphics/<token> draws and records it.
    const data = await loadGraphicData({ orgId: "org-fnf", matchId: g.matchId, kind: g.kind });
    if (data && data.kind === "teams") await recordTeamSheetShown(g.matchId, data.fingerprint!, now);
    // ... posts it, and acks.
    job.sentAt = new Date(now.getTime() + 5_000);
  }
  return sent;
}

const sheetsSent = () => store.jobs.filter((j) => j.sentAt && !j.pollOptions.includes("skipped:same-teams"));
const ask = (now: Date, lang = "en") => {
  store.clock = now;
  return answerGraphicRequest({ orgId: "org-fnf", lang, kind: "teams", now });
};

beforeEach(() => {
  store.jobs = [];
  store.notes = [];
  store.seq = 0;
  teams.red = ["Feroz", "Alamgir", "Rafi", "Hamza", "Mo"];
  teams.yellow = ["Yorel", "Akram", "Shehryar", "Hamzah", "Imz"];
  dbMock.organisation.findUnique.mockResolvedValue({ id: "org-fnf", name: "FNF", language: "en", adminGroupId: "hq@g.us" });
});

describe("29 Oct, 18:09: the approval's team sheet, then 'Make a graphic' 21 seconds later", () => {
  it("one image", async () => {
    store.clock = at("18:09:13");
    await sendGraphicToAdminChannel("org-fnf", "m-1", "teams", { onceKey: "m-1:teams-approved" });
    expect(await ask(at("18:09:34"))).toEqual({ outcome: "graphic-queued", replyText: null });
    // #468: the request takes over the waiting sheet; no second job.
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0].pollOptions).toEqual(["graphic:v1", "teams", "m-1", "asked"]);
    await poll(at("18:09:42"));
    await poll(at("18:10:12"));
    expect(sheetsSent()).toHaveLength(1);
  });
});

describe("29 Oct, 19:22 to 19:26: nine swaps, then 'Graphic please'", () => {
  it("one image, showing the teams after the last swap; nothing goes on its own (Kemal, 2026-10-30)", async () => {
    // The sheet already sent at 19:20.
    store.clock = at("19:20:13");
    await sendGraphicToAdminChannel("org-fnf", "m-1", "teams", { asked: true });
    await poll(at("19:20:13"));
    const swaps: Array<[string, string, string]> = [
      ["19:22:51", "Feroz", "Yorel"],
      ["19:22:59", "Alamgir", "Shehryar"],
      ["19:23:40", "Rafi", "Hamzah"],
      ["19:24:26", "Hamza", "Akram"],
    ];
    for (const [t, a, b] of swaps) {
      swap(a, b);
      // A change queues no picture any more.
      expect(await poll(at(t))).toEqual([]);
    }
    expect(store.jobs).toHaveLength(1);
    expect(await ask(at("19:24:56"))).toEqual({ outcome: "graphic-queued", replyText: null });
    expect(store.jobs).toHaveLength(2);
    expect(store.jobs[1]).toMatchObject({ pollOptions: ["graphic:v1", "teams", "m-1", "asked"] });
    expect(await poll(at("19:25:12"))).toEqual([store.jobs[1].id]);
    await poll(at("19:26:44"));
    expect(sheetsSent()).toHaveLength(2); // 19:20's and the one asked for
    expect(store.jobs.filter((j) => j.sentAt === null)).toHaveLength(0);
  });
});

// No caller queues a team sheet on its own any more (Kemal, 2026-10-30);
// the rule is kept for any job that is not asked for.
const queueUnasked = (now: Date) => {
  store.clock = now;
  return sendGraphicToAdminChannel("org-fnf", "m-1", "teams");
};

describe("a sheet whose teams equal the last one drawn is not sent unasked", () => {
  async function firstSheet() {
    store.clock = at("19:00:00");
    await sendGraphicToAdminChannel("org-fnf", "m-1", "teams");
    await poll(at("19:00:10"));
  }

  it("two changes that cancel out before the next poll: no second image, the job closed as skipped", async () => {
    await firstSheet();
    swap("Mo", "Hamzah");
    await queueUnasked(at("19:10:18"));
    swap("Mo", "Hamzah");
    await queueUnasked(at("19:11:00"));
    expect(await poll(at("19:13:30"))).toEqual([]);
    expect(sheetsSent()).toHaveLength(1);
    const skipped = store.jobs.find((j) => j.pollOptions.includes("skipped:same-teams"));
    expect(skipped?.sentAt).toEqual(at("19:13:30"));
  });

  it("a change that stands: the sheet goes", async () => {
    await firstSheet();
    swap("Mo", "Hamzah");
    await queueUnasked(at("19:10:18"));
    expect(await poll(at("19:12:30"))).toHaveLength(1);
    expect(sheetsSent()).toHaveLength(2);
  });

  it("swapped at 19:10 and back at 19:17 (29 Oct): each sheet differs from the one before it, so both go", async () => {
    await firstSheet();
    swap("Mo", "Hamzah");
    await queueUnasked(at("19:10:18"));
    await poll(at("19:12:30"));
    swap("Mo", "Hamzah");
    await queueUnasked(at("19:17:48"));
    await poll(at("19:20:13"));
    expect(sheetsSent()).toHaveLength(3);
  });

  it("the label of a side changed: a different sheet", async () => {
    await firstSheet();
    const real = await vi.importActual<typeof import("../match-graphics")>("../match-graphics");
    const base = { red: ["a", "b"], yellow: ["c", "d"], matchDate: DATE, venue: "V" };
    expect(real.teamSheetFingerprint({ ...base, labels: ["Red", "Yellow"] })).not.toEqual(real.teamSheetFingerprint({ ...base, labels: ["Non Bibs", "Bibs"] }));
  });
});

describe("an admin asks for the team sheet just after the same one went out", () => {
  beforeEach(async () => {
    store.clock = at("19:00:00");
    await sendGraphicToAdminChannel("org-fnf", "m-1", "teams");
    await poll(at("19:00:10"));
  });

  it("within 10 minutes: no second image, one short line saying the teams have not changed (EN and TR)", async () => {
    expect(await ask(at("19:04:00"))).toEqual({
      outcome: "graphic-unchanged",
      replyText: "The teams have not changed since the team sheet I just posted.",
    });
    expect((await ask(at("19:05:00"), "tr")).replyText).toBe("Takımlar, az önce gönderdiğim takım görselinden beri değişmedi.");
    await poll(at("19:05:30"));
    expect(sheetsSent()).toHaveLength(1);
    expect(store.jobs).toHaveLength(1);
  });

  it("more than 10 minutes later: it may have scrolled away, so it is sent again", async () => {
    const later = new Date(at("19:00:10").getTime() + SAME_SHEET_RESEND_MS + 1_000);
    expect(await ask(later)).toEqual({ outcome: "graphic-queued", replyText: null });
    await poll(new Date(later.getTime() + 10_000));
    expect(sheetsSent()).toHaveLength(2);
  });

  it("the teams changed since: the new sheet is sent at once", async () => {
    swap("Mo", "Hamzah");
    expect(await ask(at("19:04:00"))).toEqual({ outcome: "graphic-queued", replyText: null });
    await poll(at("19:04:10"));
    expect(sheetsSent()).toHaveLength(2);
  });

  it("an asked sheet queued while the same one was still in flight is skipped quietly (the image is just above)", async () => {
    store.clock = at("19:03:00");
    await dbMock.botJob.create({ data: { orgId: "org-fnf", kind: "admin-group", text: "Ready to post", pollOptions: ["graphic:v1", "teams", "m-1", "asked"] } });
    expect(await poll(at("19:03:10"))).toEqual([]);
    expect(sheetsSent()).toHaveLength(1);
  });
});

describe("teamSheetJobVerdict", () => {
  const job = (how: "asked" | "auto", kind = "teams") => ({ id: "j", pollOptions: ["graphic:v1", kind, "m-1", how] });

  it("two team sheets for one match due on the same poll: the second waits for the next poll", async () => {
    const emitted = new Set(["m-1"]);
    expect(await teamSheetJobVerdict({ job: job("auto"), orgId: "org-fnf", now: at("19:00:00"), emitted })).toBe("hold");
    expect(dbMock.botJob.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: "j", sentAt: null } }));
  });

  it("nothing drawn yet for the match: send", async () => {
    expect(await teamSheetJobVerdict({ job: job("auto"), orgId: "org-fnf", now: at("19:00:00"), emitted: new Set() })).toBe("send");
  });

  it("the list poster, or any other job: send, nothing read", async () => {
    vi.mocked(loadGraphicData).mockClear();
    expect(await teamSheetJobVerdict({ job: job("auto", "list"), orgId: "org-fnf", now: at("19:00:00"), emitted: new Set(["m-1"]) })).toBe("send");
    expect(await teamSheetJobVerdict({ job: { id: "x", pollOptions: [] }, orgId: "org-fnf", now: at("19:00:00"), emitted: new Set() })).toBe("send");
    expect(loadGraphicData).not.toHaveBeenCalled();
  });
});
