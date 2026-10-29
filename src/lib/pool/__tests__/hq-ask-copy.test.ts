/**
 * WHAT HQ HEARS WHEN AN ORGANISER ASKS THE POOL IN WORDS, OR SAYS YES TO
 * THE POOL NOTICE (local player pool L10). Pure: the composer over L5a's
 * copy. English and Turkish, no names, no numbers but the places.
 */
import { describe, expect, it } from "vitest";
import { poolHqAskReply } from "../offer-copy";

describe("the reply to an ask that went", () => {
  it("at once: says the pool is being asked, for how many and which game (EN, TR)", () => {
    expect(poolHqAskReply("en", { ok: true, places: 2, day: "Tue 27 Oct, 20:00", withPartners: false })).toBe(
      "🔎 Asking nearby players from the MatchTime player pool for 2 places on Tue 27 Oct, 20:00. I'll tell you here when one takes a place.",
    );
    expect(poolHqAskReply("tr", { ok: true, places: 1, day: "27 Eki Sal, 20:00", withPartners: false })).toBe(
      "🔎 27 Eki Sal, 20:00 maçı için MatchTime oyuncu havuzundaki yakın oyunculara soruyorum (1 kişi). Biri yer alınca burada haber vereceğim.",
    );
  });

  it("said in the players' group (L10): it lets them know, never \"here\"", () => {
    expect(poolHqAskReply("en", { ok: true, places: 1, day: "Tue 27 Oct, 20:00", withPartners: false, inHq: false })).toBe(
      "🔎 Asking nearby players from the MatchTime player pool for 1 place on Tue 27 Oct, 20:00. I'll let you know when one takes a place.",
    );
    expect(poolHqAskReply("tr", { ok: true, places: 1, day: "27 Eki Sal, 20:00", withPartners: true, inHq: false })).toMatch(/Biri yer alınca size haber vereceğim\.$/);
  });

  it("asked with the partner clubs (Kemal, 2026-10-29): the pool is asked now, alongside them, never \"within the hour\" (EN, TR)", () => {
    const en = poolHqAskReply("en", { ok: true, places: 1, day: "Tue 27 Oct, 20:00", withPartners: true });
    expect(en).toBe("🔎 Asking nearby players from the MatchTime player pool for 1 place on Tue 27 Oct, 20:00, at the same time as your partner clubs. I'll tell you here when one takes a place.");
    const tr = poolHqAskReply("tr", { ok: true, places: 1, day: "27 Eki Sal, 20:00", withPartners: true });
    expect(tr).toBe("🔎 27 Eki Sal, 20:00 maçı için partner kulüplerinizle aynı anda MatchTime oyuncu havuzundaki yakın oyunculara da soruyorum (1 kişi). Biri yer alınca burada haber vereceğim.");
    for (const text of [en, tr]) {
      expect(text).not.toMatch(/within the hour|bir saat içinde|[—–]/);
    }
  });
});

describe("the reply to an ask that did not go: what happened, why, and what to do next", () => {
  const ctx = {
    club: "MT Test",
    day: "Wed 28 Oct, 20:30",
    cutoffHours: 4,
    clubSwitchOff: false,
    links: { weeklyGame: "https://mt.test/admin/activities", poolSwitch: "https://mt.test/admin/settings#player-pool", partnerSettings: "https://mt.test/admin/settings#partner-clubs" },
  };
  const no = (lang: string, refusal: string, extra: Partial<typeof ctx> = {}, placesOpen = 1) =>
    poolHqAskReply(lang, { ok: false, refusal, placesOpen, ctx: { ...ctx, ...extra } });

  it("no venue (Kemal, 2026-10-28): says MatchTime does not know where the club plays, why that matters, and links the weekly game", () => {
    expect(no("en", "no-venue", { willRetry: true } as Partial<typeof ctx>)).toBe(
      "*Player pool:* I couldn't ask nearby players yet: MatchTime doesn't know where MT Test plays, and pool players are found by how close they live to the pitch. Set the venue on your weekly game here and I'll ask the pool straight away: https://mt.test/admin/activities",
    );
    expect(no("tr", "no-venue", { willRetry: true } as Partial<typeof ctx>)).toMatch(/Haftalık maçınızın sahasını buradan girin, havuza hemen sorayım: https:\/\/mt\.test\/admin\/activities$/);
    // Not kept for a retry (a YES to the notice): ask again yourself.
    expect(no("en", "no-venue")).toBe(
      "*Player pool:* I couldn't ask nearby players yet: MatchTime doesn't know where MT Test plays, and pool players are found by how close they live to the pitch. Set the venue on your weekly game, then ask me again: https://mt.test/admin/activities",
    );
    expect(no("tr", "no-venue")).toBe(
      "*Oyuncu havuzu:* Yakındaki oyunculara henüz soramadım: MatchTime, MT Test kulübünün nerede oynadığını bilmiyor ve havuz oyuncuları sahaya ne kadar yakın oturduklarına göre bulunuyor. Haftalık maçınızın sahasını girin, sonra bana yeniden sorun: https://mt.test/admin/activities",
    );
  });

  it("the pool not open: the platform's line, or the club's own switch with its card's link", () => {
    expect(no("en", "pool-closed")).toBe(
      "*Player pool:* the MatchTime player pool is not open for your club yet. I can ask your players' group if anyone can play instead.",
    );
    expect(no("tr", "pool-closed")).toMatch(/^\*Oyuncu havuzu:\* MatchTime oyuncu havuzu kulübünüz için henüz açık değil\./);
    expect(no("en", "pool-closed", { clubSwitchOff: true })).toMatch(/switched off for your club\..+: https:\/\/mt\.test\/admin\/settings#player-pool$/);
  });

  it("a setting that can lift it links that setting; every line starts with what it is about", () => {
    expect(no("en", "too-late")).toBe(
      "*Player pool:* it's too late to ask nearby players for this game: the last ask goes out 4 hours before kickoff, as your settings say. You can change that here: https://mt.test/admin/settings#partner-clubs",
    );
    expect(no("en", "no-sport")).toMatch(/no sport set.+https:\/\/mt\.test\/admin\/activities$/);
    expect(no("en", "match-not-open")).toContain("the game on Wed 28 Oct, 20:30 has started, is over or is off");
    expect(no("en", "round-open")).toBe(
      "*Player pool:* nearby players are already being asked for this game, so I haven't asked again. I'll let you know when one takes a place.",
    );
    expect(no("en", "no-places", {}, 0)).toMatch(/every place in this game is taken/);
    expect(no("en", "bad-number", {}, 0)).toBe(no("en", "no-places", {}, 0));
    for (const r of ["pool-closed", "not-organiser", "match-not-open", "no-venue", "no-sport", "too-late", "no-places", "round-open", "club-week-cap", "none-near", "not-found"]) {
      expect(no("en", r)).toMatch(/^\*Player pool:\* /);
      expect(no("tr", r)).toMatch(/^\*Oyuncu havuzu:\* /);
      expect(no("tr", r)).not.toBe(no("en", r));
      expect(no("en", r) + no("tr", r)).not.toMatch(/[–—]|waiting list/);
    }
  });

  it("nobody found, the one pool player near already playing tonight (MT Test, 2026-10-28)", () => {
    expect(no("en", "none-near", { venue: "Goals Sutton", excluded: { "on-match": 1 } } as Partial<typeof ctx>)).toBe(
      "*Player pool:* nobody new to ask. Of the pool players near Goals Sutton, 1 is already down for this game. I can ask your players' group instead.",
    );
    expect(no("tr", "none-near", { venue: "Goals Sutton", excluded: { "on-match": 1 } } as Partial<typeof ctx>)).toBe(
      "*Oyuncu havuzu:* Sorulacak yeni kimse yok. Goals Sutton yakınındaki havuz oyuncularından 1 kişi zaten bu maç için yazılı. İsterseniz oyuncu grubunuza sorabilirim.",
    );
  });

  it("nobody found (Kemal, 2026-10-28): says why from the counts, grouped, never who", () => {
    expect(no("en", "none-near", { venue: "Goals Sutton", excluded: { "club-member": 1 } } as Partial<typeof ctx>)).toBe(
      "*Player pool:* nobody new to ask. Of the pool players near Goals Sutton, 1 is already in MT Test. The pool only reaches players outside your club.",
    );
    expect(no("tr", "none-near", { venue: "Goals Sutton", excluded: { "club-member": 1 } } as Partial<typeof ctx>)).toBe(
      "*Oyuncu havuzu:* Sorulacak yeni kimse yok. Goals Sutton yakınındaki havuz oyuncularından 1 kişi zaten MT Test kulübünde. Havuz yalnızca kulübünüz dışındaki oyunculara ulaşır.",
    );
    expect(
      no("en", "none-near", { venue: null, excluded: { "not-available": 2, format: 1, level: 1, "already-offered": 1, "on-match": 1, blocked: 3, "no-consent": 4 } } as Partial<typeof ctx>),
    ).toBe(
      "*Player pool:* nobody new to ask. Of the pool players near your pitch, 1 is already down for this game, 2 aren't free at that time, 2 play a different format or level and 1 has already been offered this game. I can ask your players' group instead.",
    );
    // Only unreachable or private reasons (or none): the plain line.
    expect(no("en", "none-near", { excluded: { blocked: 1, "not-active": 2 } } as Partial<typeof ctx>)).toBe(no("en", "none-near"));
  });
});
