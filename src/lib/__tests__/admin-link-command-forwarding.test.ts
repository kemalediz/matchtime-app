/**
 * THE CODE MATCHTIME SENDS BY DM, AS IT COMES BACK IN A GROUP.
 *
 * The setup DM's second message is the admin group code alone (go-live
 * slice S7). The organiser tags MatchTime in the organisers' own group and
 * pastes it there. That group is at that moment a SILENT group nobody
 * monitors, so two things must both let it through, or nothing happens:
 *
 *   - THE PI (whatsapp-bot/src/admin-group.ts): only a message with a REAL
 *     tag (the mention flag) and a code-shaped token leaves a silent group.
 *     The REAL module is loaded here, read only (by a computed path, so the
 *     app's type check does not pull the bot's sources in);
 *   - THE SERVER (`adminGroupCodeCandidates`), which finds where a code it
 *     issued may stand in what the Pi forwarded.
 *
 * Since 2026-10-30 (no string parsing) neither reads a phrase: the words
 * "Match Time admin group" are only words, typed or forwarded, and without
 * a real tag the message never leaves the group.
 */
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { adminGroupCodeCandidates } from "../admin-channel-rules";
import { composeSetupAdminCommandDm } from "../club-setup-followup-rules";

interface PiAdminGroup {
  mightBeAdminGroupLink(rawBody: string): boolean;
  looksLikeAdminGroupLink(body: string, botMentioned: boolean): boolean;
  routeAdminGroupInbound(
    deps: Record<string, unknown>,
    head: { from: string; body: string },
  ): Promise<"admin-group" | "link-command" | "not-handled">;
}

let pi: PiAdminGroup;
beforeAll(async () => {
  const file = path.resolve(__dirname, "..", "..", "..", "whatsapp-bot", "src", "admin-group.ts");
  pi = (await import(/* @vite-ignore */ file)) as PiAdminGroup;
});

const CODE = "K7P3QX";
/** How a real tag of MatchTime appears in the body: its number. */
const TAG = "@447700900000";

/** What the Pi does with a message in a group it does not monitor, and
 *  where the server would then look for a code it issued. */
async function through(body: string, botMentioned: boolean): Promise<{ forwarded: boolean; candidates: string[] }> {
  const postAdminGroupLink = vi.fn(async () => ({ outcome: "linked" }));
  const postAdminGroupMessage = vi.fn(async () => null);
  const route = await pi.routeAdminGroupInbound(
    {
      isAdminGroup: () => false,
      addAdminGroup: () => {},
      read: async () => ({ messageId: "m1", text: body, botMentioned }),
      postAdminGroupMessage,
      postAdminGroupLink,
      reply: async () => {},
      log: () => {},
    },
    { from: "120363900000000001@g.us", body },
  );
  expect(postAdminGroupMessage).not.toHaveBeenCalled();
  const forwarded = route === "link-command" && postAdminGroupLink.mock.calls.length === 1;
  return { forwarded, candidates: forwarded ? adminGroupCodeCandidates(body) : [] };
}

describe("the code DM is the code alone, in both languages", () => {
  it("so it can be copied whole", () => {
    expect(composeSetupAdminCommandDm({ lang: "en", code: CODE })).toBe(CODE);
    expect(composeSetupAdminCommandDm({ lang: "tr", code: CODE })).toBe(CODE);
  });
});

describe("tagged and pasted, every way it can come back", () => {
  const cases: Array<[string, string]> = [
    ["the tag, then the code", `${TAG} ${CODE}`],
    ["pasted with a trailing space", `${TAG} ${CODE} `],
    ["pasted with a trailing line break", `${TAG} ${CODE}\n`],
    ["pasted with a Windows line break", `${TAG} ${CODE}\r\n`],
    ["pasted with a non-breaking space at the end", `${TAG} ${CODE}${String.fromCharCode(0xa0)}`],
    ["the code in small letters", `${TAG} ${CODE.toLowerCase()}`],
    ["in a sentence, English", `${TAG} here's our code: ${CODE}, thanks`],
    ["in a sentence, Turkish", `${TAG} kodumuz ${CODE}, teşekkürler`],
    ["the old words, still fine as words", `${TAG} admin group ${CODE}`],
  ];
  for (const [label, body] of cases) {
    it(`${label}: the Pi forwards it, and the server finds the code`, async () => {
      expect(pi.mightBeAdminGroupLink(body), "the Pi's cheap pre-check").toBe(true);
      const r = await through(body, true);
      expect(r.forwarded).toBe(true);
      expect(r.candidates).toContain(CODE);
    });
  }
});

describe("what never leaves the group", () => {
  it("the code without a real tag, whatever the words: typed 'Match Time' is not a tag", async () => {
    for (const body of [CODE, `Match Time admin group ${CODE}`, `@Match Time yönetici grubu ${CODE}`, `MatchTime ${CODE}`]) {
      expect(await through(body, false), body).toEqual({ forwarded: false, candidates: [] });
    }
  });

  it("a tagged message with no code-shaped token is never read for one", async () => {
    expect(pi.mightBeAdminGroupLink(`${TAG} is the admin group ready?`)).toBe(false);
    expect(await through(`${TAG} is the admin group ready?`, true)).toEqual({ forwarded: false, candidates: [] });
  });
});
