import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { one, q, tx } from '../db.js';
import { can, requireAdmin, type Permission, type Staff } from '../auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { catalogOn, norm, type CatalogRow } from '../lib/catalog.js';
import { cafesChanged } from '../realtime.js';

/**
 * A cafe's products from an Excel file (Admin → Cafes → View details → Products → Import Excel).
 * One file = one cafe. A product is matched by its name inside the cafe: a known name is updated, a new
 * name is added; nothing is ever deleted. The upload first answers a preview (commit=0); the same file
 * sent with commit=1 saves every row without errors in one transaction.
 *
 * Columns (by header, any order, case doesn't matter): Product name*, Price*, Category*, Sub-category, Veg,
 * Description, In stock, Popular (an optional Emoji column is read too). Category / Sub-category are the names from Admin → Categories.
 */

const MAX_ROWS = 2000;
const HEADERS: Record<string, Field> = {
  'product name': 'name', product: 'name', name: 'name', 'item name': 'name',
  price: 'price', 'price (₹)': 'price', 'price (rs)': 'price',
  category: 'category', 'main category': 'category',
  'sub-category': 'sub', 'sub category': 'sub', subcategory: 'sub',
  veg: 'veg', 'veg / non-veg': 'veg', 'veg/non-veg': 'veg',
  description: 'description',
  'in stock': 'inStock', stock: 'inStock', available: 'inStock',
  popular: 'popular', bestseller: 'popular',
  emoji: 'emoji',
};
type Field = 'name' | 'price' | 'category' | 'sub' | 'veg' | 'description' | 'inStock' | 'popular' | 'emoji';
type Raw = Partial<Record<Field, string>> & { row: number };

type Existing = {
  id: string; name: string; price: number; is_veg: boolean; description: string; emoji: string;
  is_available: boolean; is_popular: boolean; catalog_category_id: string | null;
};
type Change = { field: string; from: string; to: string };
type Result = {
  row: number; name: string; status: 'new' | 'update' | 'same' | 'error'; errors: string[]; changes: Change[];
  categoryPath: string;
};
type Planned = Result & { id?: string; data?: Omit<Existing, 'id' | 'name'> & { name: string } };

/** Any Excel cell value as plain text (numbers, rich text, formulas, links). */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('').trim();
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('text' in v) return String(v.text).trim();
    if ('error' in v) return '';
  }
  return String(v).trim();
}

const yes = new Set(['yes', 'y', 'true', '1', 'veg', 'v', 'haan', 'ha']);
const no = new Set(['no', 'n', 'false', '0', 'non-veg', 'non veg', 'nonveg', 'nv', 'nahi']);
/** Yes/No cell: true, false, null when blank, undefined when it can't be read. */
function yesNo(s: string | undefined): boolean | null | undefined {
  const t = norm(s);
  if (!t) return null;
  if (yes.has(t)) return true;
  if (no.has(t)) return false;
  return undefined;
}

/** Reads the first sheet named "Products" (or the first sheet) into rows keyed by column. */
async function readFile(buf: Buffer): Promise<Raw[]> {
  if (buf.subarray(0, 2).toString() !== 'PK') throw badRequest('Upload an Excel file (.xlsx). Old .xls files: open in Excel and "Save as" .xlsx.');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  } catch {
    throw badRequest('This Excel file could not be read. Save it again as .xlsx and try again.');
  }
  const ws = wb.worksheets.find((w) => norm(w.name) === 'products') ?? wb.worksheets[0];
  if (!ws) throw badRequest('The file has no sheet');
  const cols = new Map<number, Field>();
  ws.getRow(1).eachCell((cell, col) => {
    const f = HEADERS[norm(cellText(cell.value)).replace(/\*$/, '').trim()];
    if (f && ![...cols.values()].includes(f)) cols.set(col, f);
  });
  const missing = (['name', 'price', 'category'] as Field[]).filter((f) => ![...cols.values()].includes(f));
  if (missing.length) {
    throw badRequest(`Row 1 needs the column titles: Product name, Price, Category (missing: ${missing.join(', ')}). Download the template to see the format.`);
  }
  const rows: Raw[] = [];
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n === 1) return;
    const raw: Raw = { row: n };
    for (const [col, f] of cols) raw[f] = cellText(r.getCell(col).value);
    if (Object.entries(raw).some(([k, v]) => k !== 'row' && v)) rows.push(raw);
  });
  if (!rows.length) throw badRequest('No products found under the column titles');
  if (rows.length > MAX_ROWS) throw badRequest(`Up to ${MAX_ROWS} products per file`);
  return rows;
}

/** Checks every row against the cafe's products and the global categories, and works out what changes. */
async function plan(me: Staff, cafeId: string, rows: Raw[]) {
  const [cats, existing] = await Promise.all([
    q<CatalogRow & { sort: number }>(`select id, parent_id, name, slug, aliases, keywords, is_active, sort from catalog_categories where is_active`),
    q<Existing>(
      `select id, name, price, is_veg, description, emoji, is_available, is_popular, catalog_category_id from menu_items where cafe_id = $1`,
      [cafeId],
    ),
  ]);
  const mains = cats.filter((c) => !c.parent_id);
  const subsOf = (id: string) => cats.filter((c) => c.parent_id === id);
  const names = (c: CatalogRow) => [norm(c.name), ...c.aliases.map(norm)];
  const pathOf = new Map(cats.map((c) => [c.id, c.parent_id ? `${cats.find((m) => m.id === c.parent_id)?.name} › ${c.name}` : c.name]));
  const byName = new Map(existing.map((e) => [norm(e.name), e]));
  const seen = new Map<string, number>();
  const need = (p: Permission, errors: string[]) => {
    if (!can(me, p)) errors.push(`You don't have the ${p} tick`);
  };

  return rows.map((r): Planned => {
    const errors: string[] = [];
    const name = (r.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) errors.push('Product name is empty');
    else if (name.length > 80) errors.push('Product name: up to 80 letters');
    const key = norm(name);
    if (key && seen.has(key)) errors.push(`Same product as row ${seen.get(key)}`);
    else if (key) seen.set(key, r.row);

    const priceText = (r.price ?? '').replace(/[₹,\s]|rs\.?/gi, '');
    const price = Number(priceText);
    if (!priceText) errors.push('Price is empty');
    else if (!Number.isInteger(price) || price < 0 || price > 100000) errors.push(`Price "${r.price}" must be whole rupees (e.g. 120)`);

    // Category: a main category by name (or its old names); then its sub-category, needed when it has any.
    let catalogId: string | null = null;
    const main = mains.find((m) => names(m).includes(norm(r.category)));
    if (!norm(r.category)) errors.push('Category is empty');
    else if (!main) errors.push(`Category "${r.category}" is not in Admin → Categories`);
    else {
      const subs = subsOf(main.id);
      if (!subs.length) {
        if (norm(r.sub)) errors.push(`${main.name} has no sub-categories: leave Sub-category empty`);
        else catalogId = main.id;
      } else if (!norm(r.sub)) {
        errors.push(`Pick a sub-category of ${main.name} (${subs.map((s) => s.name).slice(0, 4).join(', ')}${subs.length > 4 ? '…' : ''})`);
      } else {
        const sub = subs.find((s) => names(s).includes(norm(r.sub)));
        if (sub) catalogId = sub.id;
        else errors.push(`Sub-category "${r.sub}" is not in ${main.name}`);
      }
    }

    const veg = yesNo(r.veg);
    const inStock = yesNo(r.inStock);
    const popular = yesNo(r.popular);
    if (veg === undefined) errors.push(`Veg "${r.veg}": write Yes or No`);
    if (inStock === undefined) errors.push(`In stock "${r.inStock}": write Yes or No`);
    if (popular === undefined) errors.push(`Popular "${r.popular}": write Yes or No`);
    const description = (r.description ?? '').trim();
    if (description.length > 160) errors.push('Description: up to 160 letters');
    const emoji = (r.emoji ?? '').trim();
    if (emoji.length > 8) errors.push('Emoji: one emoji only');

    const old = key ? byName.get(key) : undefined;
    const categoryPath = catalogId ? pathOf.get(catalogId) ?? '' : '';
    const base = { row: r.row, name, errors, categoryPath, changes: [] as Change[] };
    if (errors.length) return { ...base, status: 'error' };

    if (!old) {
      need('menu.add', errors);
      const data = {
        // No emoji unless the file gives one: the cafe adds photos later.
        name, price, is_veg: veg ?? true, description, emoji,
        is_available: inStock ?? true, is_popular: popular ?? false, catalog_category_id: catalogId,
      };
      return { ...base, status: errors.length ? 'error' : 'new', data };
    }

    // A known product: blank optional cells keep what it has.
    const data = {
      name: old.name, price, is_veg: veg ?? old.is_veg, description: description || old.description, emoji: emoji || old.emoji,
      is_available: inStock ?? old.is_available, is_popular: popular ?? old.is_popular, catalog_category_id: catalogId,
    };
    const changes: Change[] = [];
    const yn = (b: boolean) => (b ? 'Yes' : 'No');
    if (data.price !== old.price) {
      changes.push({ field: 'Price', from: `₹${old.price}`, to: `₹${data.price}` });
      need('menu.price', errors);
    }
    if (data.catalog_category_id !== old.catalog_category_id) {
      changes.push({ field: 'Category', from: (old.catalog_category_id && pathOf.get(old.catalog_category_id)) || 'none', to: categoryPath });
    }
    if (data.is_veg !== old.is_veg) changes.push({ field: 'Veg', from: yn(old.is_veg), to: yn(data.is_veg) });
    if (data.description !== old.description) changes.push({ field: 'Description', from: old.description || '—', to: data.description });
    if (data.emoji !== old.emoji) changes.push({ field: 'Emoji', from: old.emoji, to: data.emoji });
    if (data.is_popular !== old.is_popular) changes.push({ field: 'Popular', from: yn(old.is_popular), to: yn(data.is_popular) });
    if (changes.some((c) => c.field !== 'Price')) need('menu.edit', errors);
    if (data.is_available !== old.is_available) {
      changes.push({ field: 'In stock', from: yn(old.is_available), to: yn(data.is_available) });
      need('menu.soldout', errors);
    }
    const status = errors.length ? 'error' : changes.length ? 'update' : 'same';
    return { ...base, errors, changes, status, id: old.id, data };
  });
}

export async function menuImportRoutes(app: FastifyInstance) {
  /** The Excel template: this cafe's products filled in, the category list, and a short how-to. */
  app.get<{ Querystring: { cafeId?: string } }>('/v1/admin/menu-items/template.xlsx', async (req, reply) => {
    await requireAdmin(req, 'menu.view');
    const cafeId = z.string().uuid().parse(req.query.cafeId);
    const cafe = await one<{ name: string; slug: string }>(`select name, slug from cafes where id = $1`, [cafeId]);
    if (!cafe) throw notFound('Cafe not found');
    const [cats, items] = await Promise.all([
      q<{ id: string; parent_id: string | null; name: string; sort: number }>(
        `select id, parent_id, name, sort from catalog_categories where is_active order by sort, name`,
      ),
      q<Existing & { sort: number }>(
        `select id, name, price, is_veg, description, emoji, is_available, is_popular, catalog_category_id, sort
         from menu_items where cafe_id = $1 order by sort, name`,
        [cafeId],
      ),
    ]);
    const mains = cats.filter((c) => !c.parent_id);
    const pairs = mains.flatMap((m) => {
      const subs = cats.filter((c) => c.parent_id === m.id);
      return subs.length ? subs.map((s) => [m.name, s.name]) : [[m.name, '']];
    });
    const place = (id: string | null) => {
      const c = cats.find((x) => x.id === id);
      if (!c) return ['', ''];
      const p = c.parent_id ? cats.find((x) => x.id === c.parent_id) : null;
      return p ? [p.name, c.name] : [c.name, ''];
    };

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TowerBites';
    const ws = wb.addWorksheet('Products', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Product name', key: 'name', width: 34 },
      { header: 'Price', key: 'price', width: 10 },
      { header: 'Category', key: 'category', width: 24 },
      { header: 'Sub-category', key: 'sub', width: 26 },
      { header: 'Veg', key: 'veg', width: 8 },
      { header: 'Description', key: 'description', width: 40 },
      { header: 'In stock', key: 'stock', width: 10 },
      { header: 'Popular', key: 'popular', width: 10 },
    ];
    for (const i of items) {
      const [c, s] = place(i.catalog_category_id);
      ws.addRow({
        name: i.name, price: i.price, category: c, sub: s, veg: i.is_veg ? 'Yes' : 'No', description: i.description,
        stock: i.is_available ? 'Yes' : 'No', popular: i.is_popular ? 'Yes' : 'No',
      });
    }
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8590C' } };
    head.height = 22;

    const list = wb.addWorksheet('Categories', { views: [{ state: 'frozen', ySplit: 1 }] });
    list.columns = [{ header: 'Category', key: 'c', width: 26 }, { header: 'Sub-category', key: 's', width: 30 }, { header: '', key: 'm', width: 4 }, { header: 'Main categories', key: 'main', width: 26 }];
    pairs.forEach(([c, s], i) => {
      list.getCell(i + 2, 1).value = c;
      list.getCell(i + 2, 2).value = s || '(leave empty)';
    });
    mains.forEach((m, i) => {
      list.getCell(i + 2, 4).value = m.name;
    });
    list.getRow(1).font = { bold: true };

    // Dropdowns: Category from the main list, Yes/No columns. Typing is still allowed.
    const last = Math.max(items.length + 200, 500);
    const mainRange = `Categories!$D$2:$D$${Math.max(mains.length + 1, 2)}`;
    for (let r = 2; r <= last; r++) {
      ws.getCell(`C${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [mainRange], showErrorMessage: false };
      for (const col of ['E', 'G', 'H']) {
        ws.getCell(`${col}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Yes,No"'], showErrorMessage: false };
      }
    }

    const help = wb.addWorksheet('How to');
    help.getColumn(1).width = 110;
    [
      `Products of ${cafe.name}. One file = one cafe.`,
      'Product name, Price and Category are needed. Price is whole rupees, numbers only (120, not ₹120).',
      'Category and Sub-category: names from the "Categories" sheet. A category without sub-categories: leave Sub-category empty.',
      'Veg, In stock, Popular: Yes or No. Empty = Veg Yes, In stock Yes, Popular No for a new product, and "no change" for one that exists.',
      'A product with the same name as one on the menu is updated (price, category…); a new name is added. Nothing is deleted.',
      'Photos are not part of the file: add them on the product page.',
      'Upload: Admin → Cafes → View details → Products → Import Excel. You see a preview first; nothing is saved until you press Import.',
    ].forEach((t, i) => {
      help.getCell(i + 1, 1).value = t;
    });
    help.getRow(1).font = { bold: true };

    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${cafe.slug}-products.xlsx"`);
    return reply.send(buf);
  });

  /**
   * Upload (multipart `file`). `commit=0` (default): only the preview. `commit=1`: saves every row without
   * errors (rows with errors are skipped) in one transaction and tells open menus to reload.
   */
  app.post<{ Querystring: { cafeId?: string; commit?: string } }>('/v1/admin/menu-items/import', async (req) => {
    const me = await requireAdmin(req, 'menu.add', 'menu.edit', 'menu.price');
    const cafeId = z.string().uuid().parse(req.query.cafeId);
    const cafe = await one<{ location_id: string }>(`select location_id from cafes where id = $1`, [cafeId]);
    if (!cafe) throw notFound('Cafe not found');
    const file = await req.file();
    if (!file) throw badRequest('No file');
    const rows = await readFile(await file.toBuffer());
    const planned = await plan(me, cafeId, rows);
    const count = (s: Result['status']) => planned.filter((p) => p.status === s).length;
    const summary = { new: count('new'), update: count('update'), same: count('same'), error: count('error') };
    const switchOff = !(await catalogOn());
    const results: Result[] = planned.map(({ id: _id, data: _data, ...r }) => r);

    if (req.query.commit !== '1') return { saved: false, summary, rows: results, switchOff };

    if (!summary.new && !summary.update) return { saved: true, summary, rows: results, switchOff };
    await tx(async (c) => {
      const { rows: [max] } = await c.query(`select coalesce(max(sort), 0)::int as n from menu_items where cafe_id = $1`, [cafeId]);
      let sort = max.n;
      for (const p of planned) {
        if (!p.data) continue;
        const d = p.data;
        if (p.status === 'new') {
          sort += 1;
          await c.query(
            `insert into menu_items (cafe_id, name, price, is_veg, description, emoji, is_available, is_popular, catalog_category_id, sort)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [cafeId, d.name, d.price, d.is_veg, d.description, d.emoji, d.is_available, d.is_popular, d.catalog_category_id, sort],
          );
        } else if (p.status === 'update' && p.id) {
          await c.query(
            `update menu_items set price = $3, is_veg = $4, description = $5, emoji = $6, is_available = $7, is_popular = $8,
               catalog_category_id = $9 where id = $1 and cafe_id = $2`,
            [p.id, cafeId, d.price, d.is_veg, d.description, d.emoji, d.is_available, d.is_popular, d.catalog_category_id],
          );
        }
      }
    });
    await cafesChanged([cafe.location_id]);
    return { saved: true, summary, rows: results, switchOff };
  });
}
