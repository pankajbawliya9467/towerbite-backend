/**
 * Creates a super admin (or resets the password of an existing admin with this email and makes them super).
 *   npm run make-admin -- you@company.com "StrongPassword123" "Your Name"
 * Works on any Postgres: the admin lives in our own `admins` table.
 */
import { randomUUID } from 'node:crypto';
import { pool } from '../src/db.js';
import { hashPassword } from '../src/lib/passwords.js';

const [rawEmail, password, name = 'Admin'] = process.argv.slice(2);
const email = rawEmail?.trim().toLowerCase();
if (!email || !password) {
  console.error('Usage: npm run make-admin -- <email> <password> [name]');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password: at least 8 characters');
  process.exit(1);
}

const cafe = await pool.query(`select 1 from staff where lower(email) = $1`, [email]);
if (cafe.rowCount) {
  console.error('This email is a cafe login. Use a different email for the admin.');
  process.exit(1);
}
const hash = await hashPassword(password);
const found = await pool.query<{ id: string }>(`select id from admins where lower(email) = $1`, [email]);
if (found.rows[0]) {
  await pool.query(
    `update admins set password_hash = $2, password_set_at = now(), is_super = true, permissions = '{}', is_active = true where id = $1`,
    [found.rows[0].id, hash],
  );
  await pool.query(`delete from sessions where user_id = $1`, [found.rows[0].id]);
} else {
  await pool.query(
    `insert into admins (id, name, email, password_hash, password_set_at, is_super) values ($1, $2, $3, $4, now(), true)`,
    [randomUUID(), name, email, hash],
  );
}
console.log(`✓ ${email} is now a super admin`);
await pool.end();
