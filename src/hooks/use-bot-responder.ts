import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { useEffect, useState } from 'react';

import {
  botTypingDelay,
  isBotProfile,
  pickBotReply,
  sendBotMessage,
} from '@/lib/bot';
import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';
import { startTyping } from '@/lib/typing';

/**
 * How many answered message ids are remembered.
 *
 * The bot only acts on the newest message in each room, so the same one is delivered repeatedly as
 * the listener redelivers it. A short memory is enough to know it has been answered, and is kept
 * short on purpose: this runs for as long as the app is open, and an unbounded set would grow for
 * the whole session for nothing.
 */
const ANSWER_MEMORY = 40;

/** One room being watched, and everything that has to be undone when it stops being watched. */
type RoomSession = {
  /** Ends the message listener and abandons anything still pending for this room. */
  cancel: () => void;
};

/**
 * Answers incoming messages, but only when this account is the bot.
 *
 * Mounted once at the app root, beside the presence reporter, because a bot that only replied while
 * a conversation was on screen would not test the thing that matters: whether a message sent from
 * another device arrives and is answered while this one is somewhere else entirely.
 *
 * Per conversation:
 *
 *   1. Watch the newest message.
 *   2. When it is from somebody else and has not been answered, announce typing.
 *   3. Wait about as long as typing that many characters would take.
 *   4. Stop typing and send the reply.
 *
 * One message listener per room rather than one for everything, because the rules scope a message
 * read to the rooms the caller is in and Firestore cannot join across them. A room joining or leaving
 * the list adds or cancels exactly one session, so a chat that is deleted stops being watched rather
 * than leaving a listener reading a document nobody can reach any more.
 */
export function useBotResponder() {
  const [user, setUser] = useState<User | null>(null);
  // Whether this profile is the bot. Held as state because it is the difference between two
  // subscriptions running and none, and it is never guessed.
  const [isBot, setIsBot] = useState(false);

  useEffect(() => {
    let unsubscribe = () => {};

    try {
      unsubscribe = onAuthStateChanged(getFirebaseAuth(), setUser);
    } catch (error) {
      console.error('The bot needs Firebase auth, which is unavailable:', error);
    }

    return unsubscribe;
  }, []);

  const userId = user?.uid;

  // The flag lives on the profile rather than on the account, read the same way the app reads every
  // other profile field. A profile that cannot be read leaves the bot off: answering as somebody who
  // was never asked to is worse than staying quiet.
  useEffect(() => {
    if (!userId) {
      return undefined;
    }

    let isCancelled = false;

    void (async () => {
      try {
        const snapshot = await getDoc(doc(getFirebaseDb(), 'users', userId));

        if (!isCancelled) {
          setIsBot(isBotProfile(snapshot.exists() ? snapshot.data() : null));
        }
      } catch (error) {
        console.error('Could not read the profile to find out whether this is the bot:', error);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    if (!userId || !isBot) {
      return undefined;
    }

    const uid = userId;
    // Per run, so signing out and back in does not answer a message twice.
    const answered = new Set<string>();
    const sessions = new Map<string, RoomSession>();
    // How many replies each room has sent, so the wording rotates within a conversation and two
    // conversations do not push each other onto a different answer.
    const replyCounts = new Map<string, number>();

    const remember = (messageId: string) => {
      answered.add(messageId);

      // A fixed length: the oldest id is the least likely to be delivered again, and this runs for as
      // long as the app is open.
      if (answered.size > ANSWER_MEMORY) {
        const oldest = answered.values().next().value;

        if (typeof oldest === 'string') {
          answered.delete(oldest);
        }
      }
    };

    const watchRoom = (chatId: string): RoomSession => {
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const typingStops = new Set<() => void>();
      let replyCount = replyCounts.get(chatId) ?? 0;

      const latestQuery = query(
        collection(getFirebaseDb(), 'chats', chatId, 'messages'),
        orderBy('createdAt', 'desc'),
        limit(1),
      );

      const unsubscribe = onSnapshot(latestQuery, (snapshot) => {
        // The id is on the document, not on its data, and it is what stops a message being answered
        // twice: the same newest message is redelivered every time the listener wakes.
        const newest = snapshot.docs[0];
        const latest = newest?.data() as { senderId?: unknown; text?: unknown } | undefined;

        // Only the newest message, only from somebody else, and only once.
        if (!newest || !latest || typeof latest.senderId !== 'string') {
          return;
        }

        if (latest.senderId === uid || answered.has(newest.id)) {
          return;
        }

        const text = typeof latest.text === 'string' ? latest.text : '';

        remember(newest.id);

        // Typing first, because the wait is the part a tester has to be watching for. Held in the
        // session so cancelling the room stops the signal too, rather than leaving the other side
        // told somebody is typing until the entry ages out.
        const stopTyping = startTyping(chatId, uid);
        typingStops.add(stopTyping);

        const timer = setTimeout(() => {
          timers.delete(timer);
          typingStops.delete(stopTyping);
          stopTyping();
          replyCounts.set(chatId, (replyCount += 1));
          void sendBotMessage(chatId, uid, pickBotReply(text, replyCount));
        }, botTypingDelay(text));

        timers.add(timer);
      }, (error) => {
        console.warn(`The bot could not watch ${chatId}:`, error.message);
      });

      return {
        cancel: () => {
          unsubscribe();
          timers.forEach((timer) => clearTimeout(timer));
          timers.clear();
          typingStops.forEach((stop) => stop());
          typingStops.clear();
        },
      };
    };

    // The rooms this account is in. The same query the inbox makes, and it needs the same composite
    // index: an array-contains filter ordered by another field cannot be served by a single-field
    // one.
    const roomsQuery = query(
      collection(getFirebaseDb(), 'chats'),
      where('participants', 'array-contains', uid),
      orderBy('lastMessageTime', 'desc'),
    );

    const stopRooms = onSnapshot(roomsQuery, (snapshot) => {
      const liveIds = new Set(snapshot.docs.map((roomDocument) => roomDocument.id));

      liveIds.forEach((chatId) => {
        if (!sessions.has(chatId)) {
          sessions.set(chatId, watchRoom(chatId));
        }
      });

      sessions.forEach((session, chatId) => {
        if (!liveIds.has(chatId)) {
          session.cancel();
          sessions.delete(chatId);
          replyCounts.delete(chatId);
        }
      });
    }, (error) => {
      console.warn('The bot could not list its conversations:', error.message);
    });

    return () => {
      stopRooms();
      sessions.forEach((session) => session.cancel());
      sessions.clear();
      replyCounts.clear();
    };
  }, [isBot, userId]);
}
