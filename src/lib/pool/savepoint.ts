/**
 * ONE STEP PER ITEM INSIDE ONE TRANSACTION (slice L5a, second review of
 * #400, item 3). A wave of offers is written under one advisory lock on its
 * ask (one transaction), but one person's failure (a unique clash, a bad
 * row) must cost only his offer, not the wave: each item runs between a
 * SAVEPOINT and its RELEASE, and a failure rolls back to it. Returns what
 * the steps that worked returned. Never throws for a step.
 */
export async function eachUnderSavepoint<T, R>(
  tx: { $executeRawUnsafe(query: string): Promise<unknown> },
  items: readonly T[],
  step: (item: T) => Promise<R>,
  onError: (item: T, err: unknown) => void = () => {},
): Promise<R[]> {
  const out: R[] = [];
  for (const [i, item] of items.entries()) {
    const sp = `pool_step_${i}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
    try {
      out.push(await step(item));
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
    } catch (err) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
      onError(item, err);
    }
  }
  return out;
}
