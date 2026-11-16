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

export function makeTable(rows: Row[]) {
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
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = rows.find((x) => x.id === args.where.id);
      if (!r) throw new Error(`no row ${args.where.id}`);
      for (const [k, v] of Object.entries(args.data)) r[k] = stored(v);
      return { ...r };
    },
    updateMany: async (args: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const r of rows) {
        if (!matches(r, args.where)) continue;
        for (const [k, v] of Object.entries(args.data)) r[k] = stored(v);
        count++;
      }
      return { count };
    },
    deleteMany: async (args: { where?: Record<string, unknown> } = {}) => {
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
