/**
 * The owner's intro messages (2026-10-29): which categories go out, in what
 * order, to whom, and the house rules the copy keeps.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ownerIntroCopy, type OwnerIntroCopy } from "@/lib/i18n/owner-intro";
import { poolPageCopy } from "@/lib/pool/page-copy";
import {
  OWNER_INTRO_PURPOSE,
  buildOwnerIntroMessages,
  introCategoriesToSend,
  isPlatformOwnerSender,
  sendOwnerIntroMessages,
} from "../owner-intro";

const SITE = "https://matchtime.ai";
const PLAY = "https://matchtime.ai/play";
const all = (c: OwnerIntroCopy) => [c.footballGroups(SITE), c.poolInvite(PLAY), c.newFeatures()];
const EN = all(ownerIntroCopy("en"));
const TR = all(ownerIntroCopy("tr"));

const saved = process.env.NEXTAUTH_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.NEXTAUTH_URL;
  else process.env.NEXTAUTH_URL = saved;
});

describe("which categories go out", () => {
  it("a named category alone", () => {
    expect(introCategoriesToSend([3])).toEqual([3]);
    expect(introCategoriesToSend([1])).toEqual([1]);
  });

  it("all three when none is named (an empty list, or nothing at all)", () => {
    expect(introCategoriesToSend([])).toEqual([1, 2, 3]);
    expect(introCategoriesToSend(undefined)).toEqual([1, 2, 3]);
    expect(introCategoriesToSend(null)).toEqual([1, 2, 3]);
  });

  it("in category order, each once, whatever order the model gave", () => {
    expect(introCategoriesToSend([3, 1, 3])).toEqual([1, 3]);
  });

  it("drops anything that is not 1, 2 or 3; nothing valid left means all three", () => {
    expect(introCategoriesToSend([2, 7, "x", 1.5])).toEqual([2]);
    expect(introCategoriesToSend([0, 4])).toEqual([1, 2, 3]);
    expect(introCategoriesToSend("1")).toEqual([1, 2, 3]);
  });
});

describe("the messages, one bubble per language", () => {
  it("each category is its English message, then its Turkish one", () => {
    const m = buildOwnerIntroMessages([3]);
    expect(m).toEqual([EN[2], TR[2]]);
  });

  it("all three: six bubbles, 1 EN, 1 TR, 2 EN, 2 TR, 3 EN, 3 TR", () => {
    expect(buildOwnerIntroMessages([1, 2, 3])).toEqual([EN[0], TR[0], EN[1], TR[1], EN[2], TR[2]]);
  });

  it("links are on the app's own host: matchtime.ai and matchtime.ai/play in production", () => {
    delete process.env.NEXTAUTH_URL;
    const m = buildOwnerIntroMessages([1, 2]);
    expect(m[0]).toContain("Have a look: https://matchtime.ai\n");
    expect(m[2]).toContain("Sign up here: https://matchtime.ai/play");
    expect(m[3]).toContain("Buradan kaydolun: https://matchtime.ai/play");
    process.env.NEXTAUTH_URL = "https://staging.example/";
    expect(buildOwnerIntroMessages([2])[0]).toContain("https://staging.example/play");
  });
});

describe("the copy keeps the house rules and the approved words", () => {
  it("no em or en dash, no slash between words", () => {
    for (const l of [...EN, ...TR].map((s) => s.replace(/https:\/\/\S+/g, ""))) {
      expect(l).not.toMatch(/[—–]/);
      expect(l).not.toMatch(/\w\/\w/);
    }
  });

  it("never a waiting list", () => {
    expect([...EN, ...TR].filter((l) => /waiting list|bekleme listesi/i.test(l))).toEqual([]);
  });

  it("every Turkish message differs from the English", () => {
    EN.forEach((en, i) => expect(TR[i]).not.toBe(en));
  });

  it("category 3 names the profile's own heading, word for word, in each language", () => {
    expect(EN[2]).toContain(`*${poolPageCopy("en").member.heading}*`);
    expect(TR[2]).toContain(`*${poolPageCopy("tr").member.heading}*`);
  });
});

describe("only the platform owner", () => {
  const approvers = ["447700900444"];
  it("is the self-join approver, by the envelope phone or its alt phone", () => {
    expect(isPlatformOwnerSender({ phone: "+447700900444" }, approvers)).toBe(true);
    expect(isPlatformOwnerSender({ phone: null, senderAltPhone: "447700900444" }, approvers)).toBe(true);
  });
  it("is nobody else, and nobody at all when no approver is set", () => {
    expect(isPlatformOwnerSender({ phone: "+447700900001" }, approvers)).toBe(false);
    expect(isPlatformOwnerSender({ phone: null }, approvers)).toBe(false);
    expect(isPlatformOwnerSender({ phone: "+447700900444" }, [])).toBe(false);
  });
});

describe("sending", () => {
  it("queues each bubble through the owner DM door, in order, keyed on the DM it answers", async () => {
    const queued: Array<{ text: string; purpose: string; refId: string }> = [];
    const r = await sendOwnerIntroMessages({
      categories: [2],
      waMessageId: "wa-1",
      queue: async (text, purpose, refId) => {
        queued.push({ text, purpose, refId });
        return { queued: 1, skipped: 0 };
      },
    });
    expect(queued).toEqual([
      { text: EN[1], purpose: OWNER_INTRO_PURPOSE, refId: "intro:wa-1:2:en" },
      { text: TR[1], purpose: OWNER_INTRO_PURPOSE, refId: "intro:wa-1:2:tr" },
    ]);
    expect(r).toEqual({ categories: [2], queued: 2 });
  });
});
