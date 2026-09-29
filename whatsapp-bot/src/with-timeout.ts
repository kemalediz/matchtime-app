/**
 * Reject if a promise has not settled within `ms`.
 *
 * 2026-06-12: guards the single serialized send queue against a send that
 * never resolves (an invalid / not-on-WhatsApp number can hang forever in
 * whatsapp-web.js), which would otherwise freeze ALL outbound traffic for
 * every group. Shared by the club scheduler and the platform poller.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
