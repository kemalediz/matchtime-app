/**
 * AN ANSWER TO A MEMBER'S "ARE YOU IN?" IS THE SENDER'S OWN PLACE
 * (Vets MNF, Monday 2026-11-23, production).
 *
 *   16:29 Kemal   "@Shane are you IN? If so, I will ask MT to generate the teams. ..."
 *   17:09 Shane   "So 7v7 if I'm in ?"
 *   17:39 Kemal   "yes"
 *   17:49 Kemal   "so are you in? :)"
 *   18:29 Shane   "Yeah and you and your lad come then it's 8v8 👌"
 *
 * The router said `offer`; the attendance extractor returned `claims: []`
 * (AnalyzedMessage cmwtlo7hw002e07l3mfc7ok4r), so Shane was not signed in
 * and Kemal had to tag "@Match Time @Shane is IN".
 *
 * TRACED: the context was there. The route builds RECENT CHAT from the
 * stored rows (`group-chat-history.ts`), and Kemal's two questions were
 * stored and are among the last eight lines the extractor shows. Rebuilt
 * from those rows and run once on the dev key, the shipped prompt again
 * returned no claim; the same context with a bare "Yeah" returned the
 * sender in at 0.8. So the reading failed, not the wiring: the prompt
 * defined an answer only to MatchTime (`affirmation`), and nothing said a
 * remark about other people beside the answer leaves the answer standing.
 *
 * These tests pin both halves: the wiring (the question reaches the
 * extractor) and the prompt (it says what such an answer is). Whether the
 * model obeys is measured live: scripts/live-check-attendance-extractor.ts,
 * the Y* cases.
 */
import { describe, it, expect } from "vitest";
import { EXTRACTOR_PROMPTS, extractForRoute } from "../extractors";
import { mergeGroupChatHistory, type StoredChatLine } from "../../group-chat-history";
import type { PipelineModel } from "../llm";

const P = EXTRACTOR_PROMPTS.attendance;

/** A field's block, from its label to the start of the next field. */
function fieldSection(name: string): string {
  const label = `\n  ${name} `;
  const start = P.indexOf(label);
  expect(start, `no \`${name}\` field found in the attendance prompt`).toBeGreaterThan(-1);
  const rest = P.slice(start + label.length);
  const end = rest.search(/\n {2}\w+ {2,}/);
  return P.slice(start, end === -1 ? undefined : start + label.length + end);
}

/** The production rows before Shane's 18:29 line, oldest first (pushname, roster label, words). */
const at = (hhmm: string) => new Date(`2026-11-23T${hhmm}:00Z`);
const STORED: StoredChatLine[] = [
  { authorName: "CM⚡️", author: "CM⚡️", body: "I’m in if there’s space", at: at("16:09") },
  { authorName: "Shane", author: "Shane", body: "There is indeed space my friend", at: at("16:19") },
  { authorName: "Kemal Ediz", author: "Kemal", body: "@Shane can you stay IN as with you the squad is 14 players?", at: at("16:19") },
  {
    authorName: "Kemal Ediz",
    author: "Kemal",
    body: "@Shane are you IN? If so, I will ask MT to generate the teams. \n\nThere is a small chance I may come depending on my arrival to Sutton. If I come, I will come with David, my son. For the time being, consider me as OUT",
    at: at("16:29"),
  },
  { authorName: "Steff", author: "Steff", body: "@Shane !!!!!", at: at("16:59") },
  { authorName: "Shane", author: "Shane", body: "So 7v7 if I’m in ?", at: at("17:09") },
  { authorName: "Kemal Ediz", author: "Kemal", body: "yes", at: at("17:49") },
  { authorName: "Kemal Ediz", author: "Kemal", body: "so are you in? :)", at: at("17:49") },
];
const SHANE = "Yeah and you and your lad come then it’s 8v8 👌";

function spy(seen: string[]): PipelineModel {
  return {
    name: "spy",
    async complete(req) {
      seen.push(req.user);
      return {
        text: JSON.stringify({ claims: [], affirmation: "none", sideRequests: [] }),
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  } as PipelineModel;
}

describe("the question Shane answered reaches the extractor (the wiring, traced)", () => {
  it("RECENT CHAT, built from the stored rows, shows Kemal's questions and not Shane's own line", async () => {
    const history = mergeGroupChatHistory({
      pi: [],
      stored: STORED,
      batch: [{ authorName: "Shane", timestamp: "2026-11-23T18:29:00Z", author: "Shane", body: SHANE, stored: false }],
    });
    const seen: string[] = [];
    await extractForRoute(spy(seen), "offer", {
      id: "m1",
      body: SHANE,
      authorName: "Shane",
      tagged: false,
      history,
      lastBotPost: null,
      now: at("18:29"),
    });
    const turn = seen[0];
    const recent = turn.slice(turn.indexOf("RECENT CHAT"), turn.indexOf("THE MESSAGE"));
    expect(recent).toContain("Kemal: so are you in? :)");
    expect(recent).toContain("Kemal: @Shane are you IN?");
    expect(recent).not.toContain(SHANE);
    expect(turn.trimEnd().endsWith(SHANE)).toBe(true);
  });
});

describe("the attendance prompt says what an answer to a member's question is", () => {
  const shown = () => P.slice(P.indexOf("WHAT YOU ARE SHOWN"), P.indexOf("THE CLAIMS"));

  it("defines it once, where the context is explained: the answer is the sender's own place", () => {
    expect(shown()).toMatch(/a member asked the sender whether they are playing/i);
    expect(shown()).toMatch(/"yes"[^\n]*is the sender in/);
    expect(shown()).toMatch(/"no"[^\n]*the sender out/);
    expect(P.match(/a member asked the sender whether they are playing/gi)?.length).toBe(1);
  });

  it("says what else the message says does not make the answer conditional or claim anyone else", () => {
    expect(shown()).toMatch(/whatever else the message says/i);
    expect(shown()).toMatch(/adds no condition to it and no claim for them/i);
  });

  it("keeps a yes with no question about a place, and a yes to MatchTime, out of it", () => {
    expect(shown()).toMatch(/not about anyone's place[^\n]*is no claim/i);
    expect(fieldSection("affirmation")).toMatch(/to MatchTime/);
    expect(fieldSection("affirmation")).toMatch(/an answer to a member is not an affirmation/i);
  });

  it("teaches it in the sender's own place group, English beside Turkish, the incident included", () => {
    const g = P.slice(P.indexOf("The sender's own place:"), P.indexOf("The sender's own offers:"));
    expect(g).toMatch(/"so are you in\?"[^\n]*"yes", "yeah"[^\n]*\| [^\n]*"evet"[^\n]*-> in/);
    expect(g).toMatch(/"Yeah and you and your lad come then it's 8v8"[^\n]*\| [^\n]*-> the sender in, contingent false, and no claim for/);
  });
});
