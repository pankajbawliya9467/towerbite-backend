import { q } from '../db.js';
import { getSetting, setSetting } from './settings.js';

/**
 * Global categories (one list for every cafe). While the switch is off, menus still use each cafe's own
 * categories; when it is on, menus are built from `catalog_categories` (Admin → Categories → switch).
 * The switch lives in app_settings (key `catalog_categories`); CATALOG_CATEGORIES=on in the env is the default.
 */
const KEY = 'catalog_categories';
let cached: { on: boolean; until: number } | null = null;

export async function catalogOn(): Promise<boolean> {
  if (cached && cached.until > Date.now()) return cached.on;
  const saved = await getSetting(KEY).catch(() => null);
  const on = saved ? saved === 'on' : process.env.CATALOG_CATEGORIES === 'on';
  cached = { on, until: Date.now() + 10_000 };
  return on;
}

export async function setCatalogOn(on: boolean, by: string) {
  await setSetting(KEY, on ? 'on' : 'off', by);
  cached = { on, until: Date.now() + 10_000 };
}

/**
 * Products with no global category yet are shown in this one (when the switch is on), so they never
 * disappear from a menu. Not a real row: the apps only see it as a category id.
 */
export const OTHER_CATEGORY = { id: '00000000-0000-4000-8000-00000000c0de', name: 'More', sort: 100000, parentId: null };

/** "  Thali &  Rice Bowl " → "thali & rice bowl" (how old category names are compared). */
export const norm = (s: string | null | undefined) => (s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Key of an old category name with its parent: "chinese › main course", or just "main course". */
export const groupKey = (name: string, parent: string | null | undefined) => (norm(parent) ? `${norm(parent)} › ${norm(name)}` : norm(name));

export function slugify(s: string) {
  return norm(s).replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'category';
}

export type CatalogRow = {
  id: string; parent_id: string | null; name: string; slug: string; aliases: string[]; keywords: string[]; is_active: boolean;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Keyword rules, longest keyword first (so "cold coffee" wins over "coffee"). Only leaf categories. */
export function keywordRules(rows: CatalogRow[]) {
  const parents = new Set(rows.filter((r) => r.parent_id && r.is_active).map((r) => r.parent_id));
  return rows
    .filter((r) => r.is_active && !parents.has(r.id))
    .flatMap((r) => r.keywords.map((k) => ({ id: r.id, kw: norm(k), re: new RegExp(`(^|[^a-z0-9])${escapeRe(norm(k))}($|[^a-z0-9])`) })))
    .filter((x) => x.kw)
    .sort((a, b) => b.kw.length - a.kw.length);
}

/**
 * Where one product of a mixed old category goes: its default target, unless its name matches a keyword of
 * another category (and none of the default target's own keywords).
 */
export function pickByKeywords(productName: string, defaultId: string | null, rules: ReturnType<typeof keywordRules>) {
  const name = norm(productName);
  const hits = rules.filter((r) => r.re.test(name));
  if (!hits.length) return defaultId;
  if (defaultId && hits.some((h) => h.id === defaultId)) return defaultId;
  return hits[0].id;
}

/** Leaf = a category a product may sit in: a sub-category, or a main category without active sub-categories. */
export async function isLeaf(id: string) {
  const [row] = await q<{ ok: boolean; active: boolean }>(
    `select not exists (select 1 from catalog_categories s where s.parent_id = k.id and s.is_active) as ok, k.is_active as active
     from catalog_categories k where k.id = $1`,
    [id],
  );
  return row ? row.ok && row.active : null;
}
