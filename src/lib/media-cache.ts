import { Directory, File, Paths } from 'expo-file-system';
import { Asset } from 'expo-media-library';

import { AlbumItem, ChatMessageType } from '@/lib/chat-messages';

/**
 * Two copies of a photo or a clip, and the difference between them matters.
 *
 * One is the app cache: a copy inside this app's own storage that arrives in the background as soon as a
 * message is on screen, so the same picture opens instantly the next time and still opens at all with no
 * connection. Nobody is asked about it and nothing leaves the device's app storage. It is a cache, which
 * means the system is free to delete it when storage runs short, and everything here is written so that
 * losing it costs a download and nothing else.
 *
 * The other is the phone's own gallery, and that is only ever written when somebody presses Save, because
 * a file in the gallery is a file somebody else can find, that other apps can read, and that survives
 * uninstalling this app. Saving without being asked would be a decision made on the reader's behalf, so
 * the menu and the button on the picture both go through the same call and nothing else does.
 *
 * Nothing here talks to the network by any route other than a plain file download of a URL a message
 * already carries.
 */

/** Where cached media lives. One directory, so it can be emptied in one go. */
function mediaDirectory() {
    return new Directory(Paths.cache, 'chat-media');
}

/**
 * The four fields the cache and the gallery actually read off a piece of media.
 *
 * Narrower than a whole `ChatMessage` on purpose. One album item is a file in an array rather than a
 * message of its own, and an album is saved through exactly this path -- so the thing being saved is
 * described as a file with an id, which is what it is, instead of as a message with a sender and a type
 * it does not have.
 */
export type CacheableMedia = {
    fileSize?: number;
    /** Unique per file, so two people sending the same picture each get their own copy. */
    id: string;
    mediaUrl?: string;
    type: ChatMessageType;
};

/**
 * One album item, as something the cache can hold and the gallery can be given.
 *
 * The id is the message's own id with the position in the album on the end, which is what keeps the ten
 * files of one album from overwriting each other in the cache directory and makes a saved item's cache
 * name recognisable as belonging to that album.
 */
export function albumItemMedia(messageId: string, index: number, item: AlbumItem): CacheableMedia {
    return {
        fileSize: item.fileSize,
        id: `${messageId}-${index}`,
        mediaUrl: item.mediaUrl,
        type: item.type,
    };
}


/**
 * What the file should be called, which is mostly the extension the URL already has.
 *
 * The extension is what the gallery reads to decide whether a file is a photograph, a clip or a voice
 * note, and what the phone shows it as. Guessing one for a photo would give a reader a picture called
 * `photo.mp4` in their camera roll, so the URL is asked first and the message type is only the fallback.
 */
const EXTENSION_BY_TYPE: Record<string, string> = {
  audio: '.m4a',
  image: '.jpg',
  video: '.mp4',
};

function extensionFor(message: CacheableMedia) {
  const url = message.mediaUrl ?? '';
  // The path without the query string, so a signed URL's `?token=...&ext=.png` cannot supply an extension.
  const path = url.split('?')[0].split('#')[0];
  const match = /\.[a-z0-9]{1,5}$/i.exec(path);

  if (match) {
    return match[0].toLowerCase();
  }

  return EXTENSION_BY_TYPE[message.type] ?? '';
}

/**
 * Whether a value is an ordinary web URL.
 *
 * Shared rather than repeated, because "is this safe to hand to something that can open a URL" has to be
 * answered the same way everywhere it is asked.
 *
 * It matters most for `Linking.openURL`. That hands the string to the operating system, which will launch
 * whatever handler is registered for the scheme -- on Android an `intent://` URL can name an exported
 * component, not just a web page. A message document is attacker-controlled by anyone in the room: the
 * create rule validates no fields, so `mediaUrl` can be any string at all. Validating at the point of use
 * is what stops that, and it is the last place before the OS.
 *
 * `https` only, with `http` allowed because development and some Supabase buckets still serve it. Anything
 * else -- `file:`, `data:`, `intent:`, `javascript:`, a bare scheme, a relative path -- is refused.
 */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();

  return trimmed.startsWith('https://') || trimmed.startsWith('http://');
}

/**
 * Whether this message is something worth having a copy of.
 *
 * Photographs, clips and voice notes only. A file attachment is left out because its size is whatever
 * somebody chose to send and there is no upper bound worth guessing at, and a location or a contact is
 * not a file at all.
 */
function isCacheable(message: CacheableMedia) {
  if (message.type !== 'image' && message.type !== 'video' && message.type !== 'audio') {
    return false;
  }

  return isHttpUrl(message.mediaUrl);
}

/**
 * How large a file may be before it is left to stream.
 *
 * A cache that quietly fills a phone is worse than no cache: the system will delete it, and then the next
 * download puts it back. This is above what a photograph or a short clip weighs and below what a long video
 * does, so the usual conversation fills up and the unusual one is fetched when somebody asks for it.
 */
const MAX_CACHE_BYTES = 25 * 1024 * 1024;

/** Downloads already running, by message id, so one message is never fetched twice at once. */
const inFlight = new Map<string, Promise<File | null>>();

/**
 * Where a message's copy would live, whether or not it is there yet.
 *
 * Named after the message rather than after the URL, so two people sending the same picture each get their
 * own copy and a message whose media is replaced cannot be served the older file.
 */
function cacheFileFor(message: CacheableMedia) {
  return new File(mediaDirectory(), `${message.id}${extensionFor(message)}`);
}

/** Whether the copy is already on the device. Used to tell the reader what they are looking at. */
export function cachedMediaUri(message: CacheableMedia) {
  if (!isCacheable(message)) {
    return null;
  }

  try {
    const file = cacheFileFor(message);

    // A zero-length file is a download that failed partway, not a copy: treated as absent so the next ask
    // tries again rather than handing a reader an empty picture.
    return file.exists && file.size > 0 ? file.uri : null;
  } catch (error) {
    // The cache is a convenience. A path that cannot even be asked about is not worth an alert.
    console.warn('Could not look in the media cache:', error);

    return null;
  }
}

/**
 * The copy of a message's media, downloading it if it is not there yet.
 *
 * Resolves to null when the message has nothing to cache or is too large to cache, which is not a failure:
 * the reader still gets the remote file, streamed, and the Save button still downloads it on request.
 */
export function cacheMedia(message: CacheableMedia, onProgress?: (fraction: number) => void) {
  if (!isCacheable(message)) {
    return Promise.resolve(null);
  }

  const existing = cachedMediaUri(message);

  if (existing) {
    onProgress?.(1);

    return Promise.resolve(new File(existing));
  }

  if (typeof message.fileSize === 'number' && message.fileSize > MAX_CACHE_BYTES) {
    return Promise.resolve(null);
  }

  const running = inFlight.get(message.id);

  if (running) {
    return running;
  }

  const url = message.mediaUrl as string;
  const destination = cacheFileFor(message);

  const task = (async () => {
    try {
      // Created every time rather than once at module load: the cache directory is the kind of thing the
      // system empties, so a directory that existed at startup may not exist by the time this runs.
      const directory = mediaDirectory();

      if (!directory.exists) {
        directory.create({ intermediates: true, idempotent: true });
      }

      // Left over from a download that failed partway, so the next attempt is not refused for want of a
      // path. The system deletes the directory under us often enough that this has to be a guess rather
      // than a certainty.
      if (destination.exists) {
        destination.delete();
      }

      // A download task rather than the one-shot call, so a button can show how far along it is. On a
      // cache warmed in the background nobody is watching, which is the common case, and this costs
      // nothing for them.
      const download = File.createDownloadTask(url, destination, onProgress
        ? {
          onProgress: ({ bytesWritten, totalBytes }) => {
            if (totalBytes > 0) {
              onProgress(Math.min(1, bytesWritten / totalBytes));
            }
          },
        }
        : undefined);

      const file = await download.downloadAsync();

      // Null means the transfer was paused rather than finished, which nothing here does.
      return file ?? null;
    } catch (error) {
      console.warn('Could not cache the media for a message:', error);

      return null;
    } finally {
      inFlight.delete(message.id);
    }
  })();

  inFlight.set(message.id, task);

  return task;
}

/**
 * Puts a message's media in the phone's own gallery.
 *
 * The cache copy is what gets saved, so the file is downloaded once and the copy on the device is the same
 * bytes that were on screen. Throws with a sentence somebody can be told, because both reasons it can fail
 * -- a refused permission and a failed download -- are things the reader has to be told about rather than
 * have happen quietly.
 *
 * The caller must have asked for permission to write to the gallery first; this does not ask on its own,
 * because a permission prompt in the middle of a download is a question about the whole app and this is
 * only a question about one picture.
 */
export async function saveMediaToPhone(message: CacheableMedia) {
  const file = await cacheMedia(message);

  if (!file) {
    throw new Error('That file could not be downloaded to save it.');
  }

  try {
    await Asset.create(file.uri);
  } catch (error) {
    console.error('Could not save the media to the device:', error);

    throw new Error('Your device would not accept the file into your gallery.');
  }

  return file;
}