import { one } from '../db.js';
import { badRequest } from './errors.js';

/** A CRM email belongs to one login only (a cafe login or an admin). `exceptId` = the login being edited. */
export async function assertEmailFree(email: string, exceptId: string | null = null) {
  const taken = await one(
    `select 1 from staff where lower(email) = lower($1) and ($2::uuid is null or user_id <> $2)
     union all
     select 1 from admins where lower(email) = lower($1) and ($2::uuid is null or id <> $2)
     limit 1`,
    [email, exceptId],
  );
  if (taken) throw badRequest('This email is already used by another login');
}
