/**
 * Did this Auth.js answer really sign someone out (round 3 of #607)? It did
 * when it clears the session cookie: Auth.js's `signOut` action ends with
 * `sessionStore.clean()`, an empty session cookie (or each of its chunks)
 * that expires at once. A refused sign-out (no CSRF token) and a sign-out
 * with nobody signed in send none. Reads Set-Cookie headers, a protocol
 * format, not anything a person wrote.
 */

/** "authjs.session-token", its Secure-prefixed form, and their chunks (".0", ".1", ...). */
const SESSION_COOKIE = /^(__Secure-)?authjs\.session-token(\.\d+)?$/;

export function signOutClearedSession(setCookies: readonly string[]): boolean {
  return setCookies.some((c) => {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq < 0) return false;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    return SESSION_COOKIE.test(name) && value === "";
  });
}
