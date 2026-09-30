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
  replyToName?: string;
  text: string;
  userId: string;
}

function toComment(id: string, data: Record<string, unknown>): PostComment {
  const createdAt = data.createdAt instanceof Date
    ? data.createdAt
    : data.createdAt instanceof Timestamp ? data.createdAt.toDate() : null;
  const replyToName = data.replyToName;

  return {
    createdAt,
    displayName: typeof data.displayName === 'string' && data.displayName ? data.displayName : 'User',
    id,
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
      replyToName: comment.replyToName ?? null,
      text: comment.text,
      userId: comment.userId,
    });

    transaction.update(postRef, { commentsCount: count + 1 });
  });
}

export async function deleteComment(postId: string, commentId: string) {
  const db = getFirebaseDb();
  const postRef = doc(db, 'posts', postId);

  await runTransaction(db, async (transaction) => {
    const post = await transaction.get(postRef);
    const stored = post.exists() ? post.data().commentsCount : undefined;
    const count = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;

    transaction.delete(doc(collection(postRef, COMMENTS_COLLECTION), commentId));
    // Never below zero: a post whose counter drifted can come back up to a real number.
    transaction.update(postRef, { commentsCount: Math.max(0, count - 1) });
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
