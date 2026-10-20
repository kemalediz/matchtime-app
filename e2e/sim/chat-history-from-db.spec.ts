/**
 * THE RECENT CHAT SURVIVES A PI RESTART, through the REAL analyze route
 * and a REAL database (Kemal, 2026-10-20).
 *
 * The Pi used to be the only source of the extractors' RECENT CHAT, from
 * memory, so a restart emptied it (FNF, 10:26:59 UTC: two lines left
 * when Naim's OUT was read). The route now builds it from the group's
 * stored messages (`lib/group-chat-history.ts`). These specs post an
 * earlier batch, then a batch with NO history (what a freshly restarted
 * Pi sends), and read what the stubbed extractor was shown.
 */
import { readFileSync } from "node:fs";
import { test, expect, resetDb } from "../fixtures";
import { createGroup } from "./group";
import { clearExtractorStub, clearRouterStub, selfOut } from "../helpers/stub";
import { E2E } from "../helpers/env";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

function extractorCalls(): Array<{ label: string; user: string }> {
  try {
    return readFileSync(`${E2E.EXTRACTOR_STUB_FILE}.calls`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { label: string; user: string });
  } catch {
    return [];
  }
}

/** The RECENT CHAT block of a user turn, one entry per line shown. */
function recentChatOf(user: string): string[] {
  const head = user.split("\n");
  const start = head.findIndex((l) => l.startsWith("RECENT CHAT"));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of head.slice(start + 1)) {
    if (!l.startsWith("  ")) break;
    out.push(l.trim());
  }
  return out;
}

(LIVE ? test.describe.skip : test.describe)("the extractors' recent chat, from the database", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);
  test.beforeEach(() => clearExtractorStub());
  test.afterEach(() => {
    clearRouterStub();
    clearExtractorStub();
  });

  test("after a Pi restart (no history sent) the stored lines are still there, own line excluded, no duplicates", async ({ request, db }) => {
    const g = await createGroup(request, db, {
      attendance: [
        { key: "dan", status: "CONFIRMED" as const },
        { key: "pete", status: "CONFIRMED" as const },
      ],
    });
    const dan = g.player("dan").name;
    const pete = g.player("pete").name;

    // An earlier batch the server analysed and stored.
    await g.postBatch([
      { player: "dan", body: "who's playing tonight lads", route: "none" },
      { player: "pete", body: "hamstring is tight, see how it goes", route: "none" },
    ]);

    // The Pi has just restarted: its buffer is empty, so no history at all.
    const res = await g.postBatch([
      { player: "pete", body: "@Match Time out", tag: true, route: "self_att", facts: selfOut() },
    ]);
    expect(res.results[0].react).toBe("👋");
    expect((await g.attendanceOf("pete"))?.status).toBe("DROPPED");

    const call = extractorCalls().find((c) => c.user.endsWith("@Match Time out"));
    expect(call, "the attendance extractor was called for Pete's OUT").toBeTruthy();
    const recent = recentChatOf(call!.user);
    expect(recent).toEqual([`${dan}: who's playing tonight lads`, `${pete}: hamstring is tight, see how it goes`]);
    expect(call!.user).toContain(`THE MESSAGE (from ${pete}`);
  });

  test("with the Pi's history as well, each line is shown once and the sender's own line is not", async ({ request, db }) => {
    const g = await createGroup(request, db, {
      attendance: [
        { key: "dan", status: "CONFIRMED" as const },
        { key: "pete", status: "CONFIRMED" as const },
      ],
    });
    const dan = g.player("dan").name;
    const first = await g.postBatch([{ player: "dan", body: "who's playing tonight lads", route: "none" }]);
    expect(first.results).toHaveLength(1);

    // The Pi still has Dan's line (and, being a Pi, its own copy of the
    // batch message, recorded before the flush with the same timestamp).
    const res = await g.postBatch(
      [{ player: "pete", body: "@Match Time out", tag: true, route: "self_att", facts: selfOut() }],
      { history: [{ authorName: dan, body: "who's playing tonight lads", timestamp: new Date(Date.now() - 30_000).toISOString() }] },
    );
    expect(res.results[0].react).toBe("👋");

    const call = extractorCalls().find((c) => c.user.endsWith("@Match Time out"));
    expect(recentChatOf(call!.user)).toEqual([`${dan}: who's playing tonight lads`]);
  });
});
