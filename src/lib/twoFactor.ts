import { createHash, randomBytes } from 'node:crypto';
import { one, q, tx } from '../db.js';
import { tooMany, unauthorized } from './errors.js';
import {
  checkCode, decryptSecret, encryptSecret, hashBackupCode, looksLikeBackupCode, newBackupCode, newSecret, otpauthUrl,
} from './totp.js';

/**
 * Admin 2-step login. After the right password the API gives a short "challenge" (5 minutes, 5 tries) instead of
 * a session. The admin answers it with a code from their authenticator app (or a one-time backup code).
 * First login: the challenge carries a new secret to scan; the secret is saved only after a right code.
 */
const CHALLENGE_MINUTES = 5;
const CHALLENGE_TRIES = 5;
/** Wrong codes per admin in 15 minutes before the code step is locked (kept in the database). */
const FAILS_PER_ADMIN = 5;
const BACKUP_CODES = 8;

const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const failKey = (adminId: string) => `2fa:${adminId}`;

export type ChallengeAnswer =
  | { twoFactor: 'code'; challenge: string; expiresAt: string }
  | { twoFactor: 'setup'; challenge: string; expiresAt: string; secret: string; otpauthUrl: string; email: string };

/** Called after the right password: what the admin must do next. */
export async function startChallenge(admin: { id: string; email: string; enabled: boolean }, userAgent: string): Promise<ChallengeAnswer> {
  const token = `tbc_${randomBytes(32).toString('base64url')}`;
  const expires = new Date(Date.now() + CHALLENGE_MINUTES * 60_000);
  const secret = admin.enabled ? null : newSecret();
  // An admin has one open challenge at a time (a new password login replaces the old one).
  await tx(async (c) => {
    await c.query(`delete from login_challenges where admin_id = $1 or expires_at < now()`, [admin.id]);
    await c.query(
      `insert into login_challenges (token_hash, admin_id, purpose, pending_secret, user_agent, expires_at) values ($1, $2, $3, $4, $5, $6)`,
      [hash(token), admin.id, secret ? 'setup' : 'code', secret ? encryptSecret(secret) : null, userAgent.slice(0, 200), expires],
    );
  });
  if (!secret) return { twoFactor: 'code', challenge: token, expiresAt: expires.toISOString() };
  return { twoFactor: 'setup', challenge: token, expiresAt: expires.toISOString(), secret, otpauthUrl: otpauthUrl(admin.email, secret), email: admin.email };
}

async function assertNotLocked(adminId: string) {
  const row = await one<{ n: number }>(
    `select count(*)::int as n from auth_fails where key = $1 and created_at > now() - interval '15 minutes'`,
    [failKey(adminId)],
  );
  if ((row?.n ?? 0) >= FAILS_PER_ADMIN) throw tooMany('Too many wrong codes. Please wait 15 minutes.');
}

async function addFail(adminId: string) {
  await q(`insert into auth_fails (key) values ($1)`, [failKey(adminId)]);
  if (Math.random() < 0.05) void q(`delete from auth_fails where created_at < now() - interval '1 day'`).catch(() => undefined);
}

/** New backup codes for an admin (the old ones stop working). Returns them once, in plain text. */
async function replaceBackupCodes(c: { query: (s: string, p?: unknown[]) => Promise<unknown> }, adminId: string) {
  const codes = Array.from({ length: BACKUP_CODES }, newBackupCode);
  await c.query(`delete from admin_backup_codes where admin_id = $1`, [adminId]);
  await c.query(
    `insert into admin_backup_codes (admin_id, code_hash) select $1, unnest($2::text[])`,
    [adminId, codes.map((x) => hashBackupCode(adminId, x))],
  );
  return codes;
}

/**
 * Checks the code for a challenge. Right: the challenge is used up and the admin's id is returned (plus new
 * backup codes after a first-time setup). Wrong: counted on the challenge and on the admin.
 */
export async function answerChallenge(token: string, code: string): Promise<{ adminId: string; email: string; userAgent: string; backupCodes?: string[]; usedBackup?: boolean }> {
  // Count the try first, so parallel guesses can't get more than CHALLENGE_TRIES.
  const ch = await one<{ admin_id: string; purpose: 'code' | 'setup'; pending_secret: string | null; user_agent: string }>(
    `update login_challenges set attempts = attempts + 1
     where token_hash = $1 and expires_at > now() and attempts < ${CHALLENGE_TRIES}
     returning admin_id, purpose, pending_secret, user_agent`,
    [hash(token)],
  );
  if (!ch) throw unauthorized('This login step has expired. Please enter your password again.');
  await assertNotLocked(ch.admin_id);
  const admin = await one<{ email: string; totp_secret: string | null; totp_last_step: string; is_active: boolean }>(
    `select email, totp_secret, totp_last_step, is_active from admins where id = $1`,
    [ch.admin_id],
  );
  if (!admin?.is_active) throw unauthorized('This login is turned off');
  const typed = code.trim();

  if (ch.purpose === 'setup') {
    const secret = decryptSecret(ch.pending_secret ?? '');
    const step = checkCode(secret, typed.replace(/\s/g, ''));
    if (step === null) {
      await addFail(ch.admin_id);
      throw unauthorized('Wrong code. Check the time on your phone is automatic, then try the newest code.');
    }
    const backupCodes = await tx(async (c) => {
      // Only if 2-step was not switched on meanwhile (e.g. from another browser).
      const { rowCount } = await c.query(
        `update admins set totp_secret = $2, totp_enabled_at = now(), totp_last_step = $3 where id = $1 and totp_secret is null`,
        [ch.admin_id, ch.pending_secret, step],
      );
      if (!rowCount) throw unauthorized('2-step login was already set up. Please log in again.');
      await c.query(`delete from login_challenges where token_hash = $1`, [hash(token)]);
      await c.query(`delete from auth_fails where key = $1`, [failKey(ch.admin_id)]);
      return replaceBackupCodes(c, ch.admin_id);
    });
    return { adminId: ch.admin_id, email: admin.email, userAgent: ch.user_agent, backupCodes };
  }

  if (!admin.totp_secret) throw unauthorized('2-step login was reset. Please log in again.');
  const digits = typed.replace(/\s/g, '');
  let ok = false;
  let usedBackup = false;
  if (/^\d{6}$/.test(digits)) {
    const step = checkCode(decryptSecret(admin.totp_secret), digits, Number(admin.totp_last_step));
    // Saved only if no other login used this step meanwhile (the same code can't log in twice).
    if (step !== null) {
      ok = !!(await one(
        `update admins set totp_last_step = $2 where id = $1 and totp_last_step < $2 returning id`,
        [ch.admin_id, step],
      ));
    }
  } else if (looksLikeBackupCode(typed)) {
    ok = !!(await one(
      `update admin_backup_codes set used_at = now() where admin_id = $1 and code_hash = $2 and used_at is null returning admin_id`,
      [ch.admin_id, hashBackupCode(ch.admin_id, typed)],
    ));
    usedBackup = ok;
  }
  if (!ok) {
    await addFail(ch.admin_id);
    throw unauthorized('Wrong code. Try the newest code from your authenticator app.');
  }
  await q(`delete from login_challenges where token_hash = $1`, [hash(token)]);
  await q(`delete from auth_fails where key = $1`, [failKey(ch.admin_id)]);
  return { adminId: ch.admin_id, email: admin.email, userAgent: ch.user_agent, usedBackup };
}

/** For "Your account": is 2-step on, and how many backup codes are left. */
export async function twoFactorStatus(adminId: string) {
  const row = await one<{ enabled_at: Date | null; left: number }>(
    `select a.totp_enabled_at as enabled_at,
       (select count(*)::int from admin_backup_codes b where b.admin_id = a.id and b.used_at is null) as left
     from admins a where a.id = $1`,
    [adminId],
  );
  return { enabled: !!row?.enabled_at, enabledAt: row?.enabled_at ?? null, backupCodesLeft: row?.left ?? 0 };
}

/** New backup codes, after the admin proves it is them with a current authenticator code. */
export async function regenerateBackupCodes(adminId: string, code: string) {
  await assertNotLocked(adminId);
  const admin = await one<{ totp_secret: string | null; totp_last_step: string }>(
    `select totp_secret, totp_last_step from admins where id = $1`,
    [adminId],
  );
  if (!admin?.totp_secret) throw unauthorized('2-step login is not set up for this login');
  const step = checkCode(decryptSecret(admin.totp_secret), code.replace(/\s/g, ''), Number(admin.totp_last_step));
  const ok = step !== null && !!(await one(
    `update admins set totp_last_step = $2 where id = $1 and totp_last_step < $2 returning id`,
    [adminId, step],
  ));
  if (!ok) {
    await addFail(adminId);
    throw unauthorized('Wrong code. Try the newest code from your authenticator app.');
  }
  return tx((c) => replaceBackupCodes(c, adminId));
}

/** Super admin reset (lost phone): the admin sets up a new authenticator at their next login. */
export async function resetTwoFactor(adminId: string) {
  await tx(async (c) => {
    await c.query(`update admins set totp_secret = null, totp_enabled_at = null, totp_last_step = 0 where id = $1`, [adminId]);
    await c.query(`delete from admin_backup_codes where admin_id = $1`, [adminId]);
    await c.query(`delete from login_challenges where admin_id = $1`, [adminId]);
    await c.query(`delete from auth_fails where key = $1`, [failKey(adminId)]);
  });
}
