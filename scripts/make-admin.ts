/**
 * Creates (or promotes) a super admin login.
 *   npm run make-admin -- you@company.com "StrongPassword123" "Your Name"
 */
import { pool } from '../src/db.js';
import { supabaseConfigured } from '../src/env.js';
import { supabase } from '../src/supabase.js';

const [email, password, name = 'Admin'] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: npm run make-admin -- <email> <password> [name]');
  process.exit(1);
}
if (!supabaseConfigured()) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first');
  process.exit(1);
}

let userId: string | undefined;
const created = await supabase().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
if (created.data.user) userId = created.data.user.id;
else {
  // Already exists → find it and reset the password
  const { data } = await supabase().auth.admin.listUsers({ perPage: 1000 });
  const found = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!found) throw new Error(created.error?.message ?? 'Could not create user');
  await supabase().auth.admin.updateUserById(found.id, { password });
  userId = found.id;
}

await pool.query(
  `insert into staff (user_id, role, cafe_id, name, email) values ($1, 'super_admin', null, $2, $3)
   on conflict (user_id) do update set role = 'super_admin', cafe_id = null, name = excluded.name`,
  [userId, name, email.toLowerCase()],
);
console.log(`✓ ${email} is now a super admin`);
await pool.end();
