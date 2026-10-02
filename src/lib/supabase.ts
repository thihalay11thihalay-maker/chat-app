import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
const supabaseAccessToken = process.env.EXPO_PUBLIC_SUPABASE_ACCESS_TOKEN ?? '';

export const supabaseBucket = process.env.EXPO_PUBLIC_SUPABASE_BUCKET ?? 'media';

let client: SupabaseClient | null = null;

export function isSupabaseStorageConfigured() {
  return Boolean(supabaseUrl && supabaseAnonKey);
}

function supabaseHost() {
  const match = /^https?:\/\/([^/]+)/i.exec(supabaseUrl);
  return match ? match[1] : supabaseUrl;
}

export function getSupabaseClient() {
  if (!isSupabaseStorageConfigured()) {
    throw new Error(
      'Supabase is not configured. Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to .env and restart the dev server.',
    );
  }

  client ??= createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: supabaseAccessToken
      ? { headers: { Authorization: `Bearer ${supabaseAccessToken}` } }
      : undefined,
  });

  return client;
}

export type UploadableFile = {
  contentType: string;
  fileName: string;
  uri: string;
};

export type UploadedMedia = {
  mediaPath: string;
  mediaUrl: string;
  storageBucket: string;
};

async function buildStorageUploadBody(file: UploadableFile): Promise<Blob | FormData> {
  if (Platform.OS === 'web') {
    const response = await fetch(file.uri);
    if (!response.ok) {
      throw new Error('Could not read the selected file.');
    }
    return await response.blob();
  }

  const formData = new FormData();
  formData.append('file', {
    name: file.fileName,
    type: file.contentType,
    uri: file.uri,
  } as unknown as Blob);
  return formData;
}

export async function uploadPostMedia(uid: string, file: UploadableFile): Promise<UploadedMedia> {
  const storage = getSupabaseClient().storage.from(supabaseBucket);
  const safeName = file.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const mediaPath = `posts/${uid}/${Date.now()}_${safeName}`;

  const body = await buildStorageUploadBody(file);
  const { error } = await storage.upload(mediaPath, body, { cacheControl: '3600', upsert: false });
  if (error) {
    throw error;
  }

  const { data } = storage.getPublicUrl(mediaPath);
  if (!data.publicUrl) {
    throw new Error('Supabase did not return a public URL for the uploaded file.');
  }

  return { mediaPath, mediaUrl: data.publicUrl, storageBucket: supabaseBucket };
}

export async function removePostMedia(mediaPath: string) {
  try {
    await getSupabaseClient().storage.from(supabaseBucket).remove([mediaPath]);
  } catch (error) {
    console.error('Could not remove the orphaned upload:', error);
  }
}

/**
 * The object path inside the storage bucket for a stored media url.
 *
 * A public url looks like `<project>/storage/v1/object/public/<bucket>/<path>`, but the path is
 * written two ways in this app: flat at the bucket root by the upload flow, and under
 * `posts/<uid>/` by the media helper above. Everything from the bucket segment onwards is the path
 * Supabase's remove() expects, whichever prefix produced it. An unrecognised url returns an empty
 * string, so nothing is ever asked to remove a path guessed out of thin air.
 *
 * Lives here rather than on the feed because two screens delete media now, and two copies of a
 * parser that decides which object to destroy is exactly the kind of thing that drifts.
 */
export function storagePathFromUrl(url?: string): string {
  const trimmed = url?.trim();

  if (!trimmed) {
    return '';
  }

  const segments = trimmed.split('?')[0].split('/').filter(Boolean);
  // The bucket segment is looked for after `public`, so a folder that happens to share the
  // bucket's name earlier in the path cannot be mistaken for it.
  const publicIndex = segments.indexOf('public');
  const searchFrom = publicIndex === -1 ? 0 : publicIndex;
  const bucketIndex = segments.indexOf(supabaseBucket, searchFrom);

  if (bucketIndex === -1) {
    return '';
  }

  return segments
    .slice(bucketIndex + 1)
    .map((segment) => decodeURIComponent(segment))
    .join('/');
}

export function getSupabaseUploadErrorMessage(error: unknown) {
  const details = typeof error === 'object' && error !== null
    ? error as { code?: unknown; message?: unknown; status?: unknown; statusCode?: unknown }
    : {};
  const code = typeof details.code === 'string' ? details.code : '';
  const message = typeof details.message === 'string' ? details.message : '';
  const statusCode = typeof details.statusCode === 'number'
    ? details.statusCode
    : typeof details.status === 'number'
      ? details.status
      : 0;
  const combined = `${code} ${message}`.toLowerCase();

  if (statusCode === 401 || statusCode === 403) {
    return 'Supabase rejected the upload token. Add a valid EXPO_PUBLIC_SUPABASE_ACCESS_TOKEN.';
  }
  if (statusCode === 404 || combined.includes('bucket')) {
    return `Supabase bucket "${supabaseBucket}" was not found. Create it or set EXPO_PUBLIC_SUPABASE_BUCKET.`;
  }
  if (combined.includes('exceeds') || combined.includes('too large')) {
    return 'That file is larger than the storage bucket allows.';
  }
  if (/failed to fetch|networkerror|enotfound|load failed/.test(combined)) {
    return `Could not reach ${supabaseHost()}. Check EXPO_PUBLIC_SUPABASE_URL in .env.local and restart the dev server.`;
  }
  return message || 'Could not upload this file to Supabase Storage.';
}
