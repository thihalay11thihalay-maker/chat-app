import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  where,
} from 'firebase/firestore';

import { getFirebaseDb } from '@/lib/firebase';
import { PostSound, toPostSoundValue } from '@/lib/music';

/**
 * One post as the app draws it.
 *
 * Its own file because three places read posts now -- the feed, the post details sheet and somebody's
 * profile -- and a document that is interpreted in more than one place is a document that is eventually
 * interpreted differently in two of them. Every field below says what it means when it is missing,
 * because most of them can be: a post written before the editor existed has no description, and one
 * written before visibility existed has no visibility.
 */
export interface Post {
  id: string;
  /** Flat colour standing in for the media on a text post. */
  backgroundColor?: string;
  displayName?: string;
  mediaType?: 'image' | 'video';
  mediaUrl?: string;
  /**
   * Every photo on the post. `mediaUrl` stays the cover the feed draws, so this is the full set
   * behind it. A post written before the editor existed has no array, so it reads as the cover
   * alone rather than as an empty post.
   */
  mediaUrls?: string[];
  /** Who the post is published to. Public when absent, which is how every post behaved before. */
  visibility?: string;
  caption?: string;
  /** Longer form text from the post details screen, shown under the title. */
  description?: string;
  title?: string;
  createdAt?: Timestamp | Date | null;
  commentsCount: number;
  lovesCount: number;
  likesCount: number;
  sharesCount: number;
  sound?: PostSound;
  userId: string;
}

function toCount(data: Record<string, unknown>, key: string) {
  const value = data[key];
  const parsed = typeof value === 'number' ? value : Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/** A stored post's time as a number, whichever of the two shapes it arrived in. Zero when neither. */
function timeOf(createdAt: Timestamp | Date | null | undefined) {
  if (createdAt instanceof Timestamp) {
    return createdAt.toMillis();
  }

  if (createdAt instanceof Date) {
    return createdAt.getTime();
  }

  return 0;
}

/** The photo a post row draws, from whichever field carries it. */
function coverFrom(data: Record<string, unknown>): string | undefined {
  if (typeof data.mediaUrl === 'string' && data.mediaUrl) {
    return data.mediaUrl;
  }

  if (Array.isArray(data.mediaUrls)) {
    const first = data.mediaUrls.find(
      (item): item is string => typeof item === 'string' && /^https?:\/\//i.test(item),
    );

    if (first) {
      return first;
    }
  }

  return undefined;
}

/** A stored post document as the app reads it. Exported because the profile reads posts too. */
export function toPost(id: string, data: Record<string, unknown>): Post {
  const createdAt = data.createdAt;
  const mediaType = data.mediaType;

  const post: Post = {
    id,
    // Only a hex colour is trusted: this string goes straight onto a view's background, so a
    // hand-edited document cannot smuggle anything else into the feed's styling.
    backgroundColor:
      typeof data.backgroundColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(data.backgroundColor)
        ? data.backgroundColor
        : undefined,
    caption: typeof data.caption === 'string' ? data.caption : undefined,
    commentsCount: toCount(data, 'commentsCount'),
    createdAt: createdAt instanceof Date || createdAt instanceof Timestamp ? createdAt : null,
    // Posts written before the details screen have neither field, so both read as absent rather
    // than as an empty line above the caption.
    description: typeof data.description === 'string' ? data.description : undefined,
    displayName: typeof data.displayName === 'string' ? data.displayName : undefined,
    lovesCount: toCount(data, 'lovesCount'),
    likesCount: toCount(data, 'likesCount'),
    mediaType: mediaType === 'image' || mediaType === 'video' ? mediaType : undefined,
    // The cover, falling back to the first entry of the array when the field is absent.
    //
    // Posts created before the writer started saving `mediaUrl` carry only `mediaUrls`, and this
    // fallback is what makes their photo appear instead of the placeholder. It is a read-side
    // repair, so it heals every existing document at once instead of waiting on a backfill; new
    // posts save both fields, so the fallback never fires for them.
    mediaUrl: coverFrom(data),
    // The full set behind the cover, with anything that is not a usable http url dropped. A post
    // with no array falls back to its single cover, so nothing written before the editor existed
    // comes back as an empty list.
    mediaUrls:
      Array.isArray(data.mediaUrls) && data.mediaUrls.some((item) => typeof item === 'string')
        ? (data.mediaUrls as unknown[]).filter(
            (item): item is string => typeof item === 'string' && /^https?:\/\//i.test(item),
          )
        : typeof data.mediaUrl === 'string' && data.mediaUrl
          ? [data.mediaUrl]
          : [],
    sharesCount: toCount(data, 'sharesCount'),
    // Absent on posts written before visibility existed, which the rules treat as public, so the
    // indicator is left off rather than showing a lock nobody set.
    visibility: typeof data.visibility === 'string' ? data.visibility : undefined,
    // A post without a usable sound object is treated as having no sound, so one bad document
    // cannot break the row.
    sound: toPostSoundValue(data.sound) ?? undefined,
    title: typeof data.title === 'string' ? data.title : undefined,
    userId: typeof data.userId === 'string' ? data.userId : '',
  };

  // The other half of the diagnostic the upload side prints. If these two lines disagree for the
  // same post, the document was written with one url and is being served another; if they agree
  // and the photo is still wrong, the object behind that url holds the wrong bytes and the fault
  // is in what was uploaded. Read from the snapshot rather than from the rendered row, so it fires
  // once per document Firestore delivers.
  if (__DEV__) {
    console.log('Feed post media', { mediaUrl: post.mediaUrl ?? '', postId: id });
  }

  return post;
}

// How many posts a profile shows. A profile is not an archive, and the whole list would be a scroll
// nobody finishes; the rest of the work is in the feed, which is where a profile is meant to send you.
const PROFILE_POST_LIMIT = 24;

/**
 * The posts of one account, newest first, that the viewer is allowed to read.
 *
 * Two listeners rather than one, because the rules cannot express "this author's posts" as a single
 * query. They accept a query only when its own filters prove the rule for every document it might
 * return, and there are exactly three provable shapes: the public feed, your own posts, and the posts
 * whose `visibleToUids` contains you. An author's public posts are the first of those narrowed to
 * them, and their restricted posts are the third narrowed to them -- so a profile that is not yours is
 * the first two together, and a profile that is yours is just your own.
 *
 * The two are merged here rather than drawn from two lists: one feed of somebody's posts in order is
 * what a profile is, and a split list would be sorted by nothing at all.
 *
 * A post written before visibility existed carries no `visibility` field, and a query cannot ask for
 * "field absent" in a way the rules accept, so such a post does not come back from either query here.
 * That is not a gap that has to be fixed: the account that wrote it is given `visibility: 'public'`
 * on sign-in by `use-visibility-backfill`, after which it is found by the first query like any other
 * public post.
 */
export function listenToUserPosts(
  authorId: string,
  viewerId: string,
  onChange: (posts: Post[]) => void,
  onError: (error: Error) => void,
) {
  const isOwn = authorId === viewerId;
  const db = getFirebaseDb();
  const posts = collection(db, 'posts');

  // Own posts need no second listener: the rules already prove `userId == <me>`, so one query returns
  // everything of yours including the restricted posts.
  const shapes: ReturnType<typeof query>[] = isOwn
    ? [query(posts, where('userId', '==', viewerId), orderBy('createdAt', 'desc'), limit(PROFILE_POST_LIMIT))]
    : [
      query(posts, where('visibility', '==', 'public'), where('userId', '==', authorId), orderBy('createdAt', 'desc'), limit(PROFILE_POST_LIMIT)),
      query(posts, where('visibleToUids', 'array-contains', viewerId), where('userId', '==', authorId), orderBy('createdAt', 'desc'), limit(PROFILE_POST_LIMIT)),
    ];

  const seen = new Map<string, Post>();
  const unsubscribes = shapes.map((shape) => onSnapshot(
    shape,
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'removed') {
          seen.delete(change.doc.id);
          continue;
        }

        seen.set(change.doc.id, toPost(change.doc.id, change.doc.data() as Record<string, unknown>));
      }

      onChange(
        [...seen.values()].sort((first, second) => timeOf(second.createdAt) - timeOf(first.createdAt)),
      );
    },
    (error) => onError(error),
  ));

  return () => {
    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
  };
}
