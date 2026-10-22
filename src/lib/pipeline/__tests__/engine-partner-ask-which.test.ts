/**
 * D5b (cross-club ask, slice S5b), REVISED 2026-10-22 (Kemal).
 *
 * FNF's ask was posted in MT Test's group under an hour ago. An MT Test
 * player who says a plain "IN", NOT replying to it, and who has no row at
 * all on his own club's game, may mean either. It used to write nothing
 * and ask him which by DM; Sait never answered (MT Test, 2026-10-22 08:40
 * UTC) and his IN for his own game was lost.
 *
 * Now the own game is the default: a plain IN in his OWN players' group is
 * a normal self IN for this club's match, and the engine also asks for ONE
 * private question ("I've put you IN for MT Test's game. Did you mean
 * FNF's instead? Tap here"), sent by the batch only once the IN has
 * landed. The group hears what any IN gets, nothing more. A state rule, no
 * reading of words.
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
const ownInAsk = { kind: "partner_ask_own_in", messageId: "wa-in", askId: "ask-1", userId: "u-sait", askerName: "FNF" };
const ownWrite = (r: ReturnType<typeof decide>) => r.writes.find((w) => w.kind === "attendance" && w.userId === "u-sait");
const asksAnything = (r: ReturnType<typeof decide>) => r.speech.some((sp) => sp.kind === "partner_ask_own_in" || sp.kind === "partner_ask_which");

describe("D5b: a plain IN soon after an ask, from someone with no row on his own game", () => {
  it("counts for his own club's game, and asks once by DM whether he meant FNF's", () => {
    const r = decide({ now: NOW, state: state(), messages: [plainIn()] });
    expect(ownWrite(r)).toMatchObject({ kind: "attendance", userId: "u-sait", status: "CONFIRMED", sourceMessageId: "wa-in" });
    expect(r.writes.some((w) => w.kind === "partner_volunteer")).toBe(false);
    expect(r.speech).toContainEqual(ownInAsk);
    expect(r.speech.some((sp) => sp.kind === "partner_ask_which")).toBe(false);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/D5b/);
  });

  it("the group hears nothing about FNF: the question goes by DM only", () => {
    const r = decide({ now: NOW, state: state(), messages: [plainIn()] });
    const text = compose(r).utterances.map((u) => u.text).join("\n");
    expect(text).not.toContain("FNF");
  });

  it('in Turkish: "var" is the same self IN, with the same one question', () => {
    const s = state();
    s.features.language = "tr";
    const r = decide({ now: NOW, state: s, messages: [plainIn({ body: "var" })] });
    expect(ownWrite(r)).toMatchObject({ status: "CONFIRMED" });
    expect(r.speech).toContainEqual(ownInAsk);
    expect(compose(r).utterances.map((u) => u.text).join("\n")).not.toContain("FNF");
  });

  it("a known member's IN is never floor-dropped, even a low-confidence one", () => {
    const r = decide({ now: NOW, state: state(), messages: [plainIn({ facts: attendanceFacts([claim({ confidence: 0.2 })]) })] });
    expect(ownWrite(r)).toMatchObject({ status: "CONFIRMED" });
    expect(r.speech).toContainEqual(ownInAsk);
  });

  it("someone with a row on his own game is talking about it: today's behaviour, no question", () => {
    const r = decide({ now: NOW, state: state({ confirmed: ["kemal", "sait"] }), messages: [plainIn({ body: "IN" })] });
    expect(asksAnything(r)).toBe(false);
  });

  it("asked once already for this ask: his IN is his own game's, and no second question", () => {
    const r = decide({ now: NOW, state: state({ asks: [ask({ whichAskedUserIds: ["u-sait"] })] }), messages: [plainIn()] });
    expect(asksAnything(r)).toBe(false);
    expect(ownWrite(r)).toMatchObject({ status: "CONFIRMED" });
  });

  it("an ask posted over an hour ago, or closed: his own IN, no question", () => {
    const old = decide({ now: NOW, state: state({ asks: [ask({ postedAt: new Date(NOW.getTime() - 61 * MIN).toISOString() })] }), messages: [plainIn()] });
    expect(ownWrite(old)).toMatchObject({ status: "CONFIRMED" });
    expect(asksAnything(old)).toBe(false);
    const closed = decide({ now: NOW, state: state({ asks: [ask({ open: false })] }), messages: [plainIn()] });
    expect(ownWrite(closed)).toMatchObject({ status: "CONFIRMED" });
    expect(asksAnything(closed)).toBe(false);
  });

  it("a swipe-reply to the ask is unchanged: FNF's game, nothing on his own", () => {
    const r = decide({ now: NOW, state: state(), messages: [plainIn({ quoted: { id: "3EB0ASK1", fromMatchTime: true } })] });
    expect(r.writes).toEqual([expect.objectContaining({ kind: "partner_volunteer", askId: "ask-1", userId: "u-sait", polarity: "in" })]);
    expect(asksAnything(r)).toBe(false);
  });

  it("OUT is never questioned (an OUT can only be about his own game)", () => {
    const r = decide({ now: NOW, state: state({ confirmed: ["kemal"] }), messages: [plainIn({ body: "OUT", facts: attendanceFacts([claim({ polarity: "out" })]) })] });
    expect(asksAnything(r)).toBe(false);
  });

  it("the write is byte for byte the IN he would get with no ask at all", () => {
    const withAsk = decide({ now: NOW, state: state(), messages: [plainIn()] });
    const without = decide({ now: NOW, state: world({ confirmed: ["kemal"] }), messages: [plainIn()] });
    expect(withAsk.writes).toEqual(without.writes);
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
