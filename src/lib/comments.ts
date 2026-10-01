import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';

import { getFirebaseDb } from '@/lib/firebase';

// Comments live in their own subcollection under the post, next to the reactions. The feed
// only needs a number for them, which the post document carries, so the whole list is only
// read once a comment sheet is actually open.
const COMMENTS_COLLECTION = 'comments';

// A post with more comments than this still shows the newest ones, which is what the sheet
// opens on.
const COMMENTS_LIMIT = 60;

export const MAX_COMMENT_LENGTH = 500;

export interface PostComment {
  createdAt: Date | null;
  displayName: string;
  id: string;
  // Null on a top level comment. A reply carries the id of the comment it hangs under, which
  // is what the sheet groups on.
  parentId: string | null;
  replyToName?: string;
  text: string;
  userId: string;
}

function toComment(id: string, data: Record<string, unknown>): PostComment {
  const createdAt = data.createdAt instanceof Date
    ? data.createdAt
    : data.createdAt instanceof Timestamp ? data.createdAt.toDate() : null;
  const replyToName = data.replyToName;
  const parentId = data.parentId;

  return {
    createdAt,
    displayName: typeof data.displayName === 'string' && data.displayName ? data.displayName : 'User',
    id,
    // Comments written before replies existed have no parentId field at all, and Firestore
    // cannot store undefined, so anything that is not a non-empty string reads as null.
    parentId: typeof parentId === 'string' && parentId ? parentId : null,
    replyToName: typeof replyToName === 'string' && replyToName ? replyToName : undefined,
    text: typeof data.text === 'string' ? data.text : '',
    userId: typeof data.userId === 'string' ? data.userId : '',
  };
}

function commentsQuery(postId: string) {
  return query(
    collection(getFirebaseDb(), 'posts', postId, COMMENTS_COLLECTION),
    orderBy('createdAt', 'desc'),
    limit(COMMENTS_LIMIT),
  );
}

export function listenToComments(
  postId: string,
  onChange: (comments: PostComment[]) => void,
  onError: (error: unknown) => void,
) {
  return onSnapshot(
    commentsQuery(postId),
    (snapshot) => {
      onChange(snapshot.docs.map((comment) => toComment(comment.id, comment.data())));
    },
    onError,
  );
}

export interface NewComment {
  displayName: string;
  // Null for a top level comment. A reply carries the id of the comment it hangs under.
  parentId?: string | null;
  replyToName?: string;
  text: string;
  userId: string;
}

// The comment document and the counter on the post are written in one transaction, so the
// number the feed shows can never claim a comment that was not stored, or miss one that was.
// The counter is what the feed reads, so it has to move together with the list. It is read
// and set rather than incremented, because posts created before comments existed carry no
// counter field at all.
export async function addComment(postId: string, comment: NewComment) {
  const db = getFirebaseDb();
  const postRef = doc(db, 'posts', postId);
  const commentRef = doc(collection(postRef, COMMENTS_COLLECTION));

  await runTransaction(db, async (transaction) => {
    const post = await transaction.get(postRef);
    const stored = post.exists() ? post.data().commentsCount : undefined;
    const count = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;

    transaction.set(commentRef, {
      createdAt: serverTimestamp(),
      displayName: comment.displayName,
      // Written as null rather than left out, so the two cases can be told apart by asking
      // whether the field is null instead of by checking whether it happens to exist.
      parentId: comment.parentId ?? null,
      replyToName: comment.replyToName ?? null,
      text: comment.text,
      userId: comment.userId,
    });

    transaction.update(postRef, { commentsCount: count + 1 });
  });
}

/**
 * Removes a comment and the replies hanging off it.
 *
 * The replies are passed in rather than looked up here: a transaction cannot read a query, and
 * the caller already has the whole thread on screen. A reply that arrives between that read and
 * this write is not deleted, but it keeps its parentId, and the sheet promotes a reply whose
 * parent is missing to the top level, so it stays visible instead of being lost.
 */
export async function deleteComment(postId: string, commentId: string, replyIds: string[] = []) {
  const db = getFirebaseDb();
  const postRef = doc(db, 'posts', postId);
  const commentsRef = collection(postRef, COMMENTS_COLLECTION);

  await runTransaction(db, async (transaction) => {
    const post = await transaction.get(postRef);
    const stored = post.exists() ? post.data().commentsCount : undefined;
    const count = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;

    for (const replyId of replyIds) {
      transaction.delete(doc(commentsRef, replyId));
    }

    transaction.delete(doc(commentsRef, commentId));
    // Every document removed, not just the one tapped, so the counter keeps matching the list.
    transaction.update(postRef, { commentsCount: Math.max(0, count - 1 - replyIds.length) });
  });
}

// Relative time reads better in a comment list than a clock: 5m, 2h, 3d.
export function formatCommentTime(value: Date | null) {
  if (!value) {
    return '';
  }

  const minutes = Math.floor((Date.now() - value.getTime()) / 60_000);

  if (minutes < 1) {
    return 'now';
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);

  if (days < 7) {
    return `${days}d`;
  }

  return value.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
