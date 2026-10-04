import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { useEffect, useState } from 'react';

import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';

/**
 * How many of this account's own posts are looked at. Enough to cover anything a person could
 * plausibly have posted before the audience feature existed, and bounded so this can never turn into
 * an unbounded read on launch.
 */
const BACKFILL_LIMIT = 100;

/**
 * Gives this account's older posts a `visibility`, once, on sign-in.
 *
 * Why it is needed at all: the feed used to have a fourth query for posts written before visibility
 * existed, matching them with `where('visibility', '==', null)`. Firestore refuses that query against
 * these rules, and no way of writing the read rule makes it acceptable — a null equality cannot prove
 * anything to the query validator, because it matches documents where the field is absent and the
 * rules language has no way to say "this field is not here". So the query only ever produced a
 * "Missing or insufficient permissions" error in the console and no posts.
 *
 * Writing the value is the way through, and the author is allowed to do it: the update rule grants
 * the author of a post any change to it. A write only happens for posts that actually need one.
 *
 * It runs once, not on every launch. There is no marker here yet, so every sign-in re-read the account's
 * newest 100 posts to find nothing to do -- "silent and free once migrated" was true of the writes and not
 * of the reads, which is 100 billed reads per app open forever. `visibilityBackfilledAt` on the profile is
 * that marker: one extra document read on a profile that is already loaded during sign-in, and it replaces
 * the scan.
 *
 * The marker is set when the scan finds nothing as well as when it finds something, because "there was
 * nothing to fix" is the normal outcome and is exactly the case worth not repeating.
 *
 * The other half of the problem is somebody else's older post: it stays out of the feed until its
 * author signs in once. Backfilling every post in one go needs the Admin SDK, which is what
 * scripts/backfill-visibility.js uses -- and which is also the only way to make the rules deploy safe, since
 * a client cannot write another account's posts. See the ordering at the top of firestore.rules.
 */
export function useVisibilityBackfill() {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    let unsubscribe = () => {};

    try {
      unsubscribe = onAuthStateChanged(getFirebaseAuth(), setUser);
    } catch (error) {
      console.error('The post backfill needs Firebase auth, which is unavailable:', error);
    }

    return unsubscribe;
  }, []);

  const userId = user?.uid;

  useEffect(() => {
    if (!userId) {
      return undefined;
    }

    let isCancelled = false;

    void (async () => {
      try {
        // The profile, for the marker. This is one document and the sign-in path reads it anyway, so it is
        // close to free -- and it is what makes this a one-time cost instead of a per-launch one.
        const profileRef = doc(getFirebaseDb(), 'users', userId);
        const profileSnapshot = await getDoc(profileRef);

        if (isCancelled) {
          return;
        }

        const profile = profileSnapshot.data() as { visibilityBackfilledAt?: unknown } | undefined;

        if (profile?.visibilityBackfilledAt) {
          return;
        }

        // The account's own posts, which is the one posts query these rules will let through without
        // a visibility filter: it satisfies the "author" clause of the read rule on its own.
        const snapshot = await getDocs(query(
          collection(getFirebaseDb(), 'posts'),
          where('userId', '==', userId),
          limit(BACKFILL_LIMIT),
        ));

        const legacy = snapshot.docs.filter((postDocument) => !('visibility' in postDocument.data()));

        if (isCancelled) {
          return;
        }

        if (legacy.length > 0) {
          await Promise.all(legacy.map((postDocument) => updateDoc(postDocument.ref, {
            visibility: 'public',
          })));

          console.log(`Gave ${legacy.length} older post(s) a visibility, so they can appear in the feed.`);
        }

        // Set either way. A profile with nothing to fix is the common case and is the one worth not
        // rescanning, so recording only on a change would have left the per-launch cost in place for
        // exactly the accounts that were already migrated.
        await updateDoc(profileRef, { visibilityBackfilledAt: serverTimestamp() });
      } catch (error) {
        // Deliberately quiet. A failed backfill costs an old post its place in the feed for its
        // author, which is not worth an error on every launch, and the feed itself is unaffected.
        console.warn('Could not give this account\'s older posts a visibility:', error);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [userId]);
}
