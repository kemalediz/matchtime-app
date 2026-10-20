/**
 * The scheduled chases in a second language (Phase 2 slice 3; rewritten
 * with the chase prompt on 2026-10-20).
 *
 *   1. The language is a FACT in the uncached user turn. The system
 *      prompt is byte-identical between an English and a Turkish call, so
 *      an English club's prompt cache is never invalidated by a Turkish
 *      club existing.
 *   2. The squad list is the table's: a Turkish post carries the Turkish
 *      headers of `buildChaseRosterBlock`, whatever the model wrote.
 *   3. `enforceProximity` for Turkish rewrites an English-habit header
 *      to the Turkish one and fixes a UTC time, and does NOT run the
 *      English relative-day grammar over Turkish prose.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Block = { type: string; text: string; cache_control?: unknown };
type CreateArgs = {
  system: Block[];
  messages: Array<{ role: string; content: string | Block[] }>;
};
const captured: CreateArgs[] = [];
const create = vi.fn(async (args: CreateArgs) => {
  captured.push(args);
  return {
    content: [{ type: "text", text: JSON.stringify({ lead: "Need 11 more for Tuesday." }) }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
});

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create };
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

import { applyHouseStyle, composeChaseFromMatch, enforceProximity, type ChaseComposeMatch } from "@/lib/message-analyzer";

/** Tue 8 Sept 2026, 21:30 London (BST, 20:30Z). */
const KICKOFF = new Date("2026-09-08T20:30:00.000Z");
const TWO_DAYS_BEFORE = "2026-09-06T11:00:00.000Z";

function at<T>(nowIso: string, fn: () => T): T {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(nowIso));
  try {
    return fn();
  } finally {
    vi.useRealTimers();
  }
}

const MATCH: ChaseComposeMatch = {
  date: KICKOFF,
  status: "UPCOMING",
  maxPlayers: 14,
  activity: { name: "Cuma Maçı", venue: "Sim Arena" },
  attendances: ["Kemal Ediz", "Elvin Aliyev", "Çağrı Yılmaz"].map((name, i) => ({
    status: "CONFIRMED",
    user: { id: `u${i}`, name, phoneNumber: "+447700900000" },
  })),
};

async function request(lang: "en" | "tr"): Promise<CreateArgs> {
  captured.length = 0;
  await composeChaseFromMatch({
    kind: "daily-in-list",
    match: MATCH,
    alternatives: [{ sportName: "Futbol 5'e 5", totalPlayers: 10 }],
    lang,
  });
  expect(create).toHaveBeenCalled();
  return captured[0];
}

function blocks(req: CreateArgs): Block[] {
  const content = req.messages[0]?.content;
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

beforeEach(() => {
  captured.length = 0;
  create.mockClear();
  process.env.ANTHROPIC_API_KEY = "sk-test";
  vi.useFakeTimers();
  vi.setSystemTime(new Date(TWO_DAYS_BEFORE));
});
afterEach(() => vi.useRealTimers());

describe("seam 1: the language is a fact in the uncached user turn", () => {
  it("the cached system prompt is byte-identical across languages", async () => {
    const en = await request("en");
    const tr = await request("tr");
    expect(tr.system).toEqual(en.system);
    expect(tr.system[0].cache_control).toBeTruthy();
  });

  it("the user turn names the language and writes the kickoff the Turkish way", async () => {
    const en = blocks(await request("en"))[0].text;
    const tr = blocks(await request("tr"))[0].text;
    expect(en).toContain("Language: English");
    expect(tr).toContain("Language: Turkish");
    expect(tr).toContain("Kickoff: 8 Eylül Salı 21:30");
    expect(blocks(await request("tr"))[0].cache_control).toBeUndefined();
  });

  it("the system prompt carries the Turkish register: plural, no abi, VARIM", async () => {
    const sys = (await request("tr")).system[0].text;
    expect(sys).toMatch(/plural/);
    expect(sys).toContain('no "abi"');
    expect(sys).toContain("*VARIM*");
  });
});

describe("seam 2: the squad list is the table's", () => {
  it("a Turkish post carries the Turkish list headers", async () => {
    const post = await composeChaseFromMatch({ kind: "daily-in-list", match: MATCH, lang: "tr" });
    expect(post.text).toContain("*8 Eylül Salı oynayanlar:*\n1. Kemal Ediz\n2. Elvin Aliyev\n3. Çağrı Yılmaz\n4. 🥁");
    expect(post.text).toMatch(/\n14\. 🥁$/);
    expect(post.text).not.toContain("*Playing");
  });
});

describe("seam 3: enforceProximity in Turkish", () => {
  const fix = (s: string) => at(TWO_DAYS_BEFORE, () => enforceProximity(s, KICKOFF, "tr"));

  it("rewrites an English-habit header to the Turkish one the server chose", () => {
    expect(fix("*Playing tonight:*\n1. Kemal Ediz")).toBe("*8 Eylül Salı oynayanlar:*\n1. Kemal Ediz");
  });

  it("rewrites a Turkish header with the wrong day", () => {
    expect(fix("*Bu akşam oynayanlar:*\n1. Kemal Ediz")).toBe("*8 Eylül Salı oynayanlar:*\n1. Kemal Ediz");
  });

  it("does not run the English relative-day grammar over Turkish prose", () => {
    const text = "Bu akşamki maç için hâlâ 3 kişi eksiğiz, 21:30 başlıyor.";
    expect(fix(text)).toBe(text);
    // "tonight" inside a Turkish sentence (a name, a venue) is left alone too.
    expect(fix("Tonight Bar'da buluşalım")).toBe("Tonight Bar'da buluşalım");
  });

  it("still corrects a UTC kickoff time to London wall-clock", () => {
    expect(fix("başlangıç 20:30")).toBe("başlangıç 21:30");
  });

  it("English behaviour is unchanged when the language is English or absent", () => {
    const text = "we still need 8 players for tonight's 7-a-side, kickoff 21:30.";
    const a = at(TWO_DAYS_BEFORE, () => enforceProximity(text, KICKOFF));
    const b = at(TWO_DAYS_BEFORE, () => enforceProximity(text, KICKOFF, "en"));
    expect(b).toBe(a);
    expect(a).toContain("for Tue 8 Sept's 7-a-side");
  });
});

describe("house style: no dashes in a chase line", () => {
  const reply = (lead: string) =>
    create.mockImplementationOnce(async (args: CreateArgs) => {
      captured.push(args);
      return { content: [{ type: "text", text: JSON.stringify({ lead }) }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    });

  it("turns the model's em and en dashes into commas for Turkish", async () => {
    reply("Kadro durumu — 11 kişi eksiğiz – yazın.");
    const tr = await composeChaseFromMatch({ kind: "daily-in-list", match: MATCH, lang: "tr" });
    expect(tr.lead).toBe("Kadro durumu, 11 kişi eksiğiz, yazın.");
  });

  // Until 2026-10-06 English was left alone. Kemal: "remove long dashes".
  it("turns the model's em and en dashes into commas for English too", async () => {
    reply("Squad update — need 11 more – reply IN.");
    const en = await composeChaseFromMatch({ kind: "daily-in-list", match: MATCH, lang: "en" });
    expect(en.lead).toBe("Squad update, need 11 more, reply IN.");
  });

  it("an English line with no dash is byte for byte what the model wrote", async () => {
    const text = "🗓 *Cuma Maçı*: need *11 more* for Tue 8 Sept, kickoff 21:30.";
    reply(text);
    const en = await composeChaseFromMatch({ kind: "daily-in-list", match: MATCH, lang: "en" });
    expect(en.lead).toBe(text);
    expect(en.fromModel).toBe(true);
  });

  it("applyHouseStyle strips dashes in both languages and leaves dash-free text alone", () => {
    expect(applyHouseStyle("a — b", "en")).toBe("a, b");
    expect(applyHouseStyle("a, b", "en")).toBe("a, b");
    expect(applyHouseStyle("a, b", "tr")).toBe("a, b");
    expect(applyHouseStyle("a — b", "tr")).toBe("a, b");
    expect(applyHouseStyle("a—b", "tr")).toBe("a, b");
    expect(applyHouseStyle("**eksik adamız** yazın", "tr")).toBe("*eksik adamız* yazın");
    expect(applyHouseStyle("**bold**", "en")).toBe("**bold**");
  });
});
