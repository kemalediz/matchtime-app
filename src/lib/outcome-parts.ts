/**
 * PURE. The parts of an outcome a message with several parts or actions
 * joins with "+" (2026-11-23, review of #629). These are MatchTime's own
 * outcome codes, never anybody's words. No imports: the admin group's
 * model-free door (`admin-group.ts`) reads it too.
 */
export function outcomeParts(outcome: string): string[] {
  return outcome.split("+");
}
