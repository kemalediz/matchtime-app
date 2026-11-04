/**
 * THE ROW FACTS ARE THE SUMMARY'S FACTS (slice A3). `clubRowFacts` is what
 * the admin group and the DMs read about a club from its row alone; for
 * every club shape each of its fields must equal the same field of that
 * club's whole summary, so the two can never say different things.
 */
import { describe, expect, it } from "vitest";
import { buildClubSummary, clubRowFacts } from "../derive";
import { NOW, SHAPES } from "./fixtures";

describe("clubRowFacts: the summary's facts of the club's row", () => {
  for (const [name, rows] of Object.entries(SHAPES)) {
    it(`equals the whole summary's fields: ${name}`, () => {
      const whole = buildClubSummary(rows, NOW);
      const row = clubRowFacts(rows.org, rows.features);
      const { months: _months, ...squad } = whole.squad;
      const { collector, collectionLive: _live, ...payments } = whole.payments;
      expect(row).toEqual({
        orgId: whole.orgId,
        name: whole.name,
        language: whole.language,
        lifecycle: whole.lifecycle,
        groups: whole.groups,
        features: whole.features,
        teamLabels: whole.teamLabels,
        routine: whole.routine,
        squad,
        payments: { ...payments, collector: collector ? { userId: collector.userId } : null },
      });
    });
  }

  it("is a plain value (survives a JSON round trip)", () => {
    const row = clubRowFacts(SHAPES.VETS.org, SHAPES.VETS.features);
    expect(JSON.parse(JSON.stringify(row))).toEqual(row);
  });
});
