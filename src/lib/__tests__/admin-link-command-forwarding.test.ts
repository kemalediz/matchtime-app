/**
 * GO-LIVE SLICE S7: THE COMMAND MATCHTIME SENDS BY DM, AS IT COMES BACK.
 *
 * The setup DM's second message is the admin group link command, in the
 * club's language. The organiser forwards it into the organisers' own
 * group, which at that moment is a SILENT group nobody monitors. Two
 * things must both recognise it, or nothing happens and nobody is told:
 *
 *   - THE PI's own copy of the command shape
 *     (whatsapp-bot/src/admin-group.ts). Only a message it accepts leaves
 *     a silent group. The REAL module is loaded here, read only (by a
 *     computed path, so the app's type check does not pull the bot's
 *     sources in);
 *   - THE SERVER's parser (`parseAdminGroupLinkMessage`), which reads the
 *     code out of what the Pi forwarded.
 *
 * Every way the text can come back is run through BOTH: forwarded as it
 * was sent; pasted with a trailing space or line break; retyped on a
 * Turkish keyboard (capital dotted İ, all capitals, no accents).
 */
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseAdminGroupLinkMessage } from "../admin-channel-rules";
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
const TR = composeSetupAdminCommandDm({ lang: "tr", code: CODE });
const EN = composeSetupAdminCommandDm({ lang: "en", code: CODE });
const CAPITAL_DOTTED_I = String.fromCharCode(0x130);

/** What the Pi does with a message in a group it does not monitor, and
 *  what the server then reads from what it forwarded. */
async function through(body: string): Promise<{ forwarded: boolean; code: string | null }> {
  const postAdminGroupLink = vi.fn(async () => ({ outcome: "linked" }));
  const postAdminGroupMessage = vi.fn(async () => null);
  const route = await pi.routeAdminGroupInbound(
    {
      // Not an admin group yet, and (being silent) not monitored either.
      isAdminGroup: () => false,
      addAdminGroup: () => {},
      read: async () => ({ messageId: "m1", text: body, botMentioned: false }),
      postAdminGroupMessage,
      postAdminGroupLink,
      reply: async () => {},
      log: () => {},
    },
    { from: "120363900000000001@g.us", body },
  );
  expect(postAdminGroupMessage).not.toHaveBeenCalled();
  const forwarded = route === "link-command" && postAdminGroupLink.mock.calls.length === 1;
  return { forwarded, code: forwarded ? parseAdminGroupLinkMessage(body, { botMentioned: false }) : null };
}

describe("the Turkish command, every way it can come back", () => {
  it("is what a Turkish club is sent, in composed (NFC) letters", () => {
    expect(TR).toBe("Match Time yönetici grubu K7P3QX");
    expect(TR).toBe(TR.normalize("NFC"));
  });

  const cases: Array<[string, string]> = [
    ["forwarded exactly as it was sent", TR],
    ["pasted with a trailing space", `${TR} `],
    ["pasted with a trailing line break", `${TR}\n`],
    ["pasted with a Windows line break", `${TR}\r\n`],
    ["pasted with a leading line break and spaces", `\n  ${TR}`],
    ["pasted with a non-breaking space at the end", `${TR}${String.fromCharCode(0xa0)}`],
    ["retyped in capitals on a Turkish keyboard (capital dotted I)", `MATCH T${CAPITAL_DOTTED_I}ME YÖNET${CAPITAL_DOTTED_I}C${CAPITAL_DOTTED_I} GRUBU ${CODE}`],
    ["retyped with a capital dotted I at the start of the word", `Match Time Yönet${CAPITAL_DOTTED_I}ci Grubu ${CODE}`],
    ["retyped in plain capitals (the dotless capital I)", `MATCH TIME YONETICI GRUBU ${CODE}`],
    ["retyped with no accents", `Match Time yonetici grubu ${CODE}`],
    ["retyped with the code in small letters", `Match Time yönetici grubu ${CODE.toLowerCase()}`],
    ["retyped with a colon before the code", `Match Time yönetici grubu: ${CODE}`],
    ["retyped with two spaces between the words", `Match  Time  yönetici  grubu  ${CODE}`],
    ["retyped as one word, MatchTime", `MatchTime yönetici grubu ${CODE}`],
    ["sent with a tag in front, as the Settings page shows it", `@Match Time yönetici grubu ${CODE}`],
  ];
  for (const [label, body] of cases) {
    it(`${label}: the Pi forwards it from an unmonitored group and the server reads the code`, async () => {
      expect(pi.mightBeAdminGroupLink(body), "the Pi's cheap pre-check").toBe(true);
      expect(pi.looksLikeAdminGroupLink(body, false), "the Pi's full shape, untagged").toBe(true);
      expect(await through(body)).toEqual({ forwarded: true, code: CODE });
    });
  }
});

describe("the English command, the same ways", () => {
  const cases: Array<[string, string]> = [
    ["forwarded exactly as it was sent", EN],
    ["pasted with a trailing space", `${EN} `],
    ["pasted with a trailing line break", `${EN}\n`],
    ["retyped in capitals", `MATCH TIME ADMIN GROUP ${CODE}`],
    ["retyped on a Turkish keyboard (capital dotted I)", `MATCH T${CAPITAL_DOTTED_I}ME ADM${CAPITAL_DOTTED_I}N GROUP ${CODE}`],
  ];
  for (const [label, body] of cases) {
    it(`${label}`, async () => {
      expect(EN).toBe("Match Time admin group K7P3QX");
      expect(await through(body)).toEqual({ forwarded: true, code: CODE });
    });
  }
});

describe("what is NOT recognised, pinned so nobody is surprised", () => {
  it("the words without 'Match Time' and without a tag: not addressed to MatchTime, never leaves the group", async () => {
    expect(await through(`yönetici grubu ${CODE}`)).toEqual({ forwarded: false, code: null });
  });

  it("a Turkish command typed in DECOMPOSED letters (o plus a combining mark): missed by the Pi and by the server alike", async () => {
    // No phone keyboard we know of produces this, and a forwarded message
    // keeps the composed letters MatchTime sent. It is the one shape of
    // the Turkish text that is lost; the English form has no accented
    // letter and cannot be affected.
    const decomposed = TR.normalize("NFD");
    expect(decomposed).not.toBe(TR);
    expect(pi.looksLikeAdminGroupLink(decomposed, false)).toBe(false);
    expect(parseAdminGroupLinkMessage(decomposed, { botMentioned: false })).toBeNull();
    expect(await through(decomposed)).toEqual({ forwarded: false, code: null });
  });

  it("an ordinary message in that group never leaves it", async () => {
    expect(await through("Yönetici grubu kuralım mı?")).toEqual({ forwarded: false, code: null });
  });
});
