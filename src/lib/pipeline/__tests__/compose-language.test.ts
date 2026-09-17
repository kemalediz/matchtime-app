/**
 * `compose()` speaks the group's language.
 *
 * The state carries `features.language` (from `Organisation.language`
 * via `load-state.ts`); the composer reads it once and the speech kinds
 * moved into the string table render Turkish for a "tr" world and
 * English for everything else. The full rendered documents are the
 * golden snapshots (`src/lib/i18n/__tests__/__snapshots__/copy.*.snap`);
 * this file pins the three properties a reviewer should be able to
 * check without opening them:
 *
 *   1. an English world is untouched (Sutton FC never sees a Turkish word);
 *   2. a Turkish world gets Turkish for the migrated kinds, with the
 *      Turkish team labels and kickoff label the loader would have set;
 *   3. an unknown language is English, never a blank.
 */
import { describe, it, expect } from "vitest";
import { compose } from "../compose";
import type { EngineResult, SpeechIntent, SquadState } from "../types";
import { world } from "./helpers";

const ELEVEN = ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "adam", "efat", "usama"];
const FOURTEEN = [...ELEVEN, "karahan", "zair", "wasim"];

function say(state: SquadState, ...speech: SpeechIntent[]): string[] {
  const result: EngineResult = { outcomes: [], writes: [], nextState: state, speech, degradations: [] };
  return compose(result).utterances.map((u) => u.text);
}

function turkish(over: Parameters<typeof world>[0] = {}): SquadState {
  const w = world({ ...over, features: { language: "tr" } });
  // What `load-state.ts` sets for a Turkish org before the composer runs.
  w.kickoffLabel = "Salı 21:30";
  w.teamLabels = ["Kırmızı", "Sarı"];
  return w;
}

describe("compose(): an English world is untouched", () => {
  it("squad status, teams and slot-opened read exactly as before", () => {
    const short = world({ confirmed: ELEVEN, bench: ["erdal"] });
    expect(say(short, { kind: "squad_status", messageId: null })[0]).toMatch(
      /^📋 Based on all the messages I've picked up, here's the latest squad and bench — \*11\/14\*, need \*3 more\* 🙏\n\n\*Playing:\*\n1\. Kemal Ediz/,
    );
    const thirteen = world({ confirmed: FOURTEEN.slice(0, 13) });
    expect(say(thirteen, { kind: "slot_opened", messageId: "m", outNames: ["Wasim Akhtar"] })[0]).toBe(
      "Wasim is out, 13 of 14 for Tue 21:30. One slot open, say *IN* to take it.",
    );
  });
});

describe("compose(): a Turkish world speaks Turkish", () => {
  it("squad status: Turkish lead, headers and bench header", () => {
    const text = say(turkish({ confirmed: ELEVEN, bench: ["erdal"] }), { kind: "squad_status", messageId: null })[0];
    expect(text).toMatch(/^📋 Aldığım mesajlara göre son kadro ve yedekler: \*11\/14\*, \*3 kişi daha\* lazım 🙏\n\n\*Oynayanlar:\*\n1\. Kemal Ediz/);
    expect(text).toContain("*Yedekler (1):*\n1. Erdal Ozkan");
    expect(text).toContain("12. 🥁");
    expect(text).not.toMatch(/Playing|Bench|squad/);
  });

  it("a full squad: 'kadro tamam'", () => {
    const text = say(turkish({ confirmed: FOURTEEN }), { kind: "squad_status", messageId: null })[0];
    expect(text).toContain("*14/14* ✅ kadro tamam.");
  });

  it("teams post: Turkish header, Turkish default labels, the Turkish typed swap command", () => {
    const teams: Record<string, "RED" | "YELLOW"> = {};
    FOURTEEN.forEach((k, i) => (teams[k] = i % 2 === 0 ? "RED" : "YELLOW"));
    const text = say(turkish({ confirmed: FOURTEEN, teams }), { kind: "teams_post", messageId: "m" })[0];
    expect(text).toMatch(/^⚽ \*Bu akşamın takımları\*, Salı 21:30, Goals North Cheam\n\n\*Kırmızı\*:\n1\. Kemal Ediz/);
    expect(text).toContain("*Sarı*:\n1. Elvin Aliyev");
    // The typed command is the Turkish form the bot parses
    // (`TR_TEAM_COMMANDS.swapPlayers`, `parseSwapNames`), tagged.
    expect(text).toMatch(/İtirazınız mı var\? `@Match Time X ile Y'yi değiştir` yazın, admin onaylar\.$/);
  });

  it("slot opened: names joined with 've', the count spelled out, VARIM as the token", () => {
    const twelve = turkish({ confirmed: FOURTEEN.slice(0, 12) });
    expect(say(twelve, { kind: "slot_opened", messageId: "m", outNames: ["Wasim Akhtar", "Zair Malik"] })[0]).toBe(
      "Wasim ve Zair çıktı, Salı 21:30 için 12 kişiyiz, kadro 14 kişilik. 2 yer açıldı, almak için *VARIM* yazın.",
    );
    const thirteen = turkish({ confirmed: FOURTEEN.slice(0, 13) });
    expect(say(thirteen, { kind: "slot_opened", messageId: "m", outNames: [] })[0]).toBe(
      "Salı 21:30 için 13 kişiyiz, kadro 14 kişilik. Bir yer açıldı, almak için *VARIM* yazın.",
    );
  });

  it("bench offer open: Turkish, names joined with 've'", () => {
    const text = say(turkish({ confirmed: ELEVEN, bench: ["erdal", "amir"] }), {
      kind: "bench_offer_open",
      messageId: "m",
      replacingName: "Sait Demir",
    })[0];
    expect(text).toBe("Bir yer açıldı 🎟 Erdal Ozkan ve Amir Ahmadi, ilk VARIM yazan alır. Kimse çıkarılmıyor.");
  });

  it("the answer_squad kind uses the same Turkish post", () => {
    const text = say(turkish({ confirmed: ELEVEN }), { kind: "answer_squad", messageId: "m" })[0];
    expect(text).toMatch(/^📋 Aldığım mesajlara göre son kadro: \*11\/14\*/);
  });
});

describe("compose(): an unknown language is English", () => {
  it("never renders a blank", () => {
    const w = world({ confirmed: ELEVEN, features: { language: "fr" as never } });
    expect(say(w, { kind: "squad_status", messageId: null })[0]).toMatch(/^📋 Based on all the messages/);
  });
});
