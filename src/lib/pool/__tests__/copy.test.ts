/**
 * The pool's DMs (slice L2): composed from the string tables with the
 * limits read from rules.ts, never typed into a sentence, in English and
 * Turkish, each with the links it must carry.
 */
import { describe, expect, it } from "vitest";
import { POOL_CAPS, POOL_QUIET_HOURS } from "../rules";
import { poolAlreadyText, poolCodeReplyText, poolFirstName, poolWelcomeText } from "../copy";

const LINK = "https://matchtime.test/r/abc123";

describe("the welcome", () => {
  it("names him, says the limits from rules.ts, carries the manage and privacy links (EN)", () => {
    const s = poolWelcomeText("en", { displayName: "Ali Kaya", earlyList: false, manageLink: LINK });
    expect(s).toMatch(/^✅ Thanks Ali, you're in the MatchTime player pool/);
    expect(s).toContain(`At most ${POOL_CAPS.perPlayerPerWeek} a week`);
    expect(s).toContain(`between ${POOL_QUIET_HOURS.from} and ${POOL_QUIET_HOURS.to}`);
    expect(s).toContain(LINK);
    expect(s).toMatch(/\/privacy$/);
  });

  it("in Turkish", () => {
    const s = poolWelcomeText("tr", { displayName: "Ali Kaya", earlyList: false, manageLink: LINK });
    expect(s).toMatch(/^✅ Teşekkürler Ali, MatchTime oyuncu havuzuna katıldın/);
    expect(s).toContain(`Haftada en fazla ${POOL_CAPS.perPlayerPerWeek} kez`);
    expect(s).toContain(LINK);
  });

  it("the early sign-up list says it is not open yet, never 'waiting list'", () => {
    const en = poolWelcomeText("en", { displayName: "Ali", earlyList: true, manageLink: LINK });
    expect(en).toContain("early sign-up list");
    expect(en).toContain("not open near you yet");
    expect(en).not.toMatch(/waiting list/i);
    const tr = poolWelcomeText("tr", { displayName: "Ali", earlyList: true, manageLink: LINK });
    expect(tr).toContain("erken kayıt listesine");
    expect(tr).not.toMatch(/bekleme listesi/i);
  });
});

describe("the other replies", () => {
  it("already in the pool: the manage link", () => {
    expect(poolAlreadyText("en", LINK)).toContain(LINK);
    expect(poolAlreadyText("tr", LINK)).toContain(LINK);
  });

  it("a code that did not work points at /play, and never carries a code", () => {
    for (const kind of ["expired", "wrong-code"] as const) {
      for (const lang of ["en", "tr"] as const) {
        const s = poolCodeReplyText(kind, lang);
        expect(s).toMatch(/\/play$/);
        expect(s).not.toMatch(/\b[A-Z2-9]{4}\b/);
      }
    }
  });
});

describe("poolFirstName", () => {
  it("the first word of the name, or nothing", () => {
    expect(poolFirstName("Ali Kaya")).toBe("Ali");
    expect(poolFirstName("  ")).toBeNull();
    expect(poolFirstName(null)).toBeNull();
  });
});
