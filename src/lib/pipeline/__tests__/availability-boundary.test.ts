/**
 * Being free to play, and where the line now falls (2026-10-28).
 *
 * From PR #44 (June) the attendance prompt had a `basis` field, and #48
 * (2026-09-05) drew its line at the verb: "I'm free Tuesday if you need
 * me" was `availability`, and the engine gave it no place. That followed
 * a real complaint on 1 Sept ("Matchtime put my name down as reserve
 * without my confirm").
 *
 * FNF, 2026-10-28, overrode it. Seb wrote "I'm free to play this Friday if
 * there's any drop outs" to a full squad, MatchTime did nothing, and 38
 * minutes later his "@Match Time In" benched him. Kemal: people who say
 * they are free or available for a match go on the bench.
 *
 * So the prompt was rewritten as a whole (not appended to). `basis` is
 * gone; being free to play is defined once, as the sender's offer to fill
 * a gap (bench, contingent, conditionOn squad), and the words "free" or
 * "around" settle nothing alone: the fee, a question, a drink, or news of
 * where someone will be stay no claim.
 *
 * These tests pin the PROMPT. Whether the model obeys it is the live
 * check: `scripts/live-check-attendance-extractor.ts` cases F* and B*.
 */
import { describe, it, expect } from "vitest";
import { ATTENDANCE_SCHEMA, EXTRACTOR_PROMPTS } from "../extractors";

const P = EXTRACTOR_PROMPTS.attendance;

function fieldSection(name: string): string {
  const label = `  ${name} `;
  const start = P.indexOf(label);
  expect(start, `no \`${name}\` field found`).toBeGreaterThan(-1);
  const rest = P.slice(start + label.length);
  const end = rest.search(/\n {2}\w+ {2,}/);
  return P.slice(start, end === -1 ? undefined : start + label.length + end);
}

function group(header: string, next: string): string {
  const a = P.indexOf(header);
  const b = P.indexOf(next, a);
  expect(a, header).toBeGreaterThan(-1);
  expect(b, next).toBeGreaterThan(a);
  return P.slice(a, b);
}

describe("basis is retired", () => {
  it("is in neither the prompt nor the schema", () => {
    expect(P).not.toMatch(/\bbasis\b/);
    expect(P).not.toMatch(/"availability"/);
    expect(P).not.toMatch(/"decision"/);
    expect(JSON.stringify(ATTENDANCE_SCHEMA)).not.toContain("basis");
  });
});

describe("being free to play is the sender's offer to fill a gap", () => {
  it("is defined once, in THE CLAIMS, as free for the match", () => {
    const claims = P.slice(P.indexOf("THE CLAIMS"), P.indexOf("  subject "));
    expect(claims).toMatch(/being free to play/);
    expect(claims).toMatch(/free, around or available to play/);
    expect(P.match(/Being free means/g)).toHaveLength(1);
  });

  it("polarity puts it on the bench, contingent on the squad", () => {
    const s = fieldSection("polarity");
    expect(s).toMatch(/saying they are free to play[^\n]*"bench" with contingent true and conditionOn "squad"/);
    expect(s).toContain("I'm free Friday if you need me");
  });

  it("an offer needs no \"if\": contingent covers being free", () => {
    const s = fieldSection("contingent");
    expect(s).toMatch(/Being free to play is contingent too, with no "if" needed/);
    expect(s).toMatch(/"my cousin Ali can play", "two of my guys can play", "Ali can take my spot" are false/);
  });

  it("names Seb's message and Kemal's phrasings, English beside Turkish", () => {
    const g = group("The sender's own offers", "Not about anyone's place");
    const line = g.split("\n").find((l) => l.includes("Saying they are free to play"));
    expect(line).toBeTruthy();
    for (const phrase of [
      "I'm free to play this Friday if there's any drop outs",
      "available to play if needed",
      "I'm free if you need me",
      "I'm around if you're short",
      "I'm free Friday",
      "cuma boşum, lazım olursa",
    ]) {
      expect(line, phrase).toContain(phrase);
    }
    expect(line).toMatch(/\| [^\n]*-> the sender bench$/);
    expect(g).toContain("biri düşerse oynarım");
  });

  it("asking for the place outright is still a plain in", () => {
    expect(fieldSection("polarity")).toContain("I'm free Tuesday, put me down");
  });
});

describe("the word alone settles nothing", () => {
  it("defines what is not about anyone's place, once", () => {
    const claims = P.slice(P.indexOf("THE CLAIMS"), P.indexOf("  subject "));
    expect(claims).toMatch(/The word alone settles nothing/);
    expect(claims).toMatch(/free of the fee/);
    expect(claims).toMatch(/question asking who is free/);
    expect(claims).toContain("I will be back Tuesday week");
  });

  it("has a no-claim group for the fee, questions, past tense and return dates, in both languages", () => {
    const g = group("Not about anyone's place", "Fitness and injuries");
    expect(g).toMatch(/"I will be back Tuesday week"[^\n]*\|[^\n]*-> no claim/);
    expect(g).toMatch(/"are you free Friday, Ali\?"[^\n]*\| "Ali cuma boş musun\?"[^\n]*a question/);
    expect(g).toMatch(/"is it free this week\?"[^\n]*\| "bu hafta ücretsiz mi\?"[^\n]*the fee/);
    expect(g).toMatch(/"I was free last week[^\n]*\| "geçen hafta boştum"/);
  });
});

describe("someone else said to be free is an offer of them, never the bench", () => {
  it("is contingent on the squad, in, in both languages", () => {
    const g = group("Offering someone else", "Several people in one message");
    expect(g).toMatch(/"my brother is free Friday"[^\n]*"kardeşim cuma boş, lazım olursa"[^\n]*in \(not bench\), contingent true, conditionOn "squad"/);
  });
});

describe("does not ask the model what SHOULD happen", () => {
  it("never tells it to register or write", () => {
    expect(P).not.toMatch(/\bregister\b/i);
    expect(P).not.toMatch(/\bno write\b/i);
  });
});
