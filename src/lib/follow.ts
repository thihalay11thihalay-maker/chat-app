import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';

import { getFirebaseDb, isFirestorePermissionError } from '@/lib/firebase';

/**
 * Who this account follows.
 *
 * Two documents per relationship, one under each side. `users/{me}/following/{them}` is the one that
 * decides things -- a restricted post snapshots the author's list as its audience when it is
 * published -- and `users/{them}/followers/{me}` is the mirror of it, kept so that somebody's
 * profile can be asked how many people follow them.
 *
 * The mirror is what makes a follower count possible at all. The rules can only let an account read
 * its own follow list, so who *follows* a person would otherwise need a collection-group query across
 * every account in the app, which is denied and is also not a thing a client should be able to do.
 * The mirror is written by the follower rather than by the person being followed, which is why it is
 * worth having: the rules check that the writer really does follow this account before the write is
 * allowed, so nobody can put themselves in a stranger's follower list or inflate a count.
 *
 * The two writes are not one transaction, because a client cannot write into a transaction spanning a
 * document it only owns by proxy -- and because losing the count is a much smaller failure than
 * losing the follow. The follow is written first: if the mirror fails, the relationship is real and
 * only the number is behind, and the mirror is repaired the next time somebody presses the button
 * again.
 */

// Follow state is a plain per-account document, so it is fetched once and shared instead of being
// re-read every time a row remounts. Shared by the feed and the profile for the same reason: both are
// asking "does this account follow that one", and two caches would answer differently for a moment
// after a press.
const followCache = new Map<string, boolean>();
const pendingFollows = new Map<string, Promise<boolean>>();

// Set once the rules reject the follow documents; retrying can only fail again.
let followIsDenied = false;

/** Whether `viewerId` follows `authorId`, cached, and never a second read for the same pair. */
export function readFollow(viewerId: string, authorId: string): Promise<boolean> {
  if (followIsDenied || !viewerId || !authorId) {
    return Promise.resolve(false);
  }

  const cacheId = `${viewerId}|${authorId}`;
  const cached = followCache.get(cacheId);

  if (cached !== undefined) {
    return Promise.resolve(cached);
  }

  const inFlight = pendingFollows.get(cacheId);

  if (inFlight) {
    return inFlight;
  }

  const read = (async () => {
    try {
      const snapshot = await getDoc(doc(
        getFirebaseDb(),
        'users',
        viewerId,
        'following',
        authorId,
      ));
      const exists = snapshot.exists();

      followCache.set(cacheId, exists);
      return exists;
    } catch (error) {
      if (isFirestorePermissionError(error)) {
        followIsDenied = true;
        console.warn(
          'Follow state is not readable with the deployed Firestore rules. '
          + 'Allow users/{uid}/following, then redeploy firestore.rules.',
        );
        return false;
      }

      console.error('Could not load follow state:', error);
      return false;
    } finally {
      pendingFollows.delete(cacheId);
    }
  })();

  pendingFollows.set(cacheId, read);
  return read;
}

/**
 * Follows or unfollows an account, and keeps the follower count on the other side in step.
 *
 * Throws when the follow itself could not be written, because a button that reports success it did
 * not achieve is worse than one that reports failure. The mirror write is allowed to fail quietly:
 * see the note at the top of this file for why the count is the expendable half.
 */
export async function setFollowing(viewerId: string, targetId: string, follow: boolean) {
  if (!viewerId || !targetId || viewerId === targetId) {
    return;
  }

  const db = getFirebaseDb();
  const followRef = doc(db, 'users', viewerId, 'following', targetId);
  const followerRef = doc(db, 'users', targetId, 'followers', viewerId);

  if (follow) {
    await setDoc(followRef, { createdAt: serverTimestamp(), userId: targetId });
  } else {
    await deleteDoc(followRef);
  }

  followCache.set(`${viewerId}|${targetId}`, follow);
  pendingFollows.delete(`${viewerId}|${targetId}`);

  try {
    if (follow) {
      await setDoc(followerRef, { createdAt: serverTimestamp(), userId: viewerId });
    } else {
      await deleteDoc(followerRef);
    }
  } catch (error) {
    if (isFirestorePermissionError(error)) {
      console.warn(
        'The follower count could not be kept in step. Allow users/{uid}/followers, then redeploy firestore.rules.',
      );
      return;
    }

    console.warn('Could not update the follower count:', error);
  }
}

/** The accounts this one follows, which is the same list the inbox's Following filter uses. */
export async function loadFollowIds(viewerId: string): Promise<Set<string>> {
  if (!viewerId) {
    return new Set();
  }

  try {
    const snapshot = await getDocs(collection(getFirebaseDb(), 'users', viewerId, 'following'));
    return new Set(snapshot.docs.map((followDocument) => followDocument.id));
  } catch (error) {
    if (isFirestorePermissionError(error)) {
      console.warn(
        'The follow list is not readable with the deployed Firestore rules. '
        + 'Allow users/{uid}/following, then redeploy firestore.rules.',
      );
      return new Set();
    }

    console.error('Could not load the follow list:', error);
    return new Set();
  }
}

/**
 * How many accounts follow this one.
 *
 * Zero rather than null when the count is unreadable, because a profile that says "0 followers" when
 * the truth is unknown is a claim the screen cannot support. The caller therefore gets `null` for
 * "cannot tell" and only a number when the rules allowed the read, and says nothing at all in the
 * first case.
 */
export async function countFollowers(uid: string): Promise<number | null> {
  try {
    const snapshot = await getDocs(collection(getFirebaseDb(), 'users', uid, 'followers'));
    return snapshot.size;
  } catch (error) {
    if (isFirestorePermissionError(error)) {
      console.warn(
        `Follower counts are not readable with the deployed Firestore rules. `
        + `Allow users/{uid}/followers, then redeploy firestore.rules. (${uid})`,
      );
      return null;
    }

    console.error('Could not count followers:', error);
    return null;
  }
}

/**
 * How many accounts this one follows.
 *
 * Null rather than a number for anybody but the account itself, and not because the count is
 * expensive: the rules only let an account read its own follow list, so this is the honest answer to
 * "how many does she follow" on somebody else's profile. It is a real gap in what a profile can say
 * about another person, and closing it would mean letting every account read every other account's
 * follow list.
 */
export async function countFollowing(uid: string, viewerId: string): Promise<number | null> {
  if (uid !== viewerId) {
    return null;
  }

  try {
    const snapshot = await getDocs(collection(getFirebaseDb(), 'users', uid, 'following'));
    return snapshot.size;
  } catch (error) {
    if (isFirestorePermissionError(error)) {
      console.warn(
        'The follow list is not readable with the deployed Firestore rules. '
        + 'Allow users/{uid}/following, then redeploy firestore.rules.',
      );
      return null;
    }

    console.error('Could not count what this account follows:', error);
    return null;
  }
}

/** Both counts for a profile, read together and never awaited one after the other. */
export async function loadFollowCounts(uid: string, viewerId: string) {
  const [followers, following] = await Promise.all([
    countFollowers(uid),
    countFollowing(uid, viewerId),
  ]);

  return { followers, following };
}
