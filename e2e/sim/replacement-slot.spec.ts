/**
 * A REPLACEMENT TAKES THE DROPPED PLAYER'S SLOT — through the REAL
 * analyze route, against a REAL database.
 *
 * ── THE INCIDENT: Sutton FC, 15 September 2026, kickoff 21:30 ────────
 *
 * Teams generated at 16:41 and announced. Then:
 *
 *   19:14  Wasim  "Salam guys… I feel a fever… If there is someone who
 *                  can take my place, then please do."   → OUT, DROPPED
 *   19:15  Amir   "Shahrokh can play in sha Allah"       → Shahrokh IN
 *
 * BOTH ATTENDANCE WRITES WERE CORRECT. The TEAM SHEET was never touched:
 * Wasim kept his Yellow slot, Shahrokh had none, and the last line-up
 * standing in the group still named a man at home with a fever. Yellow
 * would have turned up with six. MatchTime also posted the fourteen-name
 * squad roster TWICE in a row — once as a reply, once as
 * `announceSquadFullIfJustFilled`'s group post — an hour after the
 * line-ups had gone out.
 *
 * The unit tests settle the rule (`lib/__tests__/team-slot-inherit.test.ts`,
 * `pipeline/__tests__/engine.test.ts` S44) and the copy
 * (`pipeline/__tests__/compose.test.ts`). This file settles the two
 * things only a real request can: that the `TeamAssignment` ROW actually
 * moves, and that the group hears about it exactly once with no DM
 * anywhere.
 *
 * The two messages are posted in TWO SEPARATE BATCHES, which is the
 * harder case and the one a correlation would fail: the Pi flushes a
 * window, and a minute either way makes these two requests with no
 * memory between them. The one-batch shape is covered too, at the bottom.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup } from "./group";
import {
  claim,
  clearExtractorStub,
  clearRouterStub,
  facts,
  otherFacts,
  setExtractorStub,
  setRouterStub,
} from "../helpers/stub";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

// Skipped under MT_SIM_LIVE_LLM=1 for the same reason as the rest of the
// stubbed specs: that flag pins both stub files empty, so there would be
// no way to drive the router and the extractor deterministically.
(LIVE ? test.describe.skip : test.describe)(
  "a replacement inherits the dropped player's slot (2026-09-15)",
  () => {
    test.describe.configure({ mode: "serial" });
    test.beforeAll(resetDb);
    test.afterEach(() => {
      clearRouterStub();
      clearExtractorStub();
    });

    function engineOn(map: Record<string, { route: string; facts?: Record<string, unknown> }>) {
      const bodies: Record<string, string> = {};
      const factBodies: Record<string, Record<string, unknown>> = {};
      for (const [body, v] of Object.entries(map)) {
        bodies[body] = v.route;
        if (v.facts) factBodies[body] = v.facts;
      }
      setRouterStub({ floor: false, bodies });
      setExtractorStub({ bodies: factBodies });
    }

    /** Fourteen confirmed, and the sheet the balancer wrote: the red
     *  block first, then the yellow, with `pete` last in yellow. */
    const FOURTEEN = [
      "owner", "alice", "brian", "pete", "dan", "felix", "greg",
      "henry", "ivan", "jake", "kyle", "liam", "mike", "noah",
    ];
    const SHEET: Record<string, "RED" | "YELLOW"> = {
      owner: "RED", alice: "RED", brian: "RED", dan: "RED",
      felix: "RED", greg: "RED", henry: "RED",
      ivan: "YELLOW", jake: "YELLOW", kyle: "YELLOW", liam: "YELLOW",
      mike: "YELLOW", noah: "YELLOW", pete: "YELLOW",
    };

    /** The messages as they were posted, verbatim. */
    const FEVER =
      "Salam guys, I know this is very late but I had a cold yesterday which was fine " +
      "but today I feel a fever as well and it has been getting worse. It's only started " +
      "affecting me now. If there is someone who can take my place, then please do.\n\n" +
      "If not, I can still come and just play in goal no worries.";
    const REPLACEMENT = "Shahrokh can play in sha Allah";

    const world = (request: Parameters<typeof createGroup>[0], db: Parameters<typeof createGroup>[1]) =>
      createGroup(request, db, {
        maxPlayers: 14,
        // Three hours to kickoff, as it was on the night (19:14 for a
        // 21:30 match). It matters: `enforceProximity` rewrites the word
        // "tonight" in any engine reply for a match that is not, in fact,
        // tonight.
        upcomingMatch: { hoursFromNow: 3, deadlineHoursBeforeKickoff: 0 },
        attendance: FOURTEEN.map((key) => ({ key, status: "CONFIRMED" as const })),
        teams: SHEET,
      });

    test("TONIGHT, IN TWO BATCHES: the replacement ends up in the dropped player's slot", async ({
      request,
      db,
    }) => {
      const g = await world(request, db);

      // ── 19:14 — the drop. Nothing about the sheet yet. ────────────
      engineOn({ [FEVER]: { route: "self_att", facts: facts([claim({ polarity: "out" })]) } });
      const drop = await g.postBatch([{ player: "pete", body: FEVER }]);
      expect((await g.attendanceOf("pete"))?.status).toBe("DROPPED");
      // Today's open-slot sentence (S36c), and only that. A drop with no
      // replacement yet is a hole somebody has to hear about.
      const dropSpeakers = drop.results.filter((r) => (r.reply ?? "").length > 0);
      expect(dropSpeakers).toHaveLength(1);
      expect(dropSpeakers[0].reply).toContain("One slot open");
      expect(drop.groupPosts).toEqual([]);
      expect(drop.dms).toEqual([]);

      // ── 19:15 — the replacement, a separate flush. ────────────────
      engineOn({ [REPLACEMENT]: { route: "other_att", facts: otherFacts("Quinn", "in") } });
      const rep = await g.postBatch([{ player: "alice", body: REPLACEMENT }]);

      expect((await g.attendanceOf("quinn"))?.status).toBe("CONFIRMED");
      expect(await g.counts()).toMatchObject({ confirmed: 14 });

      // THE ROW MOVED. Quinn holds Pete's slot, on Pete's side, in Pete's
      // place on the sheet — and the other thirteen did not move at all.
      const sheet = await g.teamSheet();
      expect(sheet).toEqual([
        ...Object.entries(SHEET)
          .filter(([key]) => key !== "pete")
          .map(([key, team]) => ({ key, team })),
        { key: "quinn", team: "YELLOW" },
      ]);

      // EXACTLY ONE MESSAGE, and it names the swap and re-declares the
      // teams. Not the fourteen-name roster: the owner asked for that to
      // stop once the line-ups are out.
      const speakers = rep.results.filter((r) => (r.reply ?? "").length > 0);
      expect(speakers).toHaveLength(1);
      const reply = speakers[0].reply ?? "";
      expect(reply).toContain("*Pete is out*");
      // "⚽ *Teams for …*" rather than "…for tonight". This reply goes
      // through `enforceProximity`, which rewrites the relative day when
      // the match is not in fact tonight — and a suite that runs late
      // enough in the evening puts a kickoff three hours out on
      // TOMORROW'S date. The day label is the route's business; what
      // this test is about is the sheet and the swap.
      expect(reply).toContain("⚽ *Teams for");
      expect(reply).toContain("(replacing Pete)");
      expect(reply).toContain("Objections? An admin can ask me to regenerate the teams.");
      expect(reply).not.toContain("*Playing:*");
      expect(reply).not.toContain("Based on all the messages");
      expect(reply).not.toContain("[SQUAD]");

      // AND NOTHING ELSE SPOKE. `announceSquadFullIfJustFilled` fired the
      // SECOND roster of the night on 15 September, because the drop had
      // re-armed its dedupe key and the refill tripped it again.
      expect(rep.groupPosts).toEqual([]);
      expect(rep.dms).toEqual([]);
    });

    test("IN ONE BATCH, as the Pi actually flushed them: still one message", async ({
      request,
      db,
    }) => {
      const g = await world(request, db);
      engineOn({
        [FEVER]: { route: "self_att", facts: facts([claim({ polarity: "out" })]) },
        [REPLACEMENT]: { route: "other_att", facts: otherFacts("Quinn", "in") },
      });

      const res = await g.postBatch([
        { player: "pete", body: FEVER },
        { player: "alice", body: REPLACEMENT },
      ]);

      expect((await g.attendanceOf("pete"))?.status).toBe("DROPPED");
      expect((await g.attendanceOf("quinn"))?.status).toBe("CONFIRMED");
      expect(await g.teamSheet()).toContainEqual({ key: "quinn", team: "YELLOW" });

      // ONE speaker. A slot that opens and is refilled in the same batch
      // is one event to the group: "one slot open" beside "Quinn takes
      // his place" is two posts contradicting each other by a line.
      const speakers = res.results.filter((r) => (r.reply ?? "").length > 0);
      expect(speakers).toHaveLength(1);
      expect(speakers[0].reply).toContain("⚽ *Teams for");
      expect(speakers[0].reply).not.toContain("One slot open");
      expect(res.groupPosts).toEqual([]);
      expect(res.dms).toEqual([]);
    });

    test("with the teams out, a squad question is answered with the LINE-UPS", async ({
      request,
      db,
    }) => {
      const g = await world(request, db);
      engineOn({ "@Match Time who's playing?": { route: "question" } });
      setExtractorStub({
        bodies: {
          "@Match Time who's playing?": {
            topic: "squad",
            personRef: null,
            statedCount: null,
          },
        },
      });

      const res = await g.postBatch([{ player: "alice", body: "@Match Time who's playing?" }]);
      const said = res.results.map((r) => r.reply ?? "").join("\n") + res.groupPosts.join("\n");
      expect(said).toContain("⚽ *Teams for");
      expect(said).not.toContain("*Playing:*");
      expect(res.dms).toEqual([]);
    });

    test("BEFORE the teams exist, everything is exactly as it is today", async ({
      request,
      db,
    }) => {
      // THE REGRESSION THAT MATTERS. Same two messages, same order, no
      // sheet: nobody is reassigned, and the roster post is the roster.
      const g = await createGroup(request, db, {
        maxPlayers: 14,
        upcomingMatch: { hoursFromNow: 3, deadlineHoursBeforeKickoff: 0 },
        attendance: FOURTEEN.map((key) => ({ key, status: "CONFIRMED" as const })),
      });
      engineOn({
        [FEVER]: { route: "self_att", facts: facts([claim({ polarity: "out" })]) },
        [REPLACEMENT]: { route: "other_att", facts: otherFacts("Quinn", "in") },
      });

      const res = await g.postBatch([
        { player: "pete", body: FEVER },
        { player: "alice", body: REPLACEMENT },
      ]);

      expect((await g.attendanceOf("quinn"))?.status).toBe("CONFIRMED");
      expect(await g.teamSheet()).toEqual([]);
      const said = res.results.map((r) => r.reply ?? "").join("\n");
      expect(said).toContain("*Playing:*");
      expect(said).not.toContain("⚽ *Teams for");
      expect(res.dms).toEqual([]);
    });
  },
);
