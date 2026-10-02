import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { decode } from 'base64-arraybuffer';
import { addDoc, collection, getDocs, serverTimestamp } from 'firebase/firestore';

import { getFirebaseDb } from '@/lib/firebase';
import { PostSound } from '@/lib/music';

export const IMAGE_CONTENT_TYPE = 'image/jpeg';
export const VIDEO_CONTENT_TYPE = 'video/mp4';
const UPLOAD_ATTEMPTS = 3;

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
// Deliberately EXPO_PUBLIC_ prefixed, and deliberately expected to be empty.
//
// .env.local holds a `SUPABASE_ACCESS_TOKEN` without the prefix. That is correct and must stay that
// way: Expo only inlines EXPO_PUBLIC_* variables into a client bundle, so an unprefixed token is
// invisible to the app. Prefixing it would work, and would also ship your service role key to every
// device. A token has to come from your server, never from here.
//
// So the client authenticates as the anon key and relies on the bucket's own policies. An unset
// token is normal rather than a misconfiguration, and getSupabase warns when it is missing so a
// 401 from the storage policies is not left to be guessed at.
const supabaseAccessToken = process.env.EXPO_PUBLIC_SUPABASE_ACCESS_TOKEN || '';
const supabaseBucket = process.env.EXPO_PUBLIC_SUPABASE_BUCKET || 'media';

let supabaseClient: SupabaseClient | null = null;
let hasWarnedAboutMissingToken = false;

export function isSupabaseConfigured() {
  return Boolean(supabaseUrl && supabaseAnonKey);
}

function getSupabase(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error(
      'Supabase is not configured. Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to .env.local, then restart the dev server.',
    );
  }

  if (!supabaseAccessToken && !hasWarnedAboutMissingToken) {
    hasWarnedAboutMissingToken = true;
    console.warn(
      `Uploading with the anon key and no Authorization header. If the bucket "${supabaseBucket}" refuses writes, its Storage policies are the cause: allow INSERT for anon or authenticated.`,
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
//
// Note what is deliberately absent: "not found". A 404 is not a dropped connection, it is a
// permanent answer (a bucket that does not exist, a key that is not addressable), and treating it
// as transient made the retry loop spend three attempts and two backoffs on a failure that was
// never going to succeed, before reporting the same thing.
function isNetworkError(error: unknown) {
  const text = errorText(error);

  return /fetch failed|failed to fetch|network ?request ?failed|networkerror|connectexception|connection ?refused|unable to resolve host|econnreset|econnrefused|etimedout|timeout|socket hang up|load failed/.test(text);
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

/**
 * Who a post is visible to.
 *
 * A closed set rather than a free string, because this value is written straight into the document
 * and is read back by both the feed and the security rules. A typo here would be a post nobody can
 * see, or one that is public when it was meant to be private, so the choices are named once here
 * and every screen picks from this list rather than inventing its own.
 *
 * A post written before visibility existed has no `visibility` field at all, which the rules treat
 * as public. That is why the default is public and not something restrictive.
 */
export const POST_VISIBILITIES = ['public', 'followers_friends', 'friends_only', 'only_me'] as const;

export type PostVisibility = (typeof POST_VISIBILITIES)[number];

/** What a post gets when the screen does not choose. A new post is public, as it always was. */
export const DEFAULT_POST_VISIBILITY: PostVisibility = 'public';

export interface UploadPostInput {
  /**
   * The image as base64, when the caller already has it. Camera captures arrive this way and
   * skip the file read entirely; anything else is read from `uri`.
   */
  base64?: string;
  /**
   * Flat colour for a post with no file behind it, the way a text post is published. When this is
   * set the storage upload is skipped entirely and the feed paints the colour instead.
   */
  backgroundColor?: string;
  caption: string;
  /** Long form text. Written to its own field as well as folded into the caption. */
  description?: string;
  displayName: string;
  mediaType: 'image' | 'video';
  /**
   * The uids of everyone mentioned in the description, so a mention can be turned into a
   * notification without re-parsing the caption text. The `@name` in the caption stays too, because
   * that is what the reader sees.
   */
  mentionedUserIds?: string[];
  /** A link attached to the post. Empty when the screen has not collected one. */
  postLink?: string;
  /**
   * Who can see the post. Defaults to public rather than to a private post nobody expected.
   *
   * The audience itself is not passed in: it is derived from the author's follow list by
   * `buildAudience`, so a caller cannot widen a post's reach by handing over a longer list.
   */
  visibility?: PostVisibility;
  sound?: PostSound;
  /** Short headline, written to its own field. */
  title?: string;
  /** The file to upload. Omitted only for a background colour post. */
  uri?: string;
  userId: string;
}

/**
 * The uids a restricted post is readable by, written onto the post as `visibleToUids`.
 *
 * This is the piece that makes the privacy rules enforceable at all. Firestore refuses any
 * collection query whose rule depends on the individual document being read, so a rule like
 * "readable if you follow the author" can protect a `get` but can never let a feed query through.
 * Putting the audience in an array on the post turns the check into `request.auth.uid in
 * resource.data.visibleToUids`, which a query *can* be validated against through
 * `array-contains`.
 *
 * What it costs, stated plainly: the audience is a snapshot taken the moment the post is made.
 * Someone who follows the author afterwards will not see older restricted posts, and revoking a
 * follow will not take an already published post away. Making that live needs a trusted server to
 * maintain the list, which is a Cloud Function and not something a client can be trusted to do.
 *
 * The author's follow list is the audience because that is the one list the author is allowed to
 * read (`users/{uid}/following` is owner-listable) and it is the network a restricted post is
 * meant for in this app. Their *followers* cannot be enumerated from a client at all: it would
 * take a collection-group query across every user's follow subcollection, which the rules deny.
 *
 * Exported because the edit screen has to rebuild this as well: changing a post's audience means
 * rewriting the list on the document, not just the label beside it.
 */
export async function buildAudience(authorId: string, visibility: PostVisibility): Promise<string[]> {
  // A public post needs no audience, and a private one is the author's alone, which the rules read
  // off userId. Reading the follow list for either would be a wasted query.
  if (visibility === 'public' || visibility === 'only_me') {
    return [];
  }

  try {
    const snapshot = await getDocs(
      collection(getFirebaseDb(), 'users', authorId, 'following'),
    );

    // The author is in the list by definition, and including them keeps the array meaningful on its
    // own: it is then the complete set of accounts allowed to read the post, not just the others.
    return [authorId, ...snapshot.docs.map((followDocument) => followDocument.id)]
      .filter((uid, index, all) => all.indexOf(uid) === index);
  } catch (error) {
    // A restricted post whose audience could not be read must not fall back to an empty list, which
    // would publish it to nobody and look like a broken feed entry. It also must not fall back to
    // everyone. The post is refused instead, so the author can retry and knows why.
    console.error('Could not read the follow list to build the post audience:', error);
    throw new Error(
      'We could not work out who this post is for. Please check your connection and try again.',
    );
  }
}

/**
 * A storage key that no other post will ever use.
 *
 * `Date.now()` alone is not enough. It is millisecond resolution, so two posts made in the same
 * millisecond collide, and the upload runs with `upsert: true` because the retry loop has to be
 * able to write the same key twice. A collision therefore does not fail loudly: it silently
 * replaces the bytes already at that key, and since both posts then hold the same public URL, one
 * of them renders the other's photo. The random suffix makes that unreachable, and the timestamp is
 * kept only so the keys sort chronologically and stay readable while debugging.
 */
function uniqueFileName(userId: string, extension: string) {
  const random = Math.random().toString(36).slice(2, 10);

  return `${userId}_${Date.now()}_${random}.${extension}`;
}

export interface UploadPostResult {
  /** Empty for a background colour post, which has no file. */
  mediaUrl: string;
  postId: string;
}

// Reads the file into something the storage client will accept as a binary body.
//
// Exactly one source supplies the bytes. `base64` is a shortcut around the file system for a photo
// whose bytes are already in memory, and it is only ever passed when the caller has confirmed those
// bytes belong to `uri`; passing it for a different photo would upload the previous capture while
// the post claims the new one. A base64 that is not a JPEG is rejected rather than sent, because a
// truncated or wrongly encoded body would fail at the far end of an upload rather than here.
async function readMediaBody(
  mediaType: 'image' | 'video',
  uri: string,
  base64?: string,
): Promise<{ body: ArrayBuffer | Blob; bytes: number; source: string }> {
  // 1. Image: convert the base64 string into an ArrayBuffer, which avoids re-reading the file.
  if (mediaType === 'image' && base64) {
    // Every JPEG starts with the same two bytes once base64 encoded. Checking them here catches a
    // payload that got truncated in memory or handed over as raw bytes.
    if (!base64.startsWith('/9j/')) {
      console.warn('Ignoring base64 that is not JPEG data; reading the file instead.');
    } else {
      const arrayBuffer = decode(base64);

      if (arrayBuffer.byteLength > 0) {
        return { body: arrayBuffer, bytes: arrayBuffer.byteLength, source: 'base64-arraybuffer' };
      }
    }
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
 * Writes a post document to Firestore, uploading the file to Supabase Storage first when there
 * is one.
 *
 * Shared by the camera screen and the post details screen so both write the same document shape.
 * A post with a background colour and no file skips the storage step entirely rather than
 * uploading an empty body, because the feed paints that colour instead of loading media.
 * Every failure is logged with the detail needed to reproduce it and then rethrown as an Error
 * whose message is already the sentence to show the user, so callers only have to display it.
 */
export async function uploadPost(input: UploadPostInput): Promise<UploadPostResult> {
  const {
    backgroundColor,
    base64,
    caption,
    description,
    displayName,
    mediaType,
    mentionedUserIds,
    postLink,
    sound,
    title,
    uri,
    userId,
    visibility = DEFAULT_POST_VISIBILITY,
  } = input;

  if (!uri && !backgroundColor) {
    throw new Error('This post has neither a file nor a background colour.');
  }

  const extension = mediaType === 'video' ? 'mp4' : 'jpg';
  const fileName = uniqueFileName(userId, extension);
  const contentType = mediaType === 'video' ? VIDEO_CONTENT_TYPE : IMAGE_CONTENT_TYPE;
  let byteLength = 0;
  let source = '';
  // Remembered so the document can be checked against what was actually written, rather than
  // trusting that the two stayed in step.
  let uploadedKey = '';

  // Read before the upload rather than after it, so a post whose audience cannot be worked out
  // fails before several megabytes have gone to storage and been orphaned there.
  const audience = await buildAudience(userId, visibility);

  try {
    let mediaUrl = '';

    if (uri) {
      const media = await readMediaBody(mediaType, uri, base64);
      byteLength = media.bytes;
      source = media.source;

      // Upload to Supabase Storage. Without contentType it is stored as text/plain.
      await uploadWithRetry(fileName, media.body, contentType);
      uploadedKey = fileName;

      // Derived from the same key the bytes were written under, so the url on the document cannot
      // name a different object than the one this post just uploaded. There is no second lookup
      // that could disagree with it.
      const { data } = getSupabase().storage.from(supabaseBucket).getPublicUrl(fileName);
      mediaUrl = data.publicUrl;

      // Printed before the Firestore write on purpose: if a post ever renders the wrong photo,
      // comparing this line against the document decides whether the fault is here (the wrong bytes
      // were uploaded, or the wrong key was addressed) or in the feed (the document holds the right
      // url and is being rendered from something else). Without it the two are indistinguishable
      // from the outside, because both look like an ordinary image.
      console.log('Uploaded media', {
        bytes: byteLength,
        key: fileName,
        mediaUrl,
        source,
      });
    } else {
      source = 'background-colour';
    }

    // Save the post in the Firestore posts collection.
    const created = await addDoc(collection(getFirebaseDb(), 'posts'), {
      // Only a text post carries one, and it is written as null otherwise so the feed can ask
      // whether the field is null rather than whether it happens to exist.
      backgroundColor: backgroundColor ?? null,
      // Started at zero so the comment counter on the post is a real number from the
      // first moment, which is what the transaction in lib/comments.ts reads.
      caption: caption.trim(),
      commentsCount: 0,
      createdAt: serverTimestamp(),
      // The details screen writes a title and a longer description. The feed draws the title on
      // its own line and reads this as the caption.
      description: (description ?? '').trim(),
      displayName,
      mediaType,
      // The cover, on its own field as well as in the array below.
      //
      // This is the field the feed actually draws (home.tsx reads `mediaUrl` and falls back to a
      // placeholder avatar when it is absent), and it is what post deletion parses to find the
      // object to remove. Writing only `mediaUrls` left every newly created post with no cover at
      // all: the photo uploaded and stored correctly, and the feed showed a placeholder in its
      // place. Always written, empty string for a post with no file, so no reader has to cope with
      // the key being missing.
      mediaUrl,
      // Every photo on the post, with the cover first. A post written before the editor existed has
      // no array, so it reads as the cover alone rather than as an empty post.
      mediaUrls: mediaUrl ? [mediaUrl] : [],
      // Deduplicated so the same person picked twice is stored once, and always written so a query
      // can ask "who is notified about this" without a missing-key check.
      mentionedUserIds: [...new Set(mentionedUserIds ?? [])],
      // Always written, empty string and all, so a query can ask "is this post restricted" without
      // having to handle the field being absent on older documents.
      postLink: (postLink ?? '').trim(),
      // The accounts allowed to read this post, worked out from the author's follow list. This is
      // what the security rules check, so it has to be on the document rather than derived at read
      // time. Always written, empty for a public or private post, so the rules never have to cope
      // with the field being missing on a new document.
      visibleToUids: audience,
      visibility,
      // Only copied field by field rather than spreading the search result, so a post can
      // never carry anything the feed does not expect. The attribution fields come along
      // because a CC BY track has to name the artist and the licence.
      ...(sound ? { sound } : {}),
      title: (title ?? '').trim(),
      userId,
    });

    return { mediaUrl, postId: created.id };
  } catch (error) {
    // Detailed error logging
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
      // The key that was written, when the failure came after it. Without this, an orphaned object
      // in the bucket cannot be traced back to the post that produced it.
      uploadedKey,
      userId,
    });

    throw new Error(describeError(error));
  }
}