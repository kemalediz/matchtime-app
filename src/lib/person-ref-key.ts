/**
 * The key a quoted name's who-is-who pick is filed under
 * (`pipeline/who-is-who.ts`): the words as written, trimmed, a leading @
 * dropped and runs of spaces made one. NOT a comparison of names: the
 * same quoted string from the same facts finds its answer.
 *
 * Its own module, with no imports, so the pure rule files that read a
 * pick (`team-proposal-rules.ts`, `admin-group-squad-rules.ts`) stay
 * model-free (`admin-group-model-door.source.test.ts`).
 */
export function refKey(ref: string): string {
  return (ref ?? "").normalize("NFC").trim().replace(/^@+/, "").trim().replace(/\s+/g, " ");
}
