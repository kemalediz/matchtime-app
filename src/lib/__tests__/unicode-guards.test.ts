/**
 * The composition guards and the Turkish stats answer.
 *
 * `displaysSquadState` rule (a) treats any run of two or more numbered
 * lines as a roster and `composeSquadStateReply` then REPLACES the
 * reply with the squad post. A stats answer is a numbered list too, and
 * `isLeaderboardLine` is the one thing that tells them apart: an em
 * dash separator, a percentage, an "N/M (" pattern, or the words
 * wins / votes / matches. The English stats row carries "matches" (its
 * em dash was retired on 2026-09-23, house style).
 *
 * The Turkish stats row (`stats_apps_row` in strings.tr.ts) carries
 * no dash, by house style, and so must carry the Turkish noun instead:
 * "4 maç". This file pins that `isLeaderboardLine` knows "maç",
 * "galibiyet" and "oy", written with `\p{L}` lookarounds rather than
 * `\b` (which is ASCII-only and never ends on "ç"). Without this a
 * Turkish "most consistent" answer would be swallowed and the group
 * would get the upcoming squad list instead, the 2026-05-14 incident
 * in a second language.
 *
 * The English verdicts below are unchanged from `squad-state-composition.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { composeSquadStateReply, displaysSquadState } from "../group-copy";
import { t } from "../i18n/t";

const truth = { confirmed: ["Kemal Ediz", "Elvin Aliyev"], bench: [], maxPlayers: 14 };

describe("isLeaderboardLine knows the Turkish stats nouns", () => {
  it("a Turkish stats answer is not squad state", () => {
    // The shape the deleted stats table rendered, and a unified answer's
    // table still takes (2026-11-18).
    const text = ["En çok maça çıkanlar (son 1 ay):", "1. Kemal Ediz: 4 maç", "2. Elvin Aliyev: 3 maç", "3. Çağrı Yılmaz: 1 maç"].join("\n");
    expect(displaysSquadState(text)).toBe(false);
    expect(composeSquadStateReply(text, truth, "tr")).toEqual({ text, composed: false });
  });

  it("galibiyet and oy rows are leaderboard rows too", () => {
    expect(displaysSquadState("1. Kemal Ediz: 2 galibiyet\n2. Elvin Aliyev: 1 galibiyet")).toBe(false);
    expect(displaysSquadState("1. Kemal Ediz: 6 oy\n2. Elvin Aliyev: 3 oy")).toBe(false);
  });

  it("the noun must stand alone: 'maçta' or 'oyuncu' inside a name is not a marker", () => {
    // A Turkish roster (two numbered names) is still a roster.
    expect(displaysSquadState("1. Kemal Ediz\n2. Oya Demir")).toBe(true);
    expect(displaysSquadState("1. Maçka Spor\n2. Elvin Aliyev")).toBe(true);
  });

  it("the English stats answer relies on the word 'matches', not a dash", () => {
    const text = ["Most appearances in the last month:", "1. Kemal Ediz: 4 matches", "2. Elvin Aliyev: 1 match"].join("\n");
    expect(text).not.toMatch(/[—–]/);
    expect(displaysSquadState(text)).toBe(false);
  });

  it("a Turkish squad post composed from the rows is left as the rows say", () => {
    // The route runs every reply through the composer; a Turkish squad
    // post is a numbered run (rule a), so it is re-composed from the
    // truth, in Turkish, and comes back byte-identical.
    const tr = t("tr");
    const post = [
      tr.squad_status_lead({ withBench: false, confirmed: 2, maxPlayers: 14, need: 12 }),
      "",
      tr.playing_header,
      "1. Kemal Ediz",
      "2. Elvin Aliyev",
      ...Array.from({ length: 12 }, (_, i) => `${i + 3}. 🥁`),
    ].join("\n");
    expect(composeSquadStateReply(post, truth, "tr")).toEqual({ text: post, composed: true });
  });
});
