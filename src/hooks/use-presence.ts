import { onAuthStateChanged, type User } from 'firebase/auth';
import { onDisconnect, ref, remove, set } from 'firebase/database';
import { useEffect, useState } from 'react';

import { getFirebaseAuth, getFirebaseRealtimeDb } from '@/lib/firebase';

/**
 * How often this client's own presence node is refreshed.
 *
 * Comfortably under STALE_CONNECTION_MS in presence.ts, because a missed beat means the reader
 * starts calling this client offline within a couple of minutes. Three missed beats and the reader
 * corrects itself.
 */
const HEARTBEAT_MS = 30_000;

/**
 * An id for this one running client, so two connections from the same account are distinguishable
 * and one closing cannot mark the other offline.
 *
 * Random rather than a counter because nothing persists it between launches: the point is only that
 * a new session does not reuse a node that a previous one left behind, and it does not have to be
 * unguessable since the rules already restrict writes to the owner.
 */
function createConnectionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Reports this account as online for as long as it is signed in and the app is running.
 *
 * Mounted once, at the app root, because presence is a property of the session rather than of any
 * one screen. Writing it from the chat list alone would make the user look offline everywhere else,
 * and would flap every time the list was opened and closed.
 *
 * What it writes, and why each part is there:
 *
 *   online: true      what a reader looks at.
 *   lastSeen: <ms>    refreshed on a timer, so a node whose client was killed outright can still be
 *                     recognised as dead. `onDisconnect` cannot run in that case, so age is the only
 *                     thing left to go on.
 *   onDisconnect      removes the node when the connection drops normally: the app is closed, the
 *                     process dies cleanly, or the user signs out.
 *
 * Signing out is worth stating plainly: the auth token is already gone by the time a hook watching
 * auth state sees it, so the write that would clear presence is denied. The `onDisconnect` handler
 * is what covers that case, and Realtime Database does run it when authentication is revoked. If a
 * node ever does get orphaned, the heartbeat age check stops it from showing anybody as online.
 */
export function usePresenceReporter() {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    let unsubscribe = () => {};

    try {
      unsubscribe = onAuthStateChanged(getFirebaseAuth(), setUser);
    } catch (error) {
      // Firebase is not configured, or auth could not initialise. The user stays null and presence
      // is simply not reported, which costs the green dots and nothing else.
      console.error('Presence needs Firebase auth, which is unavailable:', error);
    }

    return unsubscribe;
  }, []);

  useEffect(() => {
    const db = getFirebaseRealtimeDb();

    if (!user || !db) {
      return undefined;
    }

    const presenceRef = ref(db, `status/${user.uid}/${createConnectionId()}`);

    const report = () => {
      // Fire and forget: a heartbeat that fails because the device dropped off is not worth a
      // dialog, and the reader treats the node as stale once it ages out anyway.
      void set(presenceRef, { lastSeen: Date.now(), online: true }).catch(() => {});
    };

    // Registered before the first write, so there is no window where the node exists without a way
    // to clean it up. `remove()` resolves once the server has acknowledged the registration; the
    // OnDisconnect handle itself is kept because cancelling a pending operation is a method on it,
    // not a value returned by remove().
    const onDisconnectRef = onDisconnect(presenceRef);

    void onDisconnectRef.remove();

    report();

    const beat = setInterval(report, HEARTBEAT_MS);

    return () => {
      clearInterval(beat);

      // The pending onDisconnect is cancelled first, otherwise leaving this effect (a fast refresh,
      // say) would leave the handler armed to delete the node a *new* connection owns.
      void onDisconnectRef.cancel();
      void remove(presenceRef).catch(() => {});
    };
  }, [user]);
}