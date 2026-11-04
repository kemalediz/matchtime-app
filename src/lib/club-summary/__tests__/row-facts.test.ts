/**
 * THE ROW FACTS ARE THE SUMMARY'S FACTS (slices A3 and A4). `clubRowFacts`
 * is what the admin group, the DMs and the web pages read about a club from
 * its row alone; for every club shape each of its fields must equal the
 * same field of that club's whole summary, so the two can never say
 * different things. Its two facts the whole summary does not carry yet
 * (`payments.switches`, `routine.teamsReadyChosen`) are the row's columns.
 */
import { describe, expect, it } from "vitest";
import { buildClubSummary, clubRowFacts } from "../derive";
import { FNF, NOW, SHAPES, SUTTON, orgRow } from "./fixtures";

describe("clubRowFacts: the summary's facts of the club's row", () => {
  for (const [name, rows] of Object.entries(SHAPES)) {
    it(`equals the whole summary's fields: ${name}`, () => {
      const whole = buildClubSummary(rows, NOW);
      const row = clubRowFacts(rows.org, rows.features);
      const { months: _months, ...squad } = whole.squad;
      const { collector, ...payments } = whole.payments;
      expect(row).toEqual({
        orgId: whole.orgId,
        name: whole.name,
        language: whole.language,
        lifecycle: whole.lifecycle,
        groups: whole.groups,
        features: whole.features,
        teamLabels: whole.teamLabels,
        routine: { ...whole.routine, teamsReadyChosen: rows.org.teamsReadyTime != null },
        squad,
        payments: {
          ...payments,
          collector: collector ? { userId: collector.userId } : null,
          switches: { payByBank: rows.org.payMethodPayByBank, card: rows.org.payMethodCard, direct: rows.org.payMethodDirect },
        },
      });
    });
  }

  it("is a plain value (survives a JSON round trip)", () => {
    const row = clubRowFacts(SHAPES.VETS.org, SHAPES.VETS.features);
    expect(JSON.parse(JSON.stringify(row))).toEqual(row);
  });

  it("the pay method switches are as stored, not what a player can use", () => {
    const org = orgRow({ id: "o", name: "o", payMethodCard: true, payMethodPayByBank: false, payMethodDirect: false, stripeChargesEnabled: false });
    const row = clubRowFacts(org, SUTTON.features);
    expect(row.payments.switches).toEqual({ payByBank: false, card: true, direct: false });
    expect(row.payments.methods).toEqual({ payByBank: false, card: false, direct: false });
  });

  it("Teams ready chosen: only when an organiser set a time or off", () => {
    expect(clubRowFacts(orgRow({ id: "o", name: "o" }), FNF.features).routine.teamsReadyChosen).toBe(false);
    expect(clubRowFacts(orgRow({ id: "o", name: "o", teamsReadyTime: "off" }), FNF.features).routine.teamsReadyChosen).toBe(true);
  });
});
