/**
 * `loadOrganisersAnnounce(orgId)`: the by-id read other modules (the HQ
 * team review) call to ask "do this club's organisers announce the list
 * and teams?". A failed read is "no": MatchTime keeps posting as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
vi.mock("@/lib/db", () => ({ db: { organisation: { findUnique: (...a: unknown[]) => findUnique(...a) } } }));

import { loadOrganisersAnnounce } from "@/lib/list-announcer-store";

beforeEach(() => findUnique.mockReset());

describe("loadOrganisersAnnounce", () => {
  it("true only for 'organisers'", async () => {
    findUnique.mockResolvedValueOnce({ listAnnouncer: "organisers" });
    expect(await loadOrganisersAnnounce("org-fnf")).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "org-fnf" }, select: { listAnnouncer: true } });
    findUnique.mockResolvedValueOnce({ listAnnouncer: "matchtime" });
    expect(await loadOrganisersAnnounce("org-sutton")).toBe(false);
    findUnique.mockResolvedValueOnce(null);
    expect(await loadOrganisersAnnounce("org-gone")).toBe(false);
  });

  it("a failed read is false, never a throw", async () => {
    findUnique.mockRejectedValueOnce(new Error("column does not exist"));
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    expect(await loadOrganisersAnnounce("org-fnf")).toBe(false);
  });
});
