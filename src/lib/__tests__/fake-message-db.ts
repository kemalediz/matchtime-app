/**
 * A small in-memory stand-in for the Prisma tables a stored WhatsApp
 * message lives in, for the message-change tests (2026-11-15). It honours
 * the subset of `where`, `orderBy` and `take` the stores and their readers
 * send, so a test can apply a delete or an edit and then ask the REAL
 * readers what they return. Not a test file itself (no `.test.ts`).
 */
import { Prisma } from "@/generated/prisma/client";

export type Row = Record<string, unknown> & { id: string };

let seq = 0;

function cmp(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a ?? "").localeCompare(String(b ?? ""));
}

export function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === "NOT") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (list.some((c) => matches(row, c as Record<string, unknown>))) return false;
      continue;
    }
    if (k === "OR") {
      if (!(cond as Array<Record<string, unknown>>).some((c) => matches(row, c))) return false;
      continue;
    }
    if (k === "AND") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (!list.every((c) => matches(row, c as Record<string, unknown>))) return false;
      continue;
    }
    const v = row[k] ?? null;
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ("gte" in c && !(v instanceof Date && v >= (c.gte as Date))) return false;
      if ("gt" in c && !(v instanceof Date && v > (c.gt as Date))) return false;
      if ("lte" in c && !(v instanceof Date && v <= (c.lte as Date))) return false;
      if ("lt" in c && !(v instanceof Date && v < (c.lt as Date))) return false;
      if ("in" in c && !(c.in as unknown[]).includes(v)) return false;
      if ("notIn" in c && (c.notIn as unknown[]).includes(v)) return false;
      if ("startsWith" in c && !(typeof v === "string" && v.startsWith(c.startsWith as string))) return false;
      if ("contains" in c && !(typeof v === "string" && v.includes(c.contains as string))) return false;
      if ("not" in c && v === c.not) return false;
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}

/** Prisma's `Prisma.DbNull` and `JsonNull` are objects; stored they are null. */
function stored(v: unknown): unknown {
  return v === Prisma.DbNull || v === Prisma.JsonNull ? null : v;
}

/** `{ a_b: { a, b } }` (a compound unique key) as a plain where. */
function unique(where: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(where)) {
    if (k.includes("_") && v && typeof v === "object" && !(v instanceof Date)) Object.assign(out, v);
    else out[k] = v;
  }
  return out;
}

/** Test seam: throw from inside a write, to prove a transaction rolls back. */
export const failures: { beforeWrite?: () => void } = {};

export function makeTable(rows: Row[], uniqueKeys: string[][] = []) {
  const order = (list: Row[], orderBy: unknown): Row[] => {
    const specs = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, "asc" | "desc">>;
    if (specs.length === 0) return list;
    return [...list].sort((a, b) => {
      for (const s of specs) {
        const [[field, dir]] = Object.entries(s);
        const d = cmp(a[field], b[field]) * (dir === "desc" ? -1 : 1);
        if (d !== 0) return d;
      }
      return 0;
    });
  };
  return {
    rows,
    findMany: async (args: { where?: Record<string, unknown>; orderBy?: unknown; take?: number } = {}) => {
      const found = order(rows.filter((r) => matches(r, args.where)), args.orderBy);
      return (typeof args.take === "number" ? found.slice(0, args.take) : found).map((r) => ({ ...r }));
    },
    findFirst: async (args: { where?: Record<string, unknown>; orderBy?: unknown } = {}) => {
      const found = order(rows.filter((r) => matches(r, args.where)), args.orderBy);
      return found[0] ? { ...found[0] } : null;
    },
    findUnique: async (args: { where: Record<string, unknown> }) => {
      const r = rows.find((x) => matches(x, unique(args.where)));
      return r ? { ...r } : null;
    },
    create: async (args: { data: Record<string, unknown> }) => {
      const r = { id: `row-${++seq}`, ...Object.fromEntries(Object.entries(args.data).map(([k, v]) => [k, stored(v)])) } as Row;
      for (const key of uniqueKeys) {
        if (rows.some((x) => key.every((f) => x[f] === r[f]))) throw Object.assign(new Error("unique"), { code: "P2002" });
      }
      rows.push(r);
      return { ...r };
    },
    update: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      failures.beforeWrite?.();
      const r = rows.find((x) => matches(x, unique(args.where)));
      if (!r) throw new Error(`no row ${JSON.stringify(args.where)}`);
      for (const [k, v] of Object.entries(args.data)) r[k] = stored(v);
      return { ...r };
    },
    updateMany: async (args: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
      failures.beforeWrite?.();
      let count = 0;
      for (const r of rows) {
        if (!matches(r, args.where)) continue;
        for (const [k, v] of Object.entries(args.data)) r[k] = stored(v);
        count++;
      }
      return { count };
    },
    deleteMany: async (args: { where?: Record<string, unknown> } = {}) => {
      failures.beforeWrite?.();
      const keep = rows.filter((r) => !matches(r, args.where));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    },
  };
}

export function row(fields: Record<string, unknown>): Row {
  return { id: `row-${++seq}`, ...fields };
}

/**
 * A db over named tables, with `$transaction(fn)` that ROLLS BACK: every
 * table is restored to its state before `fn` if `fn` throws.
 */
export function makeDb(T: Record<string, Row[]>, names: string[], uniqueKeys: Record<string, string[][]> = {}) {
  /** Tables that do not exist yet (a deploy before the migration): every call throws. */
  const missing = new Set<string>();
  const gone = (n: string) =>
    new Proxy({}, { get: () => async () => Promise.reject(new Error(`relation "${n}" does not exist`)) }) as ReturnType<typeof makeTable>;
  const tables = () => Object.fromEntries(names.map((n) => [n, missing.has(n) ? gone(n) : makeTable((T[n] ??= []), uniqueKeys[n] ?? [])]));
  return {
    missing,
    get db() {
      const t = tables() as Record<string, ReturnType<typeof makeTable>>;
      return {
        ...t,
        /**
         * The one raw statement `message-change.ts` sends: the tombstone's
         * INSERT ... ON CONFLICT DO UPDATE, merged in place in one step
         * (as Postgres does), so two calls can never lose each other's values.
         */
        $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
          if (!sql.includes('INSERT INTO "DeletedMessage"')) throw new Error(`unexpected raw SQL: ${sql.slice(0, 60)}`);
          if (missing.has("deletedMessage")) throw new Error('relation "DeletedMessage" does not exist');
          const [id, chatId, waMessageId, byAdmin, reason, senderJids, senderPhones, deletedAt, changesJson] = params as [string, string, string, boolean, string, string[], string[], Date, string];
          const added = JSON.parse(changesJson ?? "[]") as unknown[];
          const rows = (T.deletedMessage ??= []);
          let r = rows.find((x) => x.chatId === chatId && x.waMessageId === waMessageId);
          /** As the SQL does: the same change (ignoring `at`) once, the first kept; at most 20, deletes first; in order. */
          const merged = (list: unknown[]) => {
            const seen = new Set<string>();
            const once = list
              .map((e, o) => ({ e: e as Record<string, unknown>, o }))
              .filter(({ e }) => {
                const { at: _at, ...rest } = e;
                void _at;
                const k = JSON.stringify(Object.keys(rest).sort().map((x) => [x, rest[x]]));
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
              });
            const kept = [...once].sort((a, b) => Number(b.e.reason === "deleted") - Number(a.e.reason === "deleted") || a.o - b.o).slice(0, 20);
            return kept.sort((a, b) => a.o - b.o).map((x) => x.e);
          };
          if (!r) {
            r = { id, chatId, waMessageId, byAdmin, reason, senderJids: [...new Set(senderJids)], senderPhones: [...new Set(senderPhones)], changes: merged(added), deletedAt, lastChangeAt: deletedAt, enforcedAt: null };
            rows.push(r);
          } else {
            r.byAdmin = (r.byAdmin as boolean) || byAdmin;
            r.reason = r.reason === "deleted" || reason === "deleted" ? "deleted" : "edited";
            r.senderJids = [...new Set([...((r.senderJids as string[]) ?? []), ...senderJids])];
            r.senderPhones = [...new Set([...((r.senderPhones as string[]) ?? []), ...senderPhones])];
            r.changes = merged([...((r.changes as unknown[]) ?? []), ...added]);
            const last = r.lastChangeAt instanceof Date ? r.lastChangeAt : (r.deletedAt as Date);
            r.lastChangeAt = last && last > deletedAt ? last : deletedAt;
            r.enforcedAt = null;
          }
          return [{ byAdmin: r.byAdmin, reason: r.reason, senderJids: r.senderJids, senderPhones: r.senderPhones, changes: r.changes, deletedAt: r.deletedAt, lastChangeAt: r.lastChangeAt }];
        },
        $transaction: async <R>(fn: (tx: unknown) => Promise<R>): Promise<R> => {
          const snapshot = Object.fromEntries(names.map((n) => [n, (T[n] ?? []).map((r) => ({ ...r }))]));
          try {
            return await fn(t);
          } catch (err) {
            for (const n of names) T[n].splice(0, T[n].length, ...snapshot[n]);
            throw err;
          }
        },
      };
    },
  };
}
