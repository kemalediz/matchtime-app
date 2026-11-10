/**
 * A FORM NOTE, ANSWERED HONESTLY (Sutton FC, 2026-11-10).
 *
 * "@Match Time reduce my strength for this match as I am quite tired." was
 * sent to the club's settings page. The rating adjuster already reads the
 * week's chat when the teams are made, so the message does what was asked.
 * The line says that only when MatchTime makes this club's teams.
 */
import { describe, it, expect } from "vitest";
import { formNoteReplyFor } from "../form-note";
import { world } from "../pipeline/__tests__/helpers";

const NOW = new Date("2026-11-10T12:14:31Z");

describe("formNoteReplyFor", () => {
  it("a club whose teams MatchTime makes, teams not made yet", async () => {
    const r = await formNoteReplyFor({
      orgId: "org-1",
      now: NOW,
      lang: "en",
      deps: { loadFeatures: async () => ({ teamBalancing: true }), loadState: async () => world() },
    });
    expect(r).toBe("Noted: I'll take it into account when the teams are made, for this match only.");
  });

  it("the teams already made", async () => {
    const r = await formNoteReplyFor({
      orgId: "org-1",
      now: NOW,
      lang: "tr",
      deps: { loadFeatures: async () => ({ teamBalancing: true }), loadState: async () => world({ teams: { kemal: "RED" } }) },
    });
    expect(r).toBe("Not aldım. Bu maçın takımları zaten kuruldu; takımlar yeniden kurulursa bunu dikkate alacağım.");
  });

  it("a club whose teams MatchTime does not make: null, nothing said, the state never read", async () => {
    let read = false;
    const r = await formNoteReplyFor({
      orgId: "org-1",
      now: NOW,
      lang: "en",
      deps: {
        loadFeatures: async () => ({ teamBalancing: false }),
        loadState: async () => {
          read = true;
          return world();
        },
      },
    });
    expect(r).toBeNull();
    expect(read).toBe(false);
  });
});
