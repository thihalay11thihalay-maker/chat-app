import { PostSound, toPostSoundValue } from '@/lib/music';

export type MediaType = 'image' | 'video';

/**
 * A route param comes back as a string, or as an array when the same key appears more than once.
 * Testing for `typeof value === 'string'` alone throws the array case away, which is what leaves a
 * media preview empty: the uri is right, it just never reaches the image. Both shapes are reduced
 * to the first usable entry here instead, and a value that is still percent encoded is decoded,
 * because an escaped path is not something the file system or an image loader can open.
 */
export function toParam(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;

  if (typeof raw !== 'string') {
    return '';
  }

  const trimmed = raw.trim();

  if (!trimmed) {
    return '';
  }

  if (trimmed.includes('%2F') || trimmed.includes('%3A') || trimmed.includes('%3a')) {
    try {
      return decodeURIComponent(trimmed);
    } catch {
      // Malformed escapes are left as they came in; the caller decides whether that is usable.
      return trimmed;
    }
  }

  return trimmed;
}

/**
 * The media type of an incoming shot. The param is optional because a camera uri carries its own
 * extension; anything unrecognised is treated as an image, which is what the picker returns.
 */
export function toMediaType(value: unknown, uri: string): MediaType {
  if (value === 'video' || value === 'image') {
    return value;
  }

  const path = uri.split('?')[0].toLowerCase();
  return /\.(mp4|mov|m4v|3gp|webm|avi)$/.test(path) ? 'video' : 'image';
}

/**
 * A flat background colour for a text post. Only a plain hex colour is accepted, because the
 * string goes straight onto a view's background and a hand-edited param must not be able to put
 * anything else there.
 */
export function toBackgroundColor(value: unknown): string | null {
  const color = toParam(value);
  return /^#[0-9A-Fa-f]{6}$/.test(color) ? color : null;
}

/**
 * A list of strings passed as one route param, which arrives as a JSON string because a param can
 * only be a string. Anything that is not an array of non-empty strings reads as no list rather
 * than throwing, so a hand-edited or truncated param cannot put a broken value on screen.
 */
export function toStringArrayParam(value: unknown): string[] {
  const raw = toParam(value);

  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  } catch {
    return [];
  }
}

/**
 * The sound picked on the camera screen, which arrives as a JSON string because a route param can
 * only be a string. A malformed or hand-edited param reads as no sound rather than throwing while
 * the screen is mounting.
 */
export function toSoundParam(value: unknown): PostSound | null {
  const raw = toParam(value);

  if (!raw) {
    return null;
  }

  try {
    return toPostSoundValue(JSON.parse(raw));
  } catch {
    return null;
  }
}