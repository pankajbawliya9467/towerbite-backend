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

/** Metres between two points (haversine). */
export function distanceM(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const far = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

/**
 * Orders only from inside the cafe's building, when the admin turned the check on for that cafe and set
 * its pin. GPS inside buildings is rough, so up to 100 m of the phone's reported accuracy is allowed on top
 * of the radius (no more, so a "very inaccurate" reading can't be used to get past it).
 */
export function checkGeo(
  cafe: { name: string; lat: number | null; lng: number | null; geo_check: boolean; geo_radius_m: number },
  geo: Geo,
) {
  if (!cafe.geo_check || cafe.lat == null || cafe.lng == null) return;
  if (!geo) throw conflict(`To order from ${cafe.name}, update the TowerBites app and allow location. Orders are taken only from inside the building.`);
  if (geo.mocked) throw conflict('A fake-location app is on. Turn it off to order.');
  const d = distanceM(geo.lat, geo.lng, cafe.lat, cafe.lng);
  if (d > cafe.geo_radius_m + Math.min(geo.accuracy ?? 0, 100)) {
    throw conflict(`You're about ${far(d)} from ${cafe.name}. Orders can be placed only from inside the building.`);
  }
}
