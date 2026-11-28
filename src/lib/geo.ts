import { z } from 'zod';
import { conflict } from './errors.js';

/** The customer's position, sent by the app / website with an order (never stored). */
export const GeoInput = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().min(0).max(100_000).optional(),
    /** Android reports fake-GPS apps */
    mocked: z.boolean().optional(),
  })
  .nullable()
  .optional();
export type Geo = z.infer<typeof GeoInput>;

/** A location's area: its corners as [lat, lng], in drawing order (3 to 200 corners). */
export const AreaInput = z
  .array(z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]))
  .min(3, 'Draw at least 3 corners')
  .max(200, 'Use at most 200 corners');
export type Area = [number, number][];

/** Metres between two points (haversine). */
export function distanceM(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Metres from a point to an area: 0 inside it, else the distance to its nearest edge. Works on a flat
 * map around the point, which is exact enough for areas a few km wide.
 */
export function distanceToAreaM(lat: number, lng: number, area: Area) {
  if (area.length < 3) return Infinity;
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos((lat * Math.PI) / 180);
  const pts = area.map(([a, b]) => [(b - lng) * mPerLng, (a - lat) * mPerLat] as const);
  // Inside? (ray casting from the point, which is at 0,0)
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > 0 !== yj > 0 && 0 < ((xj - xi) * (0 - yi)) / (yj - yi) + xi) inside = !inside;
  }
  if (inside) return 0;
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j];
    const [bx, by] = pts[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** The middle of an area (average of its corners): where the app centres its map. */
export function areaCenter(area: Area) {
  const lat = area.reduce((s, p) => s + p[0], 0) / area.length;
  const lng = area.reduce((s, p) => s + p[1], 0) / area.length;
  return { lat, lng };
}

/**
 * GPS inside big buildings drifts, so a customer up to this far outside the drawn line still counts as
 * inside, plus some of the phone's own reported accuracy (capped, so a "very inaccurate" reading can't
 * be used to get past the check).
 */
export const AREA_SLACK_M = 40;
export const MAX_ACCURACY_SLACK_M = 60;
export const insideArea = (d: number, accuracy?: number) => d <= AREA_SLACK_M + Math.min(accuracy ?? 0, MAX_ACCURACY_SLACK_M);

export const far = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`);

/**
 * Orders only from inside the cafe's location (its drawn area), unless that location allows outside orders.
 * A location without an area takes no orders (it can't be made live without one either).
 */
export function checkLocationGeo(
  loc: { name: string; area_geo: Area | null; outside_allowed: boolean },
  geo: Geo,
) {
  if (loc.outside_allowed) return;
  if (!loc.area_geo || loc.area_geo.length < 3) throw conflict(`${loc.name} isn't set up for orders yet. Please try again later.`);
  if (!geo) throw conflict(`Allow location to order. Orders are taken only from inside ${loc.name}. If you don't see the prompt, update the TowerBites app.`);
  if (geo.mocked) throw conflict('A fake-location app is on. Turn it off to order.');
  const d = distanceToAreaM(geo.lat, geo.lng, loc.area_geo);
  if (!insideArea(d, geo.accuracy)) {
    throw conflict(`You're about ${far(d)} outside ${loc.name}. Orders can be placed only from inside it.`);
  }
}
