import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';

import { getFirebaseStorage, isFirebaseStorageConfigured } from '@/lib/firebase';
import {
  buildStorageUploadBody,
  getSupabaseClient,
  isSupabaseStorageConfigured,
  removePostMedia,
  storagePathFromUrl,
  supabaseBucket,
} from '@/lib/supabase';

/**
 * Where a chat attachment's bytes go.
 *
 * Firebase Storage would be the obvious home for these, and it is still the first choice when the project
 * has a bucket: its download urls are the ones the app already reads everywhere else. This project's
 * bucket does not exist, though -- Storage is switched on per project by turning on billing, and until
 * that happens every photo, clip, voice note and file in a conversation fails to upload and the reader
 * sees nothing at all.
 *
 * So the same Supabase bucket that already holds the feed's photos is the fallback, and because that one
 * is already configured and public, chat attachments work today without turning on billing. The url that
 * comes back is an ordinary https url either way, so nothing downstream needs to know which one it got.
 */

export type ChatMediaUpload = {
    chatId: string;
    contentType: string;
    fileName: string;
    /** Where the bytes are on this device. Read differently per backend, as the comment on each says. */
    uri: string;
    uid: string;
};

export type UploadedChatMedia = {
  /** The object path, for removing it again. Empty when the upload went to Firebase and has no path here. */
  mediaPath: string;
  mediaUrl: string;
};

/** Whether anything can be uploaded at all, so the composer can say so before the reader tries. */
export function canUploadChatMedia() {
  return isSupabaseStorageConfigured() || isFirebaseStorageConfigured();
}

/**
 * Whether the attachments will land in Supabase rather than Firebase Storage.
 *
 * Exposed because the two differ in one way a reader can see: a Supabase url is a plain https address
 * that keeps working, while a Firebase download url is signed against the bucket's rules and needs the
 * recipient to still be able to read the room. Nothing here depends on the difference; this is here so the
 * answer to "why did this fail" is knowable without a network round trip.
 */
export function chatMediaUsesSupabase() {
  return isSupabaseStorageConfigured();
}

function safeFileName(fileName: string) {
  const cleaned = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);

  // A name that is only an extension would produce `.jpg`, which reads as a hidden file rather than a
  // photo, and an empty name produces a key ending in an underscore.
  return cleaned === '' || cleaned.startsWith('.') ? `file${cleaned}` : cleaned;
}

/** The object path, which is also what makes two uploads of the same file name two files. */
export function chatMediaPath(uid: string, chatId: string, fileName: string) {
  return `chats/${chatId}/${uid}/${Date.now()}_${safeFileName(fileName)}`;
}

async function uploadToSupabase(upload: ChatMediaUpload): Promise<UploadedChatMedia> {
  const storage = getSupabaseClient().storage.from(supabaseBucket);
  const mediaPath = chatMediaPath(upload.uid, upload.chatId, upload.fileName);
  // Built here rather than passed in, because the shape is this backend's business: the same file
  // needs to be turned into bytes here and the caller holding a picker uri cannot know what the
  // network layer accepts. The content type travels with it, because a byte body has no part header
  // to carry one and Supabase stores the object as text/plain without it.
  const body = await buildStorageUploadBody({
    contentType: upload.contentType,
    fileName: upload.fileName,
    uri: upload.uri,
  });
  const { error } = await storage.upload(mediaPath, body, {
    cacheControl: '3600',
    contentType: upload.contentType,
    upsert: false,
  });

  if (error) {
    throw error;
  }

  const { data } = storage.getPublicUrl(mediaPath);

  if (!data.publicUrl) {
    throw new Error('Supabase did not return a public URL for the uploaded file.');
  }

  return { mediaPath, mediaUrl: data.publicUrl };
}

async function uploadToFirebaseStorage(upload: ChatMediaUpload): Promise<UploadedChatMedia> {
  if (!isFirebaseStorageConfigured()) {
    throw new Error('Firebase Storage is not configured. Add EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET to .env.local.');
  }

  // Firebase takes the bytes themselves on every platform, so the uri is read into memory first.
  const response = await fetch(upload.uri);

  if (!response.ok) {
    throw new Error('Could not read the selected file.');
  }

  const uploaded = await uploadBytes(
    ref(
      getFirebaseStorage(),
      `chats/${upload.chatId}/messages/${upload.uid}/${Date.now()}_${safeFileName(upload.fileName)}`,
    ),
    await response.blob(),
    { contentType: upload.contentType },
  );

  return { mediaPath: '', mediaUrl: await getDownloadURL(uploaded.ref) };
}

export async function uploadChatMedia(upload: ChatMediaUpload): Promise<UploadedChatMedia> {
  if (isSupabaseStorageConfigured()) {
    return uploadToSupabase(upload);
  }

  return uploadToFirebaseStorage(upload);
}

/**
 * Removes an uploaded attachment, for when the message carrying it never got written.
 *
 * Only for the Supabase path: a Firebase download url is not enough to find the object, because the
 * storage rules decide who may delete it and the app has no admin credential to do it with. Leaving one
 * orphaned file behind is cheaper than a second set of storage rules to maintain.
 */
export async function removeChatMedia(mediaUrl: string) {
  const mediaPath = storagePathFromUrl(mediaUrl);

  if (mediaPath === '') {
    return;
  }

  await removePostMedia(mediaPath);
}