/**
 * The pure half of the pool scenario DSL (e2e/sim/pool/transcript.ts):
 * turning the rows MatchTime queued into "who was sent what", matching a
 * scenario's expectations against them, finding privacy leaks, and
 * rendering a readable transcript. Unit tests (vitest), no database.
 */
import { describe, expect, it } from "vitest";
import {
  type Registry,
  type SentMessage,
  classifyBotJob,
  classifyPlatformJob,
  findLeaks,
  matchSent,
  phoneVariants,
  renderTranscript,
} from "./transcript";

const REG: Registry = {
  people: new Map([
    ["447700910001", "ali"],
    ["447700910002", "fnf.owner"],
  ]),
  clubs: new Map([["org-fnf", "fnf"]]),
};

describe("classifying what MatchTime queued", () => {
  it("a club DM goes to the person whose number it is", () => {
    expect(classifyBotJob({ id: "b1", orgId: "org-fnf", kind: "dm", phone: "447700910002", text: "hi", sendAfter: null }, REG)).toEqual({
      id: "b1",
      channel: "dm",
      to: "fnf.owner",
      text: "hi",
      via: "bot-job",
      orgId: "org-fnf",
      purpose: null,
      sendAfter: null,
    });
  });

  it("group posts and admin-group posts go to the club's group or HQ", () => {
    expect(classifyBotJob({ id: "b2", orgId: "org-fnf", kind: "group", phone: null, text: "x", sendAfter: null }, REG)).toMatchObject({ channel: "group", to: "fnf.group" });
    expect(classifyBotJob({ id: "b3", orgId: "org-fnf", kind: "group-poll", phone: null, text: "x", sendAfter: null }, REG)).toMatchObject({ channel: "group", to: "fnf.group" });
    expect(classifyBotJob({ id: "b4", orgId: "org-fnf", kind: "admin-group", phone: null, text: "x", sendAfter: null }, REG)).toMatchObject({ channel: "hq", to: "fnf.hq" });
  });

  it("a number or club this world does not know is named, never dropped", () => {
    expect(classifyBotJob({ id: "b5", orgId: "org-x", kind: "dm", phone: "447700999999", text: "x", sendAfter: null }, REG)).toMatchObject({ to: "unknown:+447700999999" });
    expect(classifyBotJob({ id: "b6", orgId: "org-x", kind: "group", phone: null, text: "x", sendAfter: null }, REG)).toMatchObject({ to: "org:org-x.group" });
  });

  it("a platform DM carries its purpose; leaving a group is an action, not a message", () => {
    const at = new Date("2026-11-01T08:30:00Z");
    expect(classifyPlatformJob({ id: "p1", kind: "dm", phone: "447700910001", groupId: null, text: "yo", purpose: "pool-offer", sendAfter: at }, REG)).toEqual({
      id: "p1",
      channel: "dm",
      to: "ali",
      text: "yo",
      via: "platform-job",
      orgId: null,
      purpose: "pool-offer",
      sendAfter: at,
    });
    expect(classifyPlatformJob({ id: "p2", kind: "leave-group", phone: null, groupId: "g@g.us", text: null, purpose: "leave-group", sendAfter: null }, REG)).toMatchObject({
      channel: "action",
      to: "group:g@g.us",
      text: "",
    });
  });
});

const sent = (over: Partial<SentMessage>): SentMessage => ({
  id: "m",
  channel: "dm",
  to: "ali",
  text: "",
  via: "platform-job",
  orgId: null,
  purpose: null,
  sendAfter: null,
  ...over,
});

describe("matchSent: exactly these messages, in this order", () => {
  it("passes when every message matches its expectation", () => {
    const out = [sent({ to: "ali", text: "Welcome to the pool" }), sent({ to: "fnf.hq", channel: "hq", text: "Ali K took a place" })];
    expect(matchSent(out, [{ to: "ali", text: /welcome/i }, { to: "fnf.hq", channel: "hq", text: "took a place" }])).toEqual([]);
  });

  it("says which message is missing, which is unexpected, and which differs", () => {
    expect(matchSent([], [{ to: "ali" }])).toEqual(["#1 expected a message to ali, nothing was sent"]);
    expect(matchSent([sent({ to: "bob", text: "x" })], [])).toEqual(['#1 unexpected dm to bob: "x"']);
    expect(matchSent([sent({ to: "ali", text: "hello" })], [{ to: "ali", text: "bye" }])).toEqual(['#1 to ali: text "hello" does not contain "bye"']);
    expect(matchSent([sent({ to: "ali", purpose: "otp" })], [{ to: "ali", purpose: "pool-offer" }])).toEqual(['#1 to ali: purpose "otp", expected "pool-offer"']);
    expect(matchSent([sent({ to: "bob" })], [{ to: "ali" }])).toEqual(["#1 sent to bob, expected ali"]);
  });

  it("can check when a held message may go out (quiet hours)", () => {
    const at = new Date("2026-11-02T08:30:00Z");
    expect(matchSent([sent({ sendAfter: at })], [{ to: "ali", sendAfter: at }])).toEqual([]);
    expect(matchSent([sent({ sendAfter: null })], [{ to: "ali", sendAfter: at }])).toEqual([
      "#1 to ali: sendAfter none, expected 2026-11-02T08:30:00.000Z",
    ]);
  });
});

describe("findLeaks: no message carries what its reader must not see", () => {
  it("finds a forbidden term in any message, case-insensitively, and says where", () => {
    const out = [sent({ to: "ali", text: "Oscar Owner runs FNF Lads" }), sent({ to: "fnf.hq", text: "fine" })];
    expect(findLeaks(out, ["oscar owner", "Secret Group"])).toEqual([{ to: "ali", term: "oscar owner", text: "Oscar Owner runs FNF Lads" }]);
  });

  it("can be limited to some recipients", () => {
    const out = [sent({ to: "fnf.hq", text: "Ali K, +447700910001" })];
    expect(findLeaks(out, ["+447700910001"], { to: ["ali"] })).toEqual([]);
    expect(findLeaks(out, ["+447700910001"], { to: ["fnf.hq"] })).toHaveLength(1);
  });

  it("phoneVariants covers the ways a UK number is written", () => {
    expect(phoneVariants("+447700910001")).toEqual(["+447700910001", "447700910001", "07700910001", "07700 910001", "7700910001"]);
  });

  it("a member with no number on record has no variants (an empty term would match every message)", () => {
    expect(phoneVariants("")).toEqual([]);
    expect(findLeaks([sent({ text: "anything" })], ["", "  "])).toEqual([]);
  });
});

describe("renderTranscript", () => {
  it("reads like the conversation: what came in, then what went out", () => {
    const text = renderTranscript([
      { kind: "in", from: "ali", channel: "dm", text: "can I play?" },
      { kind: "out", message: sent({ to: "ali", text: "Sign up here", purpose: "pool-welcome" }) },
      { kind: "note", text: "nothing else" },
    ]);
    expect(text).toBe(["ali -> MatchTime (dm): can I play?", "MatchTime -> ali (dm, pool-welcome): Sign up here", "   nothing else"].join("\n"));
  });
});
