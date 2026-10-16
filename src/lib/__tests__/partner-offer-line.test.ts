/**
 * The organisers' short-squad notice and the partner line (slice S5).
 *
 * With no partner club to ask (Sutton FC and every club today) the notice
 * is returned BYTE FOR BYTE as it was; with one, it ends with one line
 * naming the partner and the link, in the club's language. And the line
 * can only ever be added inside `toOrganisers`, which a club on
 * "MatchTime announces" (Sutton FC) never reaches: its chases are posted
 * in its own group as before.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withPartnerOffer } from "../partner-ask-rules";

const NOTICE = "📋 *Friday 9-a-side*, Fri 30 Oct at 20:30: 17 of 18 in, 1 place open.";

describe("withPartnerOffer", () => {
  it("no partner: the notice is unchanged, byte for byte", () => {
    expect(withPartnerOffer(NOTICE, null, "https://x/m", "en")).toBe(NOTICE);
    expect(withPartnerOffer(NOTICE, [], "https://x/m", "en")).toBe(NOTICE);
  });
  it("a partner: one line at the end, with the link", () => {
    expect(withPartnerOffer(NOTICE, ["Sutton FC"], "https://x/m", "en")).toBe(
      `${NOTICE}\n\n🤝 Want me to ask Sutton FC for a player? Open the match page: https://x/m`,
    );
  });
  it("in Turkish", () => {
    expect(withPartnerOffer(NOTICE, ["Sutton FC"], "https://x/m", "tr")).toContain("Sutton FC kulübünden oyuncu isteyeyim mi?");
  });
});

describe("the scheduler adds it only on the organisers' short-squad notices", () => {
  const src = readFileSync(join(__dirname, "..", "bot-scheduler.ts"), "utf8");
  it("every partner offer is passed to toOrganisers, never to a players' group post", () => {
    const calls = src.match(/partnerOffer: await partnerOffer\(\)/g) ?? [];
    expect(calls).toHaveLength(3);
    for (const line of src.split("\n").filter((l) => l.includes("partnerOffer: await partnerOffer()"))) {
      expect(line).toMatch(/if \(organisers\) await toOrganisers\(key, "chase", \{ partnerOffer: await partnerOffer\(\) \}\);/);
    }
  });
});
