import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { env, supabaseConfigured } from '../env.js';
import { supabase } from '../supabase.js';
import { badRequest } from './errors.js';

/** Checks the file's first bytes, so a renamed script or HTML file can't be uploaded as an "image". */
export function isImage(b: Buffer) {
  const hex = b.subarray(0, 12).toString('hex');
  return hex.startsWith('89504e47') // png
    || hex.startsWith('ffd8ff') // jpg
    || hex.startsWith('47494638') // gif
    || (hex.startsWith('52494646') && b.subarray(8, 12).toString() === 'WEBP');
}

/**
 * Saves one uploaded image (max 5 MB, checked to be a real image) and returns its public URL.
 * `folderFor` gets the form's other fields (sent before the file) and returns the storage folder.
 */
export async function saveImage(req: FastifyRequest, folderFor: (fields: Record<string, unknown>) => string) {
  if (!supabaseConfigured()) throw badRequest('Add your Supabase keys to upload images');
  const file = await req.file();
  if (!file) throw badRequest('No file');
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) throw badRequest('Upload a PNG, JPG or WebP image');
  const buf = await file.toBuffer();
  if (!isImage(buf)) throw badRequest('That file is not a real image');
  const ext = file.mimetype.split('/')[1].replace('jpeg', 'jpg');
  const path = `${folderFor(file.fields as Record<string, unknown>)}/${randomUUID()}.${ext}`;
  const { error } = await supabase().storage.from(env.bucket).upload(path, buf, { contentType: file.mimetype, upsert: false });
  if (error) throw badRequest(error.message);
  const { data } = supabase().storage.from(env.bucket).getPublicUrl(path);
  return { url: data.publicUrl, path };
}
