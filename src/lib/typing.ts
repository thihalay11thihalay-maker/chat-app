import {
    collection,
    deleteDoc,
    doc,
    onSnapshot,
    setDoc,
} from 'firebase/firestore';

import { getFirebaseDb } from '@/lib/firebase';

/**
 * Who is currently typing in a conversation.
 *
 * Stored as `chats/{chatId}/typing/{uid}`, and Firestore rather than the Realtime Database it used to be on.
 * The move is a security fix, and the reason is the only thing the two databases differ on here.
 *
 * `inChat` in firestore.rules reads the room's own `participants` list, so a rule can say "you are in this
 * room" and mean it. Realtime Database rules cannot read Firestore at all, so the equivalent check there
 * was `auth != null` -- signed in is all. That is not a small gap: any account that learned a chat id could
 * read who was typing in it indefinitely and write its own entry into it, making members watch a "typing…"
 * indicator from somebody who is not in the conversation. The old comment here said that guessing a chat id
 * was impractical, which is a statement about the id being random rather than about the room being private,
 * and it stops being true the moment an id leaks -- through a shared link, a screenshot, an ex-member, or an
 * invite directory.
 *
 * What is lost, and what replaces it:
 *
 *   Realtime Database has `onDisconnect`, so a client that was killed mid-sentence could have its signal
 *   removed for it. Firestore has no equivalent.
 *
 *   It did not need it. The entry is a timestamp rather than a flag, and readers expire anything older than
 *   `TYPING_TTL_MS`, precisely because nobody can be trusted to clear their own entry. A client that dies
 *   simply stops refreshing, and its last write ages out on its own. That design is why this still works
 *   with the disconnect handler removed rather than needing a new one.
 *
 *   The push behaviour is the same: a subcollection listener fires on every write from anybody in the room,
 *   which is what a typing indicator is for.
 */

/** A signal older than this is treated as nobody typing. */
export const TYPING_TTL_MS = 5_000;

/** How often a continuing typist refreshes their entry. */
const TYPING_REFRESH_MS = 2_500;

/**
 * The one expiry clock shared by every typing subscription.
 *
 * Entries expire by age, so a subscription has to wake up periodically even when nothing has arrived.
 * One timer for all of them: the inbox subscribes per conversation, and a timer each would mean a wake-up
 * every couple of seconds per row for as long as the list is open.
 */
const sweepers = new Set<() => void>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Registers an expiry check, and returns the function that removes it again. */
function addTypingSweep(publish: () => void) {
  sweepers.add(publish);

  // Started lazily so an app that never subscribes never holds a timer, and stopped as soon as the
  // last subscriber goes away.
  sweepTimer ??= setInterval(() => {
    sweepers.forEach((sweep) => sweep());
  }, TYPING_TTL_MS / 2);

  return () => {
    sweepers.delete(publish);

    if (sweepers.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  };
}

/**
 * Announces that this account is typing, and keeps announcing until `stop`.
 *
 * Returns a function that clears the signal. Callers are expected to call it when the composer is
 * cleared or the screen goes away, so the other side is not left guessing after the message lands.
 *
 * If this account is not in the room the write is refused by the rules, which is the point: an outsider
 * cannot announce itself into a conversation. That is refused quietly rather than alerted on, because a
 * failure here is never the reader's problem to act on and a composer that throws mid-keystroke is worse
 * than one that does not show a typing indicator.
 */
export function startTyping(chatId: string, userId: string): () => void {
  if (!chatId || !userId) {
    return () => {};
  }

  const node = doc(getFirebaseDb(), 'chats', chatId, 'typing', userId);
  let stopped = false;

  const announce = () => {
    if (stopped) {
      return;
    }

    // Refreshed on a timer rather than on every keystroke: a write per character is a lot of traffic for
    // a signal that is only read as a boolean, and the timer is what keeps `at` inside the window.
    void setDoc(node, { at: Date.now() }).catch(() => {});
  };

  announce();

  const beat = setInterval(announce, TYPING_REFRESH_MS);

  return () => {
    stopped = true;
    clearInterval(beat);

    void deleteDoc(node).catch(() => {});
  };
}

/**
 * Subscribes to who is typing in a room, excluding `selfUid`.
 *
 * The signal expires by age rather than by being cleared, so the callback also runs on a timer: a
 * typist who closes the app without ever clearing their entry keeps the last value they wrote, and
 * nothing would arrive to say they had gone quiet.
 */
export function subscribeToTyping(
  chatId: string,
  selfUid: string | undefined,
  onChange: (typingUserIds: string[]) => void,
): () => void {
  if (!chatId) {
    onChange([]);

    return () => {};
  }

  // uid -> the freshest timestamp seen for it. Kept outside the listener so the expiry sweep and the
  // snapshot callback read the same record.
  const latest = new Map<string, number>();
  let lastReported = '';

  const publish = () => {
    const now = Date.now();
    const active: string[] = [];

    latest.forEach((at, uid) => {
      if (now - at < TYPING_TTL_MS && uid !== selfUid) {
        active.push(uid);
      }
    });

    // Sorted so the list is stable between snapshots. Without this two people typing at once would
    // swap places in the UI every time one of them refreshed.
    active.sort();

    // Reported only on a real change, so the caller is not re-rendered four times a second while
    // somebody sits and thinks.
    const key = active.join(',');

    if (key !== lastReported) {
      lastReported = key;
      onChange(active);
    }
  };

  const unsubscribe = onSnapshot(
    collection(getFirebaseDb(), 'chats', chatId, 'typing'),
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'removed') {
          latest.delete(change.doc.id);

          return;
        }

        const at = change.doc.data().at;

        if (typeof at === 'number') {
          latest.set(change.doc.id, at);
        }
      });

      publish();
    },
    (error) => {
      // A room this account is not in cannot read its typing signals, which is the rules working. The
      // inbox subscribes to rooms it has left as well as ones it is in, so this is expected rather than
      // broken, and it is not worth a warning per room.
      if (error.code !== 'permission-denied') {
        console.warn('Could not read typing indicators:', error.message);
      }

      onChange([]);
    },
  );

  // Half the lifetime, so an entry expires promptly without polling faster than necessary.
  //
  // Shared across every subscription in the app rather than one timer per room. The inbox watches
  // several conversations at once, and a timer each would wake the app every couple of seconds per
  // row for the whole time the list is open, which on a phone is a real cost for a signal that is
  // only read a few times a minute.
  const stopSweeping = addTypingSweep(publish);

  return () => {
    stopSweeping();
    unsubscribe();
  };
}