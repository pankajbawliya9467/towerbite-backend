import { z } from 'zod';
import { badRequest } from './errors.js';

/** Paged lists: `?page=1&pageSize=25` (25, 50 or 100). Lists answer `{ rows, total, page, pageSize }`. */
export type Page<T> = { rows: T[]; total: number; page: number; pageSize: number };

export function paging(qs: { page?: unknown; pageSize?: unknown }) {
  const page = z.coerce.number().int().min(1).max(100_000).catch(1).parse(qs.page ?? 1);
  const size = Number(qs.pageSize);
  const pageSize = [25, 50, 100].includes(size) ? size : 25;
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

/** Builds a parameterised WHERE: `add('o.cafe_id = ?', id)` (the `?` becomes $n). */
export class Where {
  params: unknown[] = [];
  private parts: string[] = ['true'];
  constructor(params: unknown[] = []) {
    this.params = [...params];
  }
  add(sql: string, ...values: unknown[]) {
    let s = sql;
    for (const v of values) {
      this.params.push(v);
      s = s.replace('?', `$${this.params.length}`);
    }
    this.parts.push(s);
    return this;
  }
  /** Next placeholder for a value used outside the WHERE (limit, offset…). */
  p(v: unknown) {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  get sql() {
    return this.parts.join(' and ');
  }
}

/** A search term made safe for ILIKE (% and _ are matched literally). */
export const like = (s: string) => `%${s.trim().slice(0, 80).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const day = (v: unknown, name = 'date') => {
  if (v === undefined || v === '' || v === null) return null;
  if (typeof v !== 'string' || !DAY.test(v) || Number.isNaN(Date.parse(v))) throw badRequest(`Pick a valid ${name}`);
  return v;
};
export const uuidOrNull = (v: unknown) => (v ? z.string().uuid().parse(v) : null);
