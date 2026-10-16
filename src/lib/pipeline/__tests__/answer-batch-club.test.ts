/**
 * `runAnswerBatch` for the ORGANISERS (2026-10-16, FNF HQ). "MatchTime who
 * are the admins?" in the admin group got the generic help menu. HQ now
 * asks the same question extractor and answer code the players' group
 * uses, with `audience: "organisers"`:
 *
 *   - a `club` question (who the admins are, who collects the money, the
 *     fee, what time the teams are made) is answered there, and in the
 *     players' group too, with the teams line worded for players;
 *   - the squad and the bench are shown to the organisers even when they,
 *     not MatchTime, announce the list to the players;
 *   - nothing else changes: same topics, same composers.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import { runAnswerBatch, type AnswerBatchMessage } from "../answer-batch";
import type { OrgFeatures } from "../../org-features";
import type { ClubSnapshot, Route, SquadState } from "../types";
import { NOW, fullName, world } from "./helpers";

const FEATURES = {
  botEnabled: true,
  attendance: true,
  bench: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  reminders: true,
  statsQa: true,
  paymentTracking: true,
  paymentCollection: true,
  squadFromList: false,
  language: "en",
} as OrgFeatures;

const CLUB: ClubSnapshot = { collectorName: "Elvin Aliyev", feePerPlayer: 6.5, feeSplitTotal: false, teamsReady: "10:00" };

function stubModel(topic: string): PipelineModel {
  return {
    name: "stub",
    async complete(_req: ModelRequest): Promise<ModelResponse> {
      return {
        text: JSON.stringify({
          topic,
          personRef: "",
          statedCount: -1,
          table: "none",
          listSize: -1,
          listEnd: "top",
          period: "none",
          periodCount: -1,
          periodUnit: "none",
          feature: "none",
        }),
        stopReason: "end_turn",
        usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.002,
        ms: 10,
      };
    },
  };
}

const message = (body: string): AnswerBatchMessage => ({
  waMessageId: "wa-1",
  body,
  authorName: fullName("kemal"),
  senderUserId: "u-kemal",
  senderName: fullName("kemal"),
  tagged: true,
  route: "question" as Route,
  gated: false,
});

async function ask(
  topic: string,
  opts: { audience?: "players" | "organisers"; state?: SquadState; club?: ClubSnapshot | (() => never); lang?: "en" | "tr" } = {},
) {
  const st = opts.state ?? world({ confirmed: ["kemal", "sait"], bench: ["erdal"] });
  const loads: Array<{ orgId: string; matchId: string | null }> = [];
  const state = opts.lang ? { ...st, features: { ...st.features, language: opts.lang } } : st;
  const res = await runAnswerBatch({
    orgId: "org-1",
    now: NOW,
    messages: [message("who are the admins?")],
    history: [],
    expectedMatchId: state.matchId,
    enabled: new Set<Route>(["question"]),
    ...(opts.audience ? { audience: opts.audience } : {}),
    deps: {
      model: stubModel(topic),
      loadState: async () => state,
      loadFeatures: async () => FEATURES,
      loadClub: async (orgId, matchId) => {
        loads.push({ orgId, matchId });
        const c = opts.club ?? CLUB;
        return typeof c === "function" ? c() : c;
      },
    },
  });
  return { res, loads, reply: res.outcomes.get("wa-1")?.reply ?? null };
}

describe("a club question, asked by the organisers", () => {
  it("names the admins (OWNER and ADMIN), the collector, the fee and the teams time", async () => {
    const { reply, loads, res } = await ask("club", { audience: "organisers" });
    expect(reply).toBe(
      [
        "👥 Admins: Kemal Ediz and Elvin Aliyev",
        "💷 Money collector: Elvin Aliyev",
        "💷 Match fee: £6.50 a player",
        "⚽ Teams ready: 10:00 on match day",
      ].join("\n"),
    );
    expect(loads).toEqual([{ orgId: "org-1", matchId: "match-1" }]);
    expect(res.outcomes.get("wa-1")?.intent).toBe("question");
    expect(res.writes).toEqual([]);
  });

  it("says what is not set rather than leaving it out, and a split fee as a split", async () => {
    const { reply } = await ask("club", {
      audience: "organisers",
      club: { collectorName: null, feePerPlayer: null, feeSplitTotal: true, teamsReady: "off" },
    });
    expect(reply).toContain("💷 Money collector: not set");
    expect(reply).toContain("💷 Match fee: the pitch cost split between who played");
    expect(reply).toContain("⚽ Teams ready: off");
  });

  it("no fee and no split: not set", async () => {
    const { reply } = await ask("club", { audience: "organisers", club: { ...CLUB, feePerPlayer: null } });
    expect(reply).toContain("💷 Match fee: not set");
  });

  it("in Turkish", async () => {
    const { reply } = await ask("club", { audience: "organisers", lang: "tr" });
    expect(reply).toBe(
      [
        "👥 Yöneticiler: Kemal Ediz ve Elvin Aliyev",
        "💷 Parayı toplayan: Elvin Aliyev",
        "💷 Maç ücreti: kişi başı £6.50",
        "⚽ Takımlar hazır: maç günü 10:00",
      ].join("\n"),
    );
  });

  it("is answered with no upcoming match (the club's setup is not about one)", async () => {
    const { reply, loads } = await ask("club", { audience: "organisers", state: world({ noMatch: true }) });
    expect(reply).toContain("👥 Admins: Kemal Ediz and Elvin Aliyev");
    expect(loads).toEqual([{ orgId: "org-1", matchId: null }]);
  });

  it("a club read that throws: nothing said, the reason on the note", async () => {
    const { res, reply } = await ask("club", {
      audience: "organisers",
      club: () => {
        throw new Error("db down");
      },
    });
    expect(reply).toBeNull();
    expect(res.degradations.join("\n")).toMatch(/club read failed \(db down\)/);
  });
});

// Manager review of #296: "how much do we pay each?" and "what time do the
// teams come out?" must not go unanswered in the players' group. The same
// facts (nothing private); only the teams line is worded for players.
describe("a club question in the players' group: the same answer, the teams line in plain words", () => {
  it.each([undefined, "players" as const])("audience %s", async (audience) => {
    const { reply, loads } = await ask("club", audience ? { audience } : {});
    expect(reply).toBe(
      [
        "👥 Admins: Kemal Ediz and Elvin Aliyev",
        "💷 Money collector: Elvin Aliyev",
        "💷 Match fee: £6.50 a player",
        "⚽ Teams: worked out at 10:00 on match day",
      ].join("\n"),
    );
    expect(loads).toEqual([{ orgId: "org-1", matchId: "match-1" }]);
  });

  it("teams-ready off: the organisers sort them out", async () => {
    const { reply } = await ask("club", { club: { ...CLUB, teamsReady: "off" } });
    expect(reply).toContain("⚽ Teams: sorted by the organisers before the game");
  });

  it("in Turkish", async () => {
    const { reply } = await ask("club", { lang: "tr" });
    expect(reply).toContain("👥 Yöneticiler: Kemal Ediz ve Elvin Aliyev");
    expect(reply).toContain("⚽ Takımların kurulduğu saat: maç günü 10:00");
    const off = await ask("club", { lang: "tr", club: { ...CLUB, teamsReady: "off" } });
    expect(off.reply).toContain("⚽ Takımlar: maçtan önce organizatörler ayarlıyor");
  });

  it("no phone number in the answer, ever: the roster's names only", async () => {
    const { reply } = await ask("club");
    expect(reply).not.toMatch(/\+?\d{9,}/);
  });
});

describe("the organisers see the squad even when they announce it to the players", () => {
  const organisersAnnounce = () => {
    const st = world({ confirmed: ["kemal", "sait"], bench: ["erdal"] });
    return { ...st, features: { ...st.features, listAnnouncer: "organisers" as const } };
  };

  it("players' group: the one line, as before", async () => {
    const { reply } = await ask("bench", { state: organisersAnnounce() });
    expect(reply).toBe("The organisers will post the list.");
  });

  it("the organisers: the bench itself", async () => {
    const { reply } = await ask("bench", { audience: "organisers", state: organisersAnnounce() });
    expect(reply).not.toBe("The organisers will post the list.");
    expect(reply).toContain("Erdal Ozkan");
  });

  it("the organisers: the squad itself", async () => {
    const { reply } = await ask("squad", { audience: "organisers", state: organisersAnnounce() });
    expect(reply).toContain("Kemal Ediz");
    expect(reply).toContain("Sait Demir");
  });
});
