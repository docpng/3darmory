import { notFound } from './render.js';
import { randomHex } from './session.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const TYPES = {
  'image/jpeg': { ext: '.jpg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: '.png', matches: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/gif': { ext: '.gif', matches: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  'image/webp': {
    ext: '.webp',
    matches: (b) => String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP',
  },
};

/** Returns true when the form field holds an actual uploaded file (not an empty file input). */
export function hasUpload(file) {
  return typeof file === 'object' && file !== null && typeof file.arrayBuffer === 'function' && file.size > 0;
}

/**
 * Validates and stores an uploaded image in R2. Returns { path } on success or { error }.
 * The file's real bytes are checked, not just the browser-reported type.
 */
export async function saveImage(bucket, file) {
  const type = TYPES[file.type];
  if (!type) return { error: 'Images must be JPG, PNG, WebP or GIF.' };
  if (file.size > MAX_IMAGE_BYTES) return { error: 'Image is too large (max 8 MB).' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!type.matches(bytes)) return { error: 'That file does not look like a valid image.' };
  const key = randomHex(12) + type.ext;
  await bucket.put(key, bytes, { httpMetadata: { contentType: file.type } });
  return { path: `/uploads/${key}` };
}

/** Deletes a previously uploaded image (demo images in /img are left alone). */
export async function deleteImage(bucket, image) {
  if (image && image.startsWith('/uploads/')) await bucket.delete(image.slice('/uploads/'.length));
}

/** GET /uploads/:key — streams an uploaded image out of R2. */
export async function serveImage(c) {
  const key = c.req.param('key');
  if (!/^[a-f0-9]{24}\.(jpg|png|gif|webp)$/.test(key)) return notFound(c);
  const object = await c.env.IMAGES.get(key);
  if (!object) return notFound(c);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(object.body, { headers });
}
