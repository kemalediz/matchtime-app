/**
 * THE SQUAD ANSWER SAYS WHICH MATCH IT IS ABOUT (FNF, 2026-10-23).
 *
 * FNF's Friday 23 Oct game was cancelled on the 22nd. At 09:51 UTC on the
 * 23rd a player asked HQ "What's the list @Match Time" and got
 * "📋 Based on all the messages I've picked up, here's the latest squad:
 * 18/18 ✅ full squad." That was the 30 Oct squad (the rolling squad had
 * seeded it from 16 Oct), but nothing said so and everyone read it as
 * that night's game.
 *
 * Now every squad-status post names its match ("for *Fri 30 Oct, 20:30*")
 * and, when this week's match is cancelled (`SquadState.cancelledMatch`,
 * `cancelled-match-notice.ts`), leads with that. Deterministic copy only:
 * no prompt, no model.
 */
import { describe, it, expect } from "vitest";
import { compose } from "../pipeline/compose";
import type { EngineResult, SpeechIntent, SquadState } from "../pipeline/types";
import { world } from "../pipeline/__tests__/helpers";
import {
  SQUAD_POST_MARKER,
  composeSquadStateReply,
  composeSquadStatusPost,
  contradictsSquadState,
  displaysSquadState,
} from "../group-copy";

const ELEVEN = ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "adam", "efat", "usama"];
const FOURTEEN = [...ELEVEN, "karahan", "zair", "wasim"];

function say(state: SquadState, ...speech: SpeechIntent[]): string[] {
  const result: EngineResult = { outcomes: [], writes: [], nextState: state, speech, degradations: [] };
  return compose(result).utterances.map((u) => u.text);
}

/** What `load-state.ts` sets for FNF on the morning of 23 Oct. */
function fnf(over: Parameters<typeof world>[0] = {}, lang: "en" | "tr" = "en"): SquadState {
  const w = world({ ...over, features: { language: lang } });
  w.matchLabel = lang === "tr" ? "30 Ekim Cuma 20:30" : "Fri 30 Oct, 20:30";
  w.cancelledMatch = { id: "m23", dayLabel: lang === "tr" ? "23 Ekim Cuma" : "Fri 23 Oct" };
  return w;
}

describe("composeSquadStatusPost names the match", () => {
  it("EN, a normal week", () => {
    const text = composeSquadStatusPost({ confirmed: ["A", "B"], bench: [], maxPlayers: 2, matchLabel: "Fri 30 Oct, 20:30" });
    expect(text.split("\n")[0]).toBe("📋 Here's the squad for *Fri 30 Oct, 20:30*: *2/2* ✅ full squad.");
  });

  it("EN, with a bench and places open", () => {
    const text = composeSquadStatusPost({ confirmed: ["A"], bench: ["C"], maxPlayers: 3, matchLabel: "Fri 30 Oct, 20:30" });
    expect(text.split("\n")[0]).toBe("📋 Here's the squad and bench for *Fri 30 Oct, 20:30*: *1/3*, need *2 more* 🙏");
  });

  it("EN, a cancelled week leads with the cancellation", () => {
    const text = composeSquadStatusPost({
      confirmed: ["A", "B"],
      bench: [],
      maxPlayers: 2,
      matchLabel: "Fri 30 Oct, 20:30",
      cancelledDayLabel: "Fri 23 Oct",
    });
    expect(text).toMatch(/^❌ The match on \*Fri 23 Oct\* is cancelled\.\n\n📋 Here's the squad for \*Fri 30 Oct, 20:30\*: \*2\/2\* ✅ full squad\.\n\n\*Playing:\*\n1\. A\n2\. B$/);
  });

  it("TR, a normal week and a cancelled week", () => {
    const normal = composeSquadStatusPost({ confirmed: ["A"], bench: ["C"], maxPlayers: 3, matchLabel: "30 Ekim Cuma 20:30", lang: "tr" });
    expect(normal.split("\n")[0]).toBe("📋 *30 Ekim Cuma 20:30* maçının kadrosu ve yedekleri: *1/3*, *2 kişi daha* lazım 🙏");
    const off = composeSquadStatusPost({
      confirmed: ["A", "B"],
      bench: [],
      maxPlayers: 2,
      matchLabel: "30 Ekim Cuma 20:30",
      cancelledDayLabel: "23 Ekim Cuma",
      lang: "tr",
    });
    expect(off).toMatch(/^❌ \*23 Ekim Cuma\* maçı iptal edildi\.\n\n📋 \*30 Ekim Cuma 20:30\* maçının kadrosu: \*2\/2\* ✅ kadro tamam\.\n\n\*Oynayanlar:\*/);
  });

  it("no label given: the post reads as it always has", () => {
    const text = composeSquadStatusPost({ confirmed: ["A"], bench: [], maxPlayers: 2 });
    expect(text.split("\n")[0]).toBe("📋 Based on all the messages I've picked up, here's the latest squad: *1/2*, need *1 more* 🙏");
  });

  it("no dashes and no greeting in any new line", () => {
    for (const lang of ["en", "tr"] as const) {
      const text = composeSquadStatusPost({ confirmed: ["A"], bench: ["B"], maxPlayers: 2, matchLabel: "X", cancelledDayLabel: "Y", lang });
      expect(text).not.toMatch(/[–—]/);
      expect(text).not.toMatch(/\b(?:morning|evening|hello|hi)\b|günaydın|merhaba/i);
    }
  });

  it("the guards still read the new post as squad state and find no contradiction in its dates", () => {
    for (const lang of ["en", "tr"] as const) {
      const confirmed = Array.from({ length: 18 }, (_, i) => `P${i + 1}`);
      const text = composeSquadStatusPost({
        confirmed,
        bench: [],
        maxPlayers: 18,
        matchLabel: lang === "tr" ? "30 Ekim Cuma 20:30" : "Fri 30 Oct, 20:30",
        cancelledDayLabel: lang === "tr" ? "23 Ekim Cuma" : "Fri 23 Oct",
        lang,
      });
      expect(displaysSquadState(text, lang)).toBe(true);
      expect(contradictsSquadState(text, { confirmed, bench: [], maxPlayers: 18 }, lang)).toBe(false);
    }
  });
});

describe("compose(): the incident, through the composer HQ and the players' group share", () => {
  it("HQ (organisers), 'what's the list' on the cancelled day: cancelled first, then the dated squad", () => {
    const w = fnf({ confirmed: FOURTEEN });
    w.forOrganisers = true;
    const text = say(w, { kind: "answer_squad", messageId: "m" })[0];
    expect(text).toMatch(/^❌ The match on \*Fri 23 Oct\* is cancelled\.\n\n📋 Here's the squad for \*Fri 30 Oct, 20:30\*: \*14\/14\* ✅ full squad\./);
    expect(text).toContain("Nobody's on the bench right now.");
  });

  it("players' group squad_status, Turkish", () => {
    const text = say(fnf({ confirmed: ELEVEN, bench: ["erdal"] }, "tr"), { kind: "squad_status", messageId: null })[0];
    expect(text).toMatch(/^❌ \*23 Ekim Cuma\* maçı iptal edildi\.\n\n📋 \*30 Ekim Cuma 20:30\* maçının kadrosu ve yedekleri: \*11\/14\*, \*3 kişi daha\* lazım 🙏/);
  });

  it("a normal week: dated, no cancellation line", () => {
    const w = fnf({ confirmed: FOURTEEN });
    w.cancelledMatch = null;
    const text = say(w, { kind: "squad_status", messageId: null })[0];
    expect(text.startsWith("📋 Here's the squad for *Fri 30 Oct, 20:30*: *14/14* ✅ full squad.")).toBe(true);
  });

  it("teams already out: the line-ups as before, with the cancellation line above them", () => {
    const teams: Record<string, "RED" | "YELLOW"> = {};
    FOURTEEN.forEach((k, i) => (teams[k] = i % 2 === 0 ? "RED" : "YELLOW"));
    const text = say(fnf({ confirmed: FOURTEEN, teams }), { kind: "squad_status", messageId: null })[0];
    expect(text).toMatch(/^❌ The match on \*Fri 23 Oct\* is cancelled\.\n\n⚽ \*Teams for tonight\*/);
    expect(text).not.toContain("*Playing:*");
    const normal = fnf({ confirmed: FOURTEEN, teams });
    normal.cancelledMatch = null;
    expect(say(normal, { kind: "squad_status", messageId: null })[0]).toMatch(/^⚽ \*Teams for tonight\*/);
  });
});

describe("composeSquadStateReply (the analyze route's pass) carries the same lines", () => {
  it("the squad marker becomes the dated post with the cancellation", () => {
    const out = composeSquadStateReply(
      SQUAD_POST_MARKER,
      { confirmed: ["A", "B"], bench: [], maxPlayers: 2, matchLabel: "Fri 30 Oct, 20:30", cancelledDayLabel: "Fri 23 Oct" },
      "en",
    );
    expect(out.composed).toBe(true);
    expect(out.text).toMatch(/^❌ The match on \*Fri 23 Oct\* is cancelled\.\n\n📋 Here's the squad for \*Fri 30 Oct, 20:30\*/);
  });
});
