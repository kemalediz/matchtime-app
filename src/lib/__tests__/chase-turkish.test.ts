/**
 * The scheduled chases in a second language (Phase 2 slice 3).
 *
 * Three seams, per design section 4.3, each pinned here:
 *
 *   1. The language line rides in the UNCACHED tail. The system prompt
 *      and the Match Context are byte-identical between an English and
 *      a Turkish call for the same world, so an English club's prompt
 *      cache is never invalidated by a Turkish club existing; the
 *      English request carries no language block at all (its bytes are
 *      what every English chase has always been sent).
 *   2. The server-computed roster header is the table's: a Turkish
 *      clock block says "Use roster header: *Bu akşam oynayanlar:*",
 *      and the English one still says "*Playing tonight:*".
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
    content: [{ type: "text", text: "Need 10 more for Tuesday." }],
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

import {
  applyHouseStyle,
  buildMatchClockBlock,
  composeChaseFromMatch,
  enforceProximity,
  rosterHeaderFor,
  type ChaseComposeMatch,
} from "@/lib/message-analyzer";

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
    orgName: "Erdal FC",
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

describe("seam 1: the language line is in the uncached tail", () => {
  it("the cached system prompt and Match Context are byte-identical across languages", async () => {
    const en = await request("en");
    const tr = await request("tr");
    expect(tr.system).toEqual(en.system);
    expect(blocks(tr)[0].cache_control).toBeTruthy();
    expect(blocks(tr)[0].text).toBe(blocks(en)[0].text);
  });

  it("the Turkish tail names the language, the headers and the register; the English one has no language block", async () => {
    const en = blocks(await request("en"))[1].text;
    const tr = blocks(await request("tr"))[1].text;
    expect(en).not.toContain("## Language");
    expect(tr).toContain("## Language");
    expect(tr).toContain("TURKISH");
    expect(tr).toContain("*Yedekler (N):*");
    expect(tr).toContain("Belki: <Name> (kimse çıkmazsa oynar)");
    expect(tr).toContain("🗓 Kadro durumu");
    expect(tr).toContain("8 Eylül Salı 21:30");
    expect(tr).toContain("*VARIM*");
    expect(tr).toMatch(/No greeting/);
    // The uncached tail carries no cache marker in either language.
    expect(blocks(await request("tr"))[1].cache_control).toBeUndefined();
  });

  it("the Turkish tail is appended AFTER the kind instruction, which is unchanged", async () => {
    // The uncached block is clock + kind instruction (+ tail). The clock
    // half differs by design (the Turkish header and kickoff line), so
    // the comparison starts at the kind instruction.
    const chase = (s: string) => s.slice(s.indexOf("## Chase type"));
    const en = chase(blocks(await request("en"))[1].text);
    const tr = chase(blocks(await request("tr"))[1].text);
    expect(tr.startsWith(en)).toBe(true);
    expect(tr.length).toBeGreaterThan(en.length);
  });
});

describe("seam 2: the roster header is the table's", () => {
  it("Turkish clock block: this-week header carries the Turkish day", () => {
    const block = at(TWO_DAYS_BEFORE, () => buildMatchClockBlock(KICKOFF, "tr"));
    expect(block).toContain("Use roster header: *8 Eylül Salı oynayanlar:*");
    expect(block).toContain("Kickoff (London): Tue 8 Sept at 21:30");
    expect(block).toContain("Kickoff (tr): 8 Eylül Salı 21:30");
  });

  it("Turkish clock block: tonight and tomorrow", () => {
    expect(at("2026-09-08T18:00:00.000Z", () => buildMatchClockBlock(KICKOFF, "tr"))).toContain(
      "Use roster header: *Bu akşam oynayanlar:*",
    );
    expect(at("2026-09-08T06:00:00.000Z", () => buildMatchClockBlock(KICKOFF, "tr"))).toContain(
      "Use roster header: *Yarın oynayanlar:*",
    );
  });

  it("English clock block is byte-identical with and without the language argument", () => {
    const a = at(TWO_DAYS_BEFORE, () => buildMatchClockBlock(KICKOFF));
    const b = at(TWO_DAYS_BEFORE, () => buildMatchClockBlock(KICKOFF, "en"));
    expect(b).toBe(a);
    expect(a).toContain("Use roster header: *Playing Tue 8 Sept:*");
    expect(a).not.toContain("Kickoff (en)");
  });

  it("rosterHeaderFor agrees with the clock block", () => {
    expect(at("2026-09-08T18:00:00.000Z", () => rosterHeaderFor(KICKOFF, "tr"))).toBe("*Bu akşam oynayanlar:*");
    expect(at(TWO_DAYS_BEFORE, () => rosterHeaderFor(KICKOFF, "en"))).toBe("*Playing Tue 8 Sept:*");
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

describe("house style: no dashes in a Turkish chase", () => {
  const reply = (text: string) =>
    create.mockImplementationOnce(async (args: CreateArgs) => {
      captured.push(args);
      return { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    });

  it("turns the model's em and en dashes into commas for Turkish", async () => {
    reply("Kadro durumu — 3 kişi eksiğiz – yazın.\n\n*8 Eylül Salı oynayanlar:*\n1. Kemal Ediz");
    const tr = await composeChaseFromMatch({ kind: "daily-in-list", orgName: "Erdal FC", match: MATCH, lang: "tr" });
    expect(tr).toBe("Kadro durumu, 3 kişi eksiğiz, yazın.\n\n*8 Eylül Salı oynayanlar:*\n1. Kemal Ediz");
  });

  it("leaves English output alone", async () => {
    reply("Squad update — need 3 more.\n\n*Playing Tue 8 Sept:*\n1. Kemal Ediz");
    const en = await composeChaseFromMatch({ kind: "daily-in-list", orgName: "Sutton FC", match: MATCH, lang: "en" });
    expect(en).toBe("Squad update — need 3 more.\n\n*Playing Tue 8 Sept:*\n1. Kemal Ediz");
  });

  it("applyHouseStyle is a no-op for English and for dash-free Turkish", () => {
    expect(applyHouseStyle("a — b", "en")).toBe("a — b");
    expect(applyHouseStyle("a, b", "tr")).toBe("a, b");
    expect(applyHouseStyle("a — b", "tr")).toBe("a, b");
    expect(applyHouseStyle("a—b", "tr")).toBe("a, b");
    expect(applyHouseStyle("**eksik adamız** yazın", "tr")).toBe("*eksik adamız* yazın");
    expect(applyHouseStyle("**bold**", "en")).toBe("**bold**");
  });
});
