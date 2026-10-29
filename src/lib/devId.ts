import { createHash } from 'node:crypto';

/** Stable UUID for a dev login identifier (phone or email). Used only when DEV_AUTH=true. */
export function devUserId(identifier: string): string {
  const h = createHash('sha256').update(`towerbites-dev:${identifier.trim().toLowerCase()}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
