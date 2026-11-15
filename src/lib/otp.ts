import { supabase, supabaseAuthCheck } from '../supabase.js';

/**
 * Who sends and checks the SMS code. The app only ever talks to our API; this is the one place to change
 * when moving off Supabase (e.g. MSG91 / Twilio + our own code table).
 */
export interface OtpProvider {
  send(phone: string): Promise<void>;
  /** Throws when the code is wrong. May return the provider's user id (kept for existing accounts). */
  verify(phone: string, code: string): Promise<{ providerUserId?: string }>;
}

export const supabaseOtp: OtpProvider = {
  async send(phone) {
    const { error } = await supabase().auth.signInWithOtp({ phone });
    if (error) throw new Error(error.message);
  },
  async verify(phone, code) {
    const { data, error } = await supabaseAuthCheck().auth.verifyOtp({ phone, token: code, type: 'sms' });
    if (error || !data.user) throw new Error('Wrong or expired code');
    return { providerUserId: data.user.id };
  },
};

/** Swappable in tests. */
export let otpProvider: OtpProvider = supabaseOtp;
export const setOtpProvider = (p: OtpProvider) => {
  otpProvider = p;
};

/**
 * Checks a staff password with the old login system, once per person: used only until their password is
 * stored in our own database (staff.password_hash). Returns the user id, or null when it is wrong.
 */
export interface PasswordProvider {
  verify(email: string, password: string): Promise<string | null>;
}
export const supabasePassword: PasswordProvider = {
  async verify(email, password) {
    const { data, error } = await supabaseAuthCheck().auth.signInWithPassword({ email, password });
    return error || !data.user ? null : data.user.id;
  },
};
export let passwordProvider: PasswordProvider = supabasePassword;
export const setPasswordProvider = (p: PasswordProvider) => {
  passwordProvider = p;
};
