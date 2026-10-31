/**
 * A WHATSAPP REMOVAL BY ONE OF THE CLUB'S ORGANISERS (Kemal, 2026-10-31).
 * The Pi reports who removed whom; the server marks `removedByOrganiserAt`
 * only when the remover is an OWNER or ADMIN of THAT club and not the
 * person himself.
 */
import { describe, expect, it } from "vitest";
import { leaveIsOrganiserRemoval } from "../group-leave-rules";

const ORGANISERS = new Set(["owner", "admin"]);

describe("leaveIsOrganiserRemoval", () => {
  it("removed by the club's owner or an admin: yes", () => {
    expect(leaveIsOrganiserRemoval({ removerUserIds: ["owner"], leaverUserId: "ali", organiserUserIds: ORGANISERS })).toBe(true);
    expect(leaveIsOrganiserRemoval({ removerUserIds: ["admin"], leaverUserId: "ali", organiserUserIds: ORGANISERS })).toBe(true);
  });

  it("removed by a WhatsApp admin who is not one of the club's organisers: no", () => {
    expect(leaveIsOrganiserRemoval({ removerUserIds: ["shane"], leaverUserId: "ali", organiserUserIds: ORGANISERS })).toBe(false);
  });

  it("an unknown remover (old Pi payload, or a number MatchTime does not know): no", () => {
    expect(leaveIsOrganiserRemoval({ removerUserIds: [], leaverUserId: "ali", organiserUserIds: ORGANISERS })).toBe(false);
  });

  it("he left himself, even an organiser leaving: no", () => {
    expect(leaveIsOrganiserRemoval({ removerUserIds: ["ali"], leaverUserId: "ali", organiserUserIds: ORGANISERS })).toBe(false);
    expect(leaveIsOrganiserRemoval({ removerUserIds: ["admin"], leaverUserId: "admin", organiserUserIds: ORGANISERS })).toBe(false);
  });

  it("the remover's number and LID resolve to two accounts, one of them his own: no", () => {
    expect(leaveIsOrganiserRemoval({ removerUserIds: ["owner", "ali"], leaverUserId: "ali", organiserUserIds: ORGANISERS })).toBe(false);
  });
});
