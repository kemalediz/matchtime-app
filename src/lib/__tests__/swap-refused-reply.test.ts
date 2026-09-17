/**
 * THE REFUSED SWAP SAYS SO (2026-09-17).
 *
 * Before this, a swap the fast path could not apply produced no reply
 * at all: `handleTeamSwapIfApplicable` returned null for every refusal,
 * the message went on to the attendance pipeline, and the only thing
 * the owner ever saw was a player dropped (TR26 / TR27). The owner is
 * now told the swap was NOT applied, why, and that nobody was dropped,
 * in the group's language.
 */
import { describe, it, expect } from "vitest";
import { buildSwapRefusedReply } from "../group-copy";
import type { SwapRefusal } from "../team-slot-swap";

const WHYS: SwapRefusal[] = [
  { reason: "unknown-name", name: "Zork" },
  { reason: "ambiguous-name", name: "Omar", candidates: ["Omar One", "Omar Two"] },
  { reason: "teams-not-generated" },
  { reason: "same-player" },
  { reason: "nobody-is-playing" },
  { reason: "receiver-not-confirmed", name: "Baki Aydin" },
  { reason: "both-hold-slots", name: "Elvin Aliyev" },
  { reason: "no-slot-to-move", name: "Elvin Aliyev" },
];

describe("buildSwapRefusedReply", () => {
  it("English: says it did not swap, why, and that nobody was dropped", () => {
    expect(
      buildSwapRefusedReply({ a: "David", b: "Zork", why: WHYS[0], lang: "en" }),
    ).toBe(
      "I haven't swapped *David* and *Zork*. I can't find a player called *Zork* for this match. " +
        "Use the name they're registered under. Nothing changed and nobody was dropped.",
    );
  });

  it("Turkish: the same, in Turkish", () => {
    expect(
      buildSwapRefusedReply({ a: "David", b: "Sait Demir", why: { reason: "teams-not-generated" }, lang: "tr" }),
    ).toBe(
      "*David* ve *Sait Demir* için değişiklik yapmadım. Takımlar henüz kurulmadı. " +
        "Önce *@Match Time takımları kur* yazın. Hiçbir şey değişmedi, kimse çıkarılmadı.",
    );
  });

  for (const lang of ["en", "tr"] as const) {
    for (const why of WHYS) {
      it(`${lang}: ${why.reason} names what it is about and never says a player was dropped`, () => {
        const text = buildSwapRefusedReply({ a: "David", b: "Sait Demir", why, lang });
        expect(text).toContain("*David*");
        if ("name" in why) expect(text).toContain(`*${why.name}*`);
        if (why.reason === "ambiguous-name") expect(text).toContain("Omar One, Omar Two");
        expect(text).not.toMatch(/[—–]/);
        expect(text).toMatch(lang === "en" ? /nobody was dropped\.$/ : /kimse çıkarılmadı\.$/);
      });
    }
  }

  it("an unknown language falls back to English", () => {
    expect(buildSwapRefusedReply({ a: "A", b: "B", why: { reason: "same-player" }, lang: "xx" })).toMatch(
      /^I haven't swapped/,
    );
  });
});
