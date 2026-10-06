/**
 * THE HOUSE STYLE FOR MODEL-WRITTEN TEXT: no em dash, no en dash.
 *
 * Kemal, 2026-10-06: "remove long dashes". The fixed copy is handled in
 * the string tables (see `no-long-dashes.test.ts`); this file pins the
 * deterministic pass every model-composed message goes through before it
 * is sent, in English as well as Turkish. A prompt can ask the model not
 * to write a dash, and it writes one anyway (measured 2026-09-17: 5 of
 * 25 Turkish chases), so the rule is applied rather than hoped for.
 *
 * The pass must never damage what surrounds a dash: WhatsApp bold and
 * italics, links, scores, times and hyphenated names.
 */
import { describe, expect, it } from "vitest";

import { applyHouseStyle, hasLongDash, stripLongDashes } from "@/lib/house-style";

describe("stripLongDashes: a dash between two clauses becomes a comma", () => {
  it("spaced and unspaced em dashes, spaced en dashes", () => {
    expect(stripLongDashes("Squad update — need 3 more.", "en")).toBe("Squad update, need 3 more.");
    expect(stripLongDashes("Squad update—need 3 more.", "en")).toBe("Squad update, need 3 more.");
    expect(stripLongDashes("Squad update – need 3 more.", "en")).toBe("Squad update, need 3 more.");
  });

  it("leaves dash-free text exactly as it was", () => {
    const text = "We're 11/14, need 3 more.\n\n*Playing tonight:*\n1. Kemal Ediz\n2. 🥁";
    expect(stripLongDashes(text, "en")).toBe(text);
    expect(stripLongDashes("7-a-side at 21:30, well-known", "en")).toBe("7-a-side at 21:30, well-known");
  });

  it("never leaves a doubled comma or a space before one", () => {
    expect(stripLongDashes("Kemal, — you're in", "en")).toBe("Kemal, you're in");
    expect(stripLongDashes("Kemal — , you're in", "en")).toBe("Kemal, you're in");
  });

  it("works line by line and never joins two lines", () => {
    expect(stripLongDashes("Need 3 more —\nreply IN", "en")).toBe("Need 3 more\nreply IN");
    expect(stripLongDashes("a — b\nc — d", "en")).toBe("a, b\nc, d");
  });
});

describe("stripLongDashes: a bold label that opens a line takes a colon", () => {
  it("English: the label rule", () => {
    expect(stripLongDashes("🗓 *Tuesday 7-a-side* — need *1 more*.", "en")).toBe(
      "🗓 *Tuesday 7-a-side*: need *1 more*.",
    );
    expect(stripLongDashes("*Low numbers* — 8/14 confirmed", "en")).toBe("*Low numbers*: 8/14 confirmed");
    expect(stripLongDashes("intro\n⚽ *Tonight at 21:30* — *Tuesday 7-a-side* at Sim Arena", "en")).toBe(
      "intro\n⚽ *Tonight at 21:30*: *Tuesday 7-a-side* at Sim Arena",
    );
  });

  it("bold in the middle of a sentence is not a label", () => {
    expect(stripLongDashes("We need *1 more* — reply IN", "en")).toBe("We need *1 more*, reply IN");
  });

  it("Turkish keeps the comma it has always had", () => {
    expect(stripLongDashes("🗓 *Salı maçı* — 1 kişi eksik", "tr")).toBe("🗓 *Salı maçı*, 1 kişi eksik");
  });
});

describe("stripLongDashes: WhatsApp formatting survives", () => {
  it("bold, italic and strikethrough markers keep hugging their text", () => {
    expect(stripLongDashes("*Squad complete — 14/14* for tonight", "en")).toBe("*Squad complete, 14/14* for tonight");
    expect(stripLongDashes("So *Kemal —* is in", "en")).toBe("So *Kemal* is in");
    expect(stripLongDashes("So *— Kemal* is in", "en")).toBe("So *Kemal* is in");
    expect(stripLongDashes("_(3 short — reply IN)_", "en")).toBe("_(3 short, reply IN)_");
    expect(stripLongDashes("~old — plan~ new plan", "en")).toBe("~old, plan~ new plan");
  });

  it("every asterisk, underscore and tilde is still there", () => {
    const text = "🚨 *Match in trouble* — only *8* confirmed — _reply IN_ — ~maybe~";
    const out = stripLongDashes(text, "en");
    for (const mark of ["*", "_", "~"]) {
      expect(out.split(mark).length).toBe(text.split(mark).length);
    }
    expect(hasLongDash(out)).toBe(false);
  });
});

describe("stripLongDashes: links are never touched", () => {
  it("a link is copied through whole, dash or no dash", () => {
    const url = "https://matchtime.ai/r/abc–def—ghi?x=1";
    expect(stripLongDashes(`Your link — ${url} — tap it`, "en")).toBe(`Your link, ${url}, tap it`);
    expect(stripLongDashes("Rate here — https://matchtime.ai/r/tok_en-1", "en")).toBe(
      "Rate here, https://matchtime.ai/r/tok_en-1",
    );
  });
});

describe("stripLongDashes: numbers survive", () => {
  it("a score or a range written with a long dash keeps a plain hyphen", () => {
    expect(stripLongDashes("Reds won 5–3 last week", "en")).toBe("Reds won 5-3 last week");
    expect(stripLongDashes("Reds won 5—3 last week", "en")).toBe("Reds won 5-3 last week");
    expect(stripLongDashes("Reds 5 – 3 Yellows", "en")).toBe("Reds 5-3 Yellows");
    expect(stripLongDashes("rated 6–8 most weeks", "en")).toBe("rated 6-8 most weeks");
    expect(stripLongDashes("the 2025–26 season", "en")).toBe("the 2025-26 season");
  });

  it("a time range reads 'to' in English and keeps a hyphen in Turkish", () => {
    expect(stripLongDashes("Pitch booked 21:30–22:30", "en")).toBe("Pitch booked 21:30 to 22:30");
    expect(stripLongDashes("Pitch booked 21:30 — 22:30", "en")).toBe("Pitch booked 21:30 to 22:30");
    expect(stripLongDashes("Saha 21:30–22:30 arası", "tr")).toBe("Saha 21:30-22:30 arası");
  });

  it("digits are never dropped or merged", () => {
    const out = stripLongDashes("11/14 — need 3 — kickoff 21:30 — £7.50", "en");
    expect(out).toBe("11/14, need 3, kickoff 21:30, £7.50");
  });

  it("a missing value shown as a lone dash becomes a hyphen, not a stray comma", () => {
    expect(stripLongDashes("Average rating: — (squad avg —)", "en")).toBe("Average rating: - (squad avg -)");
    expect(stripLongDashes("(— yerine)", "tr")).toBe("(- yerine)");
  });
});

describe("stripLongDashes: names survive", () => {
  it("a double-barrelled name written with an en dash keeps its hyphen", () => {
    expect(stripLongDashes("Jean–Pierre and Anne–Marie are in", "en")).toBe("Jean-Pierre and Anne-Marie are in");
    expect(stripLongDashes("7–a–side tonight", "en")).toBe("7-a-side tonight");
  });

  it("a name next to a clause dash is left whole", () => {
    expect(stripLongDashes("Kemal Ediz — you're up", "en")).toBe("Kemal Ediz, you're up");
    expect(stripLongDashes("Özgür Şahin — sıra sende", "tr")).toBe("Özgür Şahin, sıra sende");
  });
});

describe("stripLongDashes: the edges of a line", () => {
  it("a dash used as a bullet becomes a hyphen bullet", () => {
    expect(stripLongDashes("— Kemal\n– Elvin", "en")).toBe("- Kemal\n- Elvin");
  });

  it("a dash after a full stop, or before one, simply goes", () => {
    expect(stripLongDashes("See you there! — MatchTime", "en")).toBe("See you there! MatchTime");
    expect(stripLongDashes("Need 3 more —", "en")).toBe("Need 3 more");
    expect(stripLongDashes("Need 3 more —.", "en")).toBe("Need 3 more.");
  });
});

describe("applyHouseStyle", () => {
  it("English: dashes go, everything else is byte for byte", () => {
    expect(applyHouseStyle("a — b", "en")).toBe("a, b");
    expect(applyHouseStyle("a, b", "en")).toBe("a, b");
    // Markdown bold is left alone in English: only the dash rule was asked for.
    expect(applyHouseStyle("**bold**", "en")).toBe("**bold**");
    expect(applyHouseStyle("a — b", null)).toBe("a, b");
  });

  it("Turkish: dashes go and markdown bold becomes WhatsApp bold, as before", () => {
    expect(applyHouseStyle("a, b", "tr")).toBe("a, b");
    expect(applyHouseStyle("a — b", "tr")).toBe("a, b");
    expect(applyHouseStyle("a—b", "tr")).toBe("a, b");
    expect(applyHouseStyle("**eksik adamız** yazın", "tr")).toBe("*eksik adamız* yazın");
  });

  it("is idempotent", () => {
    const once = applyHouseStyle("🗓 *X* — need 3 — 21:30–22:30 — https://a.b/c–d", "en");
    expect(applyHouseStyle(once, "en")).toBe(once);
  });
});
