/**
 * D5b (cross-club ask, slice S5b): ONE question for an unquoted IN.
 *
 * FNF's ask was posted in Sutton FC's group under an hour ago. A Sutton
 * player who says a plain "IN", NOT replying to it, and who has no row at
 * all on Sutton's own game, may mean either. A state rule, no reading of
 * words: MatchTime asks him once which he means, and writes nothing. A
 * player who already has a row is clearly talking about his own game and
 * hears nothing new; once asked, his next IN is an IN for his own game.
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import { NOW, attendanceFacts, claim, msg, world } from "./helpers";
import type { EngineMessage, SquadState } from "../types";
import { compose } from "../compose";

const MIN = 60_000;
const ask = (over: Partial<NonNullable<SquadState["partnerAsks"]>[number]> = {}) => ({
  askId: "ask-1",
  postWaMessageId: "true_g@g.us_3EB0ASK1",
  askerName: "FNF",
  open: true,
  postedAt: new Date(NOW.getTime() - 20 * MIN).toISOString(),
  whichAskedUserIds: [] as string[],
  ...over,
});
const state = (opts: { confirmed?: string[]; asks?: ReturnType<typeof ask>[] } = {}): SquadState => ({
  ...world({ confirmed: opts.confirmed ?? ["kemal"] }),
  partnerAsks: opts.asks ?? [ask()],
});
const plainIn = (over: Partial<EngineMessage> = {}): EngineMessage => ({
  ...msg({ id: "wa-in", from: "sait", body: "IN", route: "self_att", facts: attendanceFacts([claim()]) }),
  ...over,
});

describe("D5b: an unquoted IN soon after an ask, from someone with no row on his own game", () => {
  it("asks once which game he means, and writes nothing", () => {
    const r = decide({ now: NOW, state: state(), messages: [plainIn()] });
    expect(r.writes).toEqual([]);
    expect(r.speech).toEqual([{ kind: "partner_ask_which", messageId: "wa-in", askId: "ask-1", userId: "u-sait", askerName: "FNF" }]);
    const text = compose(r).utterances.find((u) => u.messageId === "wa-in")?.text ?? "";
    expect(text).toContain("FNF");
    expect(text).toMatch(/reply to my FNF message/i);
  });

  it("in Turkish", () => {
    const s = state();
    s.features.language = "tr";
    const r = decide({ now: NOW, state: s, messages: [plainIn()] });
    expect(compose(r).utterances[0].text).toContain("FNF");
    expect(compose(r).utterances[0].text).not.toMatch(/reply to my/i);
  });

  it("someone with a row on his own game is talking about it: today's behaviour, no question", () => {
    const r = decide({ now: NOW, state: state({ confirmed: ["kemal", "sait"] }), messages: [plainIn({ body: "IN" })] });
    expect(r.speech.some((sp) => sp.kind === "partner_ask_which")).toBe(false);
  });

  it("asked once already for this ask: his IN is an IN for his own game", () => {
    const r = decide({ now: NOW, state: state({ asks: [ask({ whichAskedUserIds: ["u-sait"] })] }), messages: [plainIn()] });
    expect(r.speech.some((sp) => sp.kind === "partner_ask_which")).toBe(false);
    expect(r.writes[0]).toMatchObject({ kind: "attendance", userId: "u-sait", status: "CONFIRMED" });
  });

  it("an ask posted over an hour ago, or closed: no question", () => {
    const old = decide({ now: NOW, state: state({ asks: [ask({ postedAt: new Date(NOW.getTime() - 61 * MIN).toISOString() })] }), messages: [plainIn()] });
    expect(old.writes[0]).toMatchObject({ kind: "attendance", userId: "u-sait" });
    const closed = decide({ now: NOW, state: state({ asks: [ask({ open: false })] }), messages: [plainIn()] });
    expect(closed.writes[0]).toMatchObject({ kind: "attendance", userId: "u-sait" });
  });

  it("OUT is never questioned (an OUT can only be about his own game)", () => {
    const r = decide({ now: NOW, state: state({ confirmed: ["kemal"] }), messages: [plainIn({ body: "OUT", facts: attendanceFacts([claim({ polarity: "out" })]) })] });
    expect(r.speech.some((sp) => sp.kind === "partner_ask_which")).toBe(false);
  });

  it("no partner ask (every club today): byte for byte today's", () => {
    const withNone = decide({ now: NOW, state: { ...world({ confirmed: ["kemal"] }), partnerAsks: [] }, messages: [plainIn()] });
    const without = decide({ now: NOW, state: world({ confirmed: ["kemal"] }), messages: [plainIn()] });
    expect(withNone.writes).toEqual(without.writes);
    expect(withNone.speech).toEqual(without.speech);
  });
});

describe("M3 (review): an ask whose post id has not come back yet", () => {
  const unknownAsk = () => ask({ postWaMessageId: "", postIdKnown: false } as never);
  const quotedIn = () => plainIn({ quoted: { id: "3EB0SOMEPOST", fromMatchTime: true } });

  it("a reply quoting a MatchTime post is never written as an own-club IN: one question instead", () => {
    const r = decide({ now: NOW, state: state({ confirmed: ["kemal", "sait"], asks: [unknownAsk()] }), messages: [quotedIn()] });
    expect(r.writes).toEqual([]);
    expect(r.speech).toEqual([{ kind: "partner_ask_which", messageId: "wa-in", askId: "ask-1", userId: "u-sait", askerName: "FNF" }]);
  });

  it("asked once already: held, still nothing written", () => {
    const r = decide({ now: NOW, state: state({ asks: [{ ...unknownAsk(), whichAskedUserIds: ["u-sait"] }] }), messages: [quotedIn()] });
    expect(r.writes).toEqual([]);
    expect(r.speech).toEqual([]);
  });

  it("once the post id is known, a reply quoting another post is today's own IN", () => {
    const r = decide({ now: NOW, state: state({ asks: [ask()] }), messages: [quotedIn()] });
    expect(r.writes[0]).toMatchObject({ kind: "attendance", userId: "u-sait" });
  });
});
