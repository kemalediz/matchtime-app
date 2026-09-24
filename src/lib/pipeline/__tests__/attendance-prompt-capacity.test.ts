/**
 * POLARITY IS WHAT THE MESSAGE SAYS, NEVER HOW FULL THE SQUAD IS.
 *
 * ── the incident (Sutton FC, 2026-09-24, squad 14/14) ────────────────
 * Erdal was CONFIRMED at 14 by a roster he had pasted a moment earlier.
 * He then typed a plain "in". The attendance extractor returned an
 * unconditional `polarity: "bench"` for that body, and the engine
 * demoted him CONFIRMED@14 -> BENCH@14. The engine half is fixed in
 * PR #134 (a bench now needs the message to NAME the bench). This file
 * pins the prompt half.
 *
 * The prompt used to say "you are not told the squad". That was false:
 * `extractForRoute` shows the model the RECENT CHAT and MATCHTIME'S LAST
 * POST, and both routinely carry a count ("14/14") and the list of
 * names. A model told a falsehood about its input has no instruction for
 * what to do with the squad it can plainly see, and "14/14, so a new
 * 'in' must be the bench" is the natural inference. The rewrite says
 * what the model sees and what it must NOT do with it.
 *
 * These tests pin the PROMPT, the thing we own. Whether the model then
 * obeys it is a live measurement, and by Kemal's decision none was run
 * for this change.
 */
import { describe, it, expect } from "vitest";
import { EXTRACTOR_PROMPTS } from "../extractors";

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

describe("the attendance prompt is truthful about what the model is shown", () => {
  it("no longer claims the model is not told the squad", () => {
    expect(P).not.toMatch(/not told the squad/i);
  });

  it("names the context blocks the call actually sends", () => {
    // `extractForRoute` builds exactly these three headers.
    expect(P).toContain("RECENT CHAT");
    expect(P).toContain("MATCHTIME'S LAST POST");
    expect(P).toContain("THE MESSAGE");
  });

  it("says that context may show the squad's count and list", () => {
    expect(P).toMatch(/count[^.]*14\/14/i);
    expect(P).toMatch(/list of names/i);
  });
});

describe("polarity describes the message, never the squad's capacity", () => {
  it("says so in the polarity field itself", () => {
    const s = fieldSection("polarity");
    expect(s).toMatch(/NEVER the squad's capacity/);
    expect(s).toMatch(/full/i);
  });

  it("rules that a plain in is in, even at 14/14 and even for someone already on the list", () => {
    const s = fieldSection("polarity");
    expect(s).toMatch(/plain "in" is "in"/);
    expect(s).toMatch(/14\/14/);
    expect(s).toMatch(/already on (it|the list)/i);
  });

  it("leaves bench-or-confirmed to code", () => {
    expect(fieldSection("polarity")).toMatch(/Code decides/);
  });

  it("allows bench only when the message names it, in both languages", () => {
    const s = fieldSection("polarity");
    for (const w of ["bench", "reserve", "sub", "backup", "spare", "standby", "waiting list", "yedek", "🪑"]) {
      expect(s, w).toContain(w);
    }
    expect(s).toMatch(/explicit/i);
  });

  it("keeps a conditional offer to play off the bench", () => {
    // "put me down if you're short" is a standing offer: an IN with
    // contingent true, which the engine reads. It is not a bench ask.
    expect(fieldSection("polarity")).toMatch(/if you're short[^\n]*"in"[^\n]*contingent/);
  });

  it("works the Sutton FC case as an example, with its Turkish twin", () => {
    // The worked example: the chat shows 14/14 with the sender on the
    // list, the sender types "in", and the answer is polarity in.
    expect(P).toMatch(/14\/14[^\n]*"in"[^\n]*polarity in/);
    expect(P).toMatch(/"varım"[^\n]*14\/14|14\/14[^\n]*"varım"/);
  });
});

describe("the rewrite keeps every behaviour the prompt already handled", () => {
  // One anchor per behaviour of the pre-rewrite prompt. Each must still
  // be taught after it. The deeper pins for basis, replacements, Turkish
  // and hedges live in `availability-boundary.test.ts` and
  // `extractors.test.ts`.
  it.each([
    ["facts, never decisions", /never decide/i],
    ["personRef verbatim, never invented", /VERBATIM[^\n]*Never invent/],
    ["personNamed false for a relationship or quantity", /"my brother", "2 of my guys", "someone", "a mate", "another keeper"/],
    ["standing future commitment", /count me in whenever you are short/],
    ["counterfactual is hypothetical", /if I WAS in the team/],
    ["a condition on a real commitment is future, not hypothetical", /NOT hypothetical/],
    ["reported speech", /Najib said he's in/],
    ["affirmation to MatchTime's post", /"Confirmed"/],
    ["recruit side request", /"recruit"/],
    ["chase side request", /"chase"/],
    ["several claims in one message", /my brother can play too/],
    ["asking for cover is not a condition", /anyone able to replace me/],
    ["offer to give up a place is contingent", /I can drop out/],
    ["offer vs decision test", /IS leaving[^\n]*COULD/],
    ["guest +1 is not the sender", /"\+1"/],
    ["replacement chatter", /Hi guys, Mojib is replacing Najib on the list/],
    ["two separate statements are not a replacement", /Ali is coming, Mehmet can't make it/],
    ["replacement in my place, Turkish", /benim yerime Mojib oynayacak/],
    ["replacement var/yok, Turkish", /Najib yok, Mojib var/],
    ["position is a note, not a condition", /kaleye geçerim/],
    ["Turkish third party, reported", /Ali geliyorum dedi/],
    ["Turkish third party out", /Mehmet gelemiyor/],
    ["hedges, English", /"50\/50"/],
    ["hedges, Turkish", /bakacağım/],
    ["banter still contains claims", /Zeeshan is out lol vote him out/],
    ["empty claims only when there is genuinely nothing", /empty claims array/i],
  ])("%s", (_name, re) => {
    expect(P).toMatch(re);
  });
});
