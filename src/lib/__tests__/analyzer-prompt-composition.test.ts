/**
 * The prompt and the composer have to agree, or step 4 silently costs
 * money for nothing.
 *
 * The composer replaces any squad-state text the model writes, so every
 * roster the model still emits is output tokens paid for and thrown
 * away — §8.2 measured output at 37-50% of the call and the single
 * largest line. The prompt therefore stops asking for one and asks for
 * a marker instead. These tests pin both halves to the SAME constant,
 * so a rename cannot leave the model writing a marker nothing reads.
 */
import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT } from "@/lib/message-analyzer";
import { SQUAD_POST_MARKER, wantsSquadPost } from "@/lib/group-copy";

describe("the analyzer prompt asks for the marker, not a roster", () => {
  it("names the exact marker the server looks for", () => {
    expect(SYSTEM_PROMPT).toContain(SQUAD_POST_MARKER);
    // …and what it tells the model to emit is what the server detects.
    expect(wantsSquadPost(`Sorry to hear that — anyone free?\n\n${SQUAD_POST_MARKER}`)).toBe(true);
  });

  it("no longer asks for a numbered roster block", () => {
    expect(SYSTEM_PROMPT).not.toContain("must END with a numbered roster");
    expect(SYSTEM_PROMPT).not.toContain("Length: exactly maxPlayers rows");
    expect(SYSTEM_PROMPT).not.toContain('Header the roster with "*Playing tonight:*"');
  });

  it("forbids the three things the deleted regexes used to correct", () => {
    // A roster (enforceCanonicalRoster), a count (its prose passes) and
    // a move announcement (the promotion strips + S7).
    expect(SYSTEM_PROMPT).toContain("NEVER write a numbered roster");
    expect(SYSTEM_PROMPT).toContain("NEVER state a count");
    expect(SYSTEM_PROMPT).toContain("NEVER announce a move");
  });

  it("still forbids a raw phone number in a reply", () => {
    // This rule lived in the section that was rewritten. It is a
    // shipped guard and must survive the rewrite verbatim.
    expect(SYSTEM_PROMPT).toContain(
      "NEVER display a raw phone number or numeric id as a player name",
    );
  });

  it("still tells stats answers to carry no squad block and no count", () => {
    expect(SYSTEM_PROMPT).toContain("no squad block, no count line");
  });
});
