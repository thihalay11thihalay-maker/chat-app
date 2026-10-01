import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { decode } from 'base64-arraybuffer';
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';

import { getFirebaseDb } from '@/lib/firebase';
import { PostSound } from '@/lib/music';

export const IMAGE_CONTENT_TYPE = 'image/jpeg';
export const VIDEO_CONTENT_TYPE = 'video/mp4';
const UPLOAD_ATTEMPTS = 3;

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
const supabaseAccessToken = process.env.EXPO_PUBLIC_SUPABASE_ACCESS_TOKEN || '';
const supabaseBucket = process.env.EXPO_PUBLIC_SUPABASE_BUCKET || 'media';

let supabaseClient: SupabaseClient | null = null;

export function isSupabaseConfigured() {
  return Boolean(supabaseUrl && supabaseAnonKey);
}

function getSupabase(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error(
      'Supabase is not configured. Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to .env.local, then restart the dev server.',
    );
  }

  supabaseClient ??= createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: supabaseAccessToken
      ? { headers: { Authorization: `Bearer ${supabaseAccessToken}` } }
      : undefined,
  });

  return supabaseClient;
}

function toErrorDetails(error: unknown) {
  return typeof error === 'object' && error !== null
    ? error as { name?: unknown; message?: unknown; status?: unknown; statusCode?: unknown }
    : {};
}

function errorText(error: unknown) {
  const details = toErrorDetails(error);
  const name = typeof details.name === 'string' ? details.name : '';
  const message = typeof details.message === 'string' ? details.message : '';

  return `${name} ${message}`.toLowerCase();
}

// Android reports connection problems as "fetch failed" plus a nested java.io
// exception, so the string has to be checked instead of the error name.
function isNetworkError(error: unknown) {
  const text = errorText(error);

  return /fetch failed|failed to fetch|network ?request ?failed|networkerror|connectexception|connection ?refused|unable to resolve host|econnreset|econnrefused|etimedout|timeout|socket|load failed|not found/.test(text);
}

function isUnknownHostError(error: unknown) {
  return /unable to resolve host|enotfound|name not resolved|nxdomain|getaddrinfo/.test(errorText(error));
}

export function describeError(error: unknown) {
  const details = toErrorDetails(error);
  const message = typeof details.message === 'string' ? details.message : '';
  const statusCode = typeof details.statusCode === 'number'
    ? details.statusCode
    : typeof details.status === 'number'
      ? details.status
      : 0;
  const combined = `${typeof details.name === 'string' ? details.name : ''} ${message}`.toLowerCase();

  if (isUnknownHostError(error)) {
    return `Could not resolve "${supabaseUrl}". Check the Project URL and publishable key in .env.local (Dashboard -> Project Settings -> API), then restart the dev server.`;
  }
  if (isNetworkError(error)) {
    return `This device could not reach Supabase. Your connection dropped while uploading, so the upload was retried ${UPLOAD_ATTEMPTS} times. Check mobile data or Wi-Fi (some networks block Supabase's CDN) and try again.`;
  }
  if (statusCode === 401 || statusCode === 403) {
    return 'Supabase rejected the upload token. Check EXPO_PUBLIC_SUPABASE_ACCESS_TOKEN.';
  }
  if (statusCode === 404 || combined.includes('bucket')) {
    return `Bucket "${supabaseBucket}" was not found. Create it in Supabase Storage, or set EXPO_PUBLIC_SUPABASE_BUCKET.`;
  }
  if (combined.includes('row-level security') || combined.includes('policy')) {
    return 'Supabase Storage policies blocked this upload. Add an INSERT policy for anon and authenticated on the bucket.';
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  return 'Something went wrong.';
}

// Large videos over mobile data drop the connection often enough that a single failed
// request is not enough to call the upload a failure.
async function uploadWithRetry(fileName: string, fileBody: ArrayBuffer | Blob, contentType: string) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      const { error } = await getSupabase()
        .storage.from(supabaseBucket)
        .upload(fileName, fileBody, {
          contentType,
          upsert: true,
        });

      if (!error) {
        return;
      }

      lastError = error;

      if (!isNetworkError(error)) {
        throw error;
      }
    } catch (error) {
      lastError = error;

      if (!isNetworkError(error)) {
        throw error;
      }
    }

    if (attempt < UPLOAD_ATTEMPTS) {
      await new Promise((resolve) => {
        setTimeout(resolve, 800 * attempt);
      });
    }
  }

  throw lastError;
}

export interface UploadPostInput {
  /**
   * The image as base64, when the caller already has it. Camera captures arrive this way and
   * skip the file read entirely; anything else is read from `uri`.
   */
  base64?: string;
  caption: string;
  /** Long form text. Written to its own field as well as folded into the caption. */
  description?: string;
  displayName: string;
  mediaType: 'image' | 'video';
  sound?: PostSound;
  /** Short headline, written to its own field. */
  title?: string;
  uri: string;
  userId: string;
}

export interface UploadPostResult {
  mediaUrl: string;
  postId: string;
}

// Reads the file into something the storage client will accept as a binary body.
async function readMediaBody(
  mediaType: 'image' | 'video',
  uri: string,
  base64?: string,
): Promise<{ body: ArrayBuffer | Blob; bytes: number; source: string }> {
  // 1. Image: convert the base64 string into an ArrayBuffer, which avoids re-reading the file.
  if (mediaType === 'image' && base64) {
    const arrayBuffer = decode(base64);
    return { body: arrayBuffer, bytes: arrayBuffer.byteLength, source: 'base64-arraybuffer' };
  }

  // 2. Video: base64 is not available, so read the file with fetch and take a blob. A picker or
  // a route param can also hand us an image as a bare uri, which goes down this same path.
  const response = await fetch(uri);

  if (!response.ok) {
    throw new Error(`Could not read the ${mediaType} file (status ${response.status}).`);
  }

  const blob = await response.blob();
  const expectedPrefix = mediaType === 'video' ? 'video/' : 'image/';

  // supabase-js ignores options.contentType for Blob bodies and uses the blob type for the
  // multipart part, so the blob type is set explicitly.
  return {
    body: blob.type.startsWith(expectedPrefix)
      ? blob
      : new Blob([blob], { type: mediaType === 'video' ? VIDEO_CONTENT_TYPE : IMAGE_CONTENT_TYPE }),
    bytes: blob.size,
    source: 'fetch-blob',
  };
}

/**
 * Uploads one photo or clip to Supabase Storage and writes the post document to Firestore.
 *
 * Shared by the camera screen and the post details screen so both write the same document shape.
 * Every failure is logged with the detail needed to reproduce it and then rethrown as an Error
 * whose message is already the sentence to show the user, so callers only have to display it.
 */
export async function uploadPost(input: UploadPostInput): Promise<UploadPostResult> {
  const { base64, caption, description, displayName, mediaType, sound, title, uri, userId } = input;
  const extension = mediaType === 'video' ? 'mp4' : 'jpg';
  const fileName = `${userId}_${Date.now()}.${extension}`;
  const contentType = mediaType === 'video' ? VIDEO_CONTENT_TYPE : IMAGE_CONTENT_TYPE;
  let byteLength = 0;
  let source = '';

  try {
    const media = await readMediaBody(mediaType, uri, base64);
    byteLength = media.bytes;
    source = media.source;

    // 3. Upload to Supabase Storage. Without contentType it is stored as text/plain.
    await uploadWithRetry(fileName, media.body, contentType);

    const { data } = getSupabase().storage.from(supabaseBucket).getPublicUrl(fileName);
    const mediaUrl = data.publicUrl;

    // 4. Save the post in the Firestore posts collection.
    const created = await addDoc(collection(getFirebaseDb(), 'posts'), {
      // Started at zero so the comment counter on the post is a real number from the
      // first moment, which is what the transaction in lib/comments.ts reads.
      caption: caption.trim(),
      commentsCount: 0,
      createdAt: serverTimestamp(),
      // The details screen writes a title and a longer description; the feed reads the caption
      // alone, so the longer of the two is what it gets when a post has no caption of its own.
      description: (description ?? '').trim(),
      displayName,
      mediaType,
      mediaUrl,
      // Only copied field by field rather than spreading the search result, so a post can
      // never carry anything the feed does not expect. The attribution fields come along
      // because a CC BY track has to name the artist and the licence.
      ...(sound ? { sound } : {}),
      title: (title ?? '').trim(),
      userId,
    });

    return { mediaUrl, postId: created.id };
  } catch (error) {
    // 5. Detailed error logging
    console.error('Upload failed', {
      bucket: supabaseBucket,
      bytes: byteLength,
      caption: caption.trim(),
      contentType,
      error,
      errorMessage: describeError(error),
      fileName,
      mediaType,
      source,
      supabaseUrl,
      userId,
    });

    throw new Error(describeError(error));
  }
}