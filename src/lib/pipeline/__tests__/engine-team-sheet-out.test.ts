/**
 * AN UNSURE OUT NEVER TAKES A PLAYER OFF A PUBLISHED TEAM SHEET
 * (Sutton FC, 2026-10-20 14:49 UTC).
 *
 * Teams were out for that night's match. Kieran, confirmed and on Yellow,
 * replied untagged to "Mojib Habib and Kieran on same side" with "I've got a
 * bad hamstring so taking it easy". The attendance extractor (the old prompt,
 * Sonnet 5) returned a sender OUT, basis decision, at confidence 0.75: over
 * the 0.7 floor. The engine dropped him, reacted 👋, told the group "A slot
 * just opened on Yellow (replacing Kieran)", tagged the bench and queued a
 * recruit DM. He had said nothing about not playing.
 *
 * The prompt is the fix (an injury is not an out). This is the net under it,
 * and it reads only the model's own field and the club's state, never the
 * words: an UNTAGGED OUT from the SENDER, about a place on a PUBLISHED team
 * sheet, needs confidence of at least 0.85. Measured on 2026-10-20 (dev key,
 * old and new prompts, Sonnet 5 and Haiku 5.5): every untagged out that
 * said so came back at 0.9 or more; the incident came back at 0.75 three
 * times of three. A tagged OUT, an OUT
 * before the teams are out, and the leaving half of a stated replacement
 * keep the 0.7 floor.
 */
import { describe, it, expect } from "vitest";
import { decide, TEAM_SHEET_OUT_CONFIDENCE } from "../engine";
import { NOW, SUTTON, attendanceFacts, claim, msg, statusOf, world } from "./helpers";
import type { Claim, ProposedWrite } from "../types";

const CONFIRMED = ["kemal", "sait", "mustafa", "abid", "najib", "zeeshan", "faris", "wasim", "habib", "mojib", "idris", "adam", "efat", "usama"];
const TEAMS = Object.fromEntries(CONFIRMED.map((k, i) => [k, i % 2 ? "YELLOW" : "RED"])) as Record<string, "RED" | "YELLOW">;
const BODY = "I’ve got a bad hamstring so taking it easy";

function attWrites(writes: ProposedWrite[]) {
  return writes.filter((w) => w.kind === "attendance");
}

function run(claims: Claim[], o: { tagged?: boolean; teams?: boolean; body?: string; from?: string } = {}) {
  const state = world({
    players: [...SUTTON],
    confirmed: CONFIRMED,
    bench: ["erdal"],
    teams: o.teams === false ? undefined : TEAMS,
  });
  return decide({
    now: NOW,
    state,
    messages: [
      msg({
        id: "wa-1",
        from: o.from ?? "habib",
        body: o.body ?? BODY,
        tagged: o.tagged ?? false,
        route: "unsure",
        facts: attendanceFacts(claims),
      }),
    ],
  });
}

const theIncidentOut = (confidence = 0.75) => claim({ polarity: "out", basis: "decision", confidence });

describe("the incident: an untagged, unsure OUT from a player on the team sheet holds", () => {
  it("the bar is 0.85", () => {
    expect(TEAM_SHEET_OUT_CONFIDENCE).toBe(0.85);
  });

  it("the 0.75 OUT writes nothing, keeps him CONFIRMED, says nothing and reacts nothing", () => {
    const r = run([theIncidentOut()]);
    expect(attWrites(r.writes)).toHaveLength(0);
    expect(statusOf(r.nextState, "habib")).toBe("CONFIRMED");
    expect(r.speech).toEqual([]);
    const o = r.outcomes[0];
    expect(o.react).toBeNull();
    expect(o.reasons.join(" | ")).toMatch(/published team sheet/);
  });

  it("just under the bar holds too", () => {
    const r = run([theIncidentOut(0.84)]);
    expect(attWrites(r.writes)).toHaveLength(0);
    expect(statusOf(r.nextState, "habib")).toBe("CONFIRMED");
  });
});

describe("what the net leaves alone", () => {
  it("a sure untagged OUT still drops him and opens the slot", () => {
    const r = run([theIncidentOut(0.95)], { body: "hamstring's gone, can't make it tonight" });
    expect(statusOf(r.nextState, "habib")).toBe("DROPPED");
    expect(r.outcomes[0].react).toBe("👋");
  });

  it("at exactly the bar it drops", () => {
    const r = run([theIncidentOut(0.85)], { body: "can't make it" });
    expect(statusOf(r.nextState, "habib")).toBe("DROPPED");
  });

  it("a TAGGED OUT keeps the 0.7 floor", () => {
    const r = run([theIncidentOut(0.75)], { tagged: true, body: "@Match Time out" });
    expect(statusOf(r.nextState, "habib")).toBe("DROPPED");
  });

  it("before the teams are out it keeps the 0.7 floor", () => {
    const r = run([theIncidentOut(0.75)], { teams: false, body: "can't make it" });
    expect(statusOf(r.nextState, "habib")).toBe("DROPPED");
  });

  it("an OUT about someone else is not this rule's business", () => {
    // Kemal (an admin) reports Habib out at 0.75: the third-party path and
    // its own rules decide, exactly as before.
    const r = run([claim({ subject: "other", personRef: "Habib", personNamed: true, polarity: "out", confidence: 0.75 })], {
      from: "kemal",
      body: "Habib can't make it",
    });
    expect(statusOf(r.nextState, "habib")).toBe("DROPPED");
  });

  it("the leaving half of a stated replacement keeps the 0.7 floor", () => {
    // "Mojib will play in my place", untagged, from Habib: the in claim
    // names who leaves, so the pair carries itself.
    const state = world({
      players: [...SUTTON],
      confirmed: CONFIRMED.filter((k) => k !== "mojib"),
      teams: Object.fromEntries(Object.entries(TEAMS).filter(([k]) => k !== "mojib")),
    });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({
          id: "wa-1",
          from: "habib",
          body: "Mojib will play in my place",
          route: "other_att",
          facts: attendanceFacts([
            claim({ subject: "other", personRef: "Mojib", personNamed: true, polarity: "in", replaces: "me", confidence: 0.85 }),
            claim({ polarity: "out", confidence: 0.8 }),
          ]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "habib")).toBe("DROPPED");
    expect(statusOf(r.nextState, "mojib")).toBe("CONFIRMED");
  });
});
