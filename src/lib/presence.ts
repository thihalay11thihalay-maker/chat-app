import { onValue, ref } from 'firebase/database';

import { getFirebaseRealtimeDb } from '@/lib/firebase';

/**
 * Presence for a set of users, read from `status/{uid}`.
 *
 * The data is one node per client connection rather than a single flag per account:
 *
 *   status/{uid}/{connectionId} = { online: boolean, lastSeen: <epoch ms> }
 *
 * Per connection because a flat `status/{uid}` cannot answer the question honestly. One account on
 * a phone and a tablet is two connections, and whichever one closed last would decide whether that
 * person reads as online. With a node each, the account is online while any of its connections is.
 *
 * The rules in `database.rules.json` validate exactly this shape: `online` and `lastSeen` only, and
 * a node cannot be created without `online`. Validate rules do not run for deletions, so
 * `onDisconnect(...).remove()` is unaffected. That file has to be strict JSON with nothing but a
 * `rules` property at the top level; Firestore's rules and index files accept `"//"` keys and this
 * one does not.
 *
 * Read access is granted per `status/{uid}` node rather than at `status`, so the only readable thing
 * is the node asked for and reading `/status` outright is denied. That is why the subscription below
 * opens one listener per uid instead of one for the whole tree.
 */
export type PresenceMap = Record<string, boolean>;

/**
 * A heartbeat older than this is treated as offline even if its `online` is still true.
 *
 * `onDisconnect` cannot run when a device is killed outright, pulled from the charger, or loses
 * power, so a connection node can survive its client with `online: true` and nothing else would ever
 * correct it. The heartbeat in use-presence.ts refreshes `lastSeen` on a timer, which makes age a
 * usable second opinion: a node nobody is refreshing belongs to a client that is not running.
 *
 * Three beats, so a couple of missed timers on a loaded phone do not make somebody flicker offline,
 * but a hard kill is corrected within a couple of minutes instead of never.
 */
export const STALE_CONNECTION_MS = 90_000;

let hasWarnedAboutMissingDatabase = false;

/** A connection counts as online only if it says so and its heartbeat is recent enough. */
function isLiveConnection(value: unknown, now: number) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const connection = value as { lastSeen?: unknown; online?: unknown };

  if (connection.online !== true) {
    return false;
  }

  const lastSeen = typeof connection.lastSeen === 'number' ? connection.lastSeen : 0;

  // A node with no lastSeen is treated as live: the rules require online, and an old write from
  // before the heartbeat existed should still count rather than make the user permanently invisible.
  if (!lastSeen) {
    return true;
  }

  return now - lastSeen < STALE_CONNECTION_MS;
}

function readOnline(value: unknown, now: number) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  // Either shape is accepted: several connection nodes under the uid, or a flat node from a build
  // that wrote one flag per account. Both answer the same question, so both are read.
  const connections = Object.values(value as Record<string, unknown>);

  return connections.some((connection) => isLiveConnection(connection, now));
}

/**
 * Subscribes to the online state of several users at once.
 *
 * Returns an unsubscribe function, and is safe to call when Realtime Database is not configured, in
 * which case it reports an empty map and logs why once. Presence is decoration on a chat list, so a
 * missing database costs the dots rather than the conversations.
 */
export function subscribeToPresence(
  userIds: string[],
  onChange: (presence: PresenceMap) => void,
): () => void {
  const db = getFirebaseRealtimeDb();
  const unique = [...new Set(userIds)].filter(Boolean);

  if (!db || unique.length === 0) {
    if (!db && !hasWarnedAboutMissingDatabase) {
      hasWarnedAboutMissingDatabase = true;
      console.warn(
        'Presence is off: no Realtime Database url. Create one in the Firebase console, then set EXPO_PUBLIC_FIREBASE_DATABASE_URL and restart the dev server.',
      );
    }

    onChange({});

    // Still a function, so the caller's cleanup does not have to know which branch it took.
    return () => {};
  }

  const presence: PresenceMap = {};
  // How many of the listeners below have reported at least once.
  //
  // There is one listener per uid, and each delivers its current value as soon as it is attached,
  // so without this the caller would be handed a map holding only the first uid to answer. Every
  // other row would read as offline for as long as the slowest of those replies took, which on a
  // cold subscribe is the whole list flickering offline and then back. Nothing is published until
  // all of them have reported, so the first map the caller sees is already the real one.
  let pending = unique.length;
  // The map last handed to the caller, so `record` can tell whether publishing would change anything.
  let lastPublished: PresenceMap | null = null;

  const record = (userId: string, online: boolean) => {
    // Did this actually change anything? The heartbeat that keeps somebody marked online fires every 30s for
    // every listed user, and without this check each one rebuilt the map object and published it, so the
    // inbox re-rendered every row in the list several times a minute to change nothing. The caller's state
    // is compared by identity, so an unchanged map must also be the same object.
    const changed = presence[userId] !== online;

    presence[userId] = online;
    pending -= 1;

    if (pending > 0) {
      return;
    }

    // Not published at all when nothing moved. The caller keeps the previous object, which is the point:
    // identity equality is what stops the render, and handing back a copy of the same contents would defeat
    // it while looking identical in a test.
    if (changed || lastPublished === null) {
      lastPublished = { ...presence };
      onChange(lastPublished);
    }
  };

  const unsubscribes = unique.map((userId) =>
    onValue(
      ref(db, `status/${userId}`),
      (snapshot) => record(userId, readOnline(snapshot.val(), Date.now())),
      (error) => {
        // A rule that denies the read is a permanent answer for this path, not a blip. Treated as
        // offline so the list still renders rather than waiting for a reply that never comes.
        console.warn(`Could not read presence for ${userId}:`, error.message);
        record(userId, false);
      },
    ),
  );

  return () => {
    unsubscribes.forEach((unsubscribe) => unsubscribe());
  };
}