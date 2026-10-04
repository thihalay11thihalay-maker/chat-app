import {
  addDoc,
  collection,
  doc,
  getDoc,
  increment,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';

import botReplies from '@/lib/bot-replies.json';
import { getFirebaseDb } from '@/lib/firebase';

/**
 * The test bot: a scripted conversation partner, for exercising chat without a second person.
 *
 * The bot is not mock data. It is a real Firebase account with `isBot: true` on its profile, seeded
 * by scripts/seed-bot.js, and it does everything a person does: it signs in, keeps its presence
 * alive, sends messages the security rules accept, and moves the unread badges. Nothing here is
 * allowed past the rules, so a test that passes here is a test of the app rather than of a shortcut.
 *
 * What it deliberately does not do: nothing server side. The replies are driven by the app running
 * on the bot's own device, so the bot only answers while that device is open and signed in.
 * scripts/bot-online.js is the other way to run the same bot -- signed in from a terminal, keeping its
 * own presence alive and answering from there -- for testing from your own account without a second
 * device. A real deployment would move this to a Cloud Function; the shape of the answers, and the
 * table they come from, would stay the same.
 *
 * Turn it off by clearing `isBot` on the profile, or by signing in as somebody else. There is no
 * switch in the UI: a switch that could be left on in a shipped build is a way to ship a bot that
 * replies to real people's messages.
 */

/** The profile flag the bot is switched on by. */
export const BOT_PROFILE_FLAG = 'isBot';

/** Whether a profile document describes the bot. Anything but a literal true is not the bot. */
export function isBotProfile(data: unknown) {
  return Boolean(
    data
    && typeof data === 'object'
    && (data as Record<string, unknown>)[BOT_PROFILE_FLAG] === true,
  );
}

/**
 * What the bot says back.
 *
 * Matched by keyword rather than randomly, so a tester can steer it: send something with a question
 * mark and it answers as a question, send a name and it acknowledges the name. Each rule's answers
 * are rotated through by `index`, so a run of messages produces a run of different replies rather
 * than the same line over and over, which is what makes it obvious whether the list is really
 * updating.
 *
 * The lengths are deliberate too. One short line, one longer paragraph with a question, and one with
 * an emoji: those between them cover a single-line preview in the inbox, text wrapping in a bubble,
 * and a glyph that could be missing from a font.
 *
 * The table itself lives in bot-replies.json rather than here, because scripts/bot-online.js answers
 * from the same one. Two copies of a canned conversation is two copies to keep in step, and a tester
 * answered differently depending on how the bot happened to be running cannot tell which one they are
 * looking at.
 */
const REPLY_RULES: { replies: string[]; test: RegExp }[] = botReplies.rules.map((rule) => ({
  replies: rule.replies,
  // Every pattern is written to be read case-insensitively, which is what the app's own text matching
  // did, and why the Latin rules cannot match Burmese: word boundaries are not a feature of that
  // script, which is why the Burmese greeting rule is its own rule rather than a term in one of these.
  test: new RegExp(rule.test, 'i'),
}));

const FALLBACK_REPLIES = botReplies.fallback;

/**
 * Picks the answer to a message.
 *
 * `index` is how many replies this conversation has already sent, which is what rotates the wording.
 * The text is echoed back nowhere on purpose: an echo would make it look like the bot understood
 * something, and a tester reading it would draw the wrong conclusion about what is being tested.
 */
export function pickBotReply(text: string, index: number) {
  const rule = REPLY_RULES.find((candidate) => candidate.test.test(text));
  const replies = rule ? rule.replies : FALLBACK_REPLIES;

  return replies[index % replies.length];
}

/**
 * Sends one message and puts the room document back in step with it.
 *
 * Both halves matter: the message alone would leave the inbox preview and the unread badge stuck on
 * whatever was said before, which is the same class of bug the room preview was introduced to fix.
 * Participants are read rather than passed in, because a group has no single "other" to increment.
 *
 * Every failure is logged rather than thrown. A bot that throws on every reply would fill the
 * console and, worse, look broken in a way that hides whatever is really being tested.
 */
export async function sendBotMessage(chatId: string, senderId: string, text: string) {
  try {
    await addDoc(collection(getFirebaseDb(), 'chats', chatId, 'messages'), {
      createdAt: serverTimestamp(),
      senderId,
      text,
      type: 'text',
    });

    // Best effort, and a failure here must not undo the message that was already delivered.
    try {
      const room = await getDoc(doc(getFirebaseDb(), 'chats', chatId));
      const participants = room.exists() ? room.data()?.participants : undefined;
      const update: Record<string, unknown> = {
        lastMessage: text.slice(0, 120),
        lastMessageSenderId: senderId,
        lastMessageTime: serverTimestamp(),
      };

      if (Array.isArray(participants)) {
        participants.forEach((participant) => {
          if (typeof participant === 'string' && participant !== senderId) {
            update[`unreadCounts.${participant}`] = increment(1);
          }
        });
      }

      await updateDoc(doc(getFirebaseDb(), 'chats', chatId), update);
    } catch (error) {
      console.warn('The bot sent a message but could not update the room preview:', error);
    }
  } catch (error) {
    console.warn('The bot could not send a message:', error);
  }
}

/**
 * How long the bot pretends to type before answering.
 *
 * Derived from the length of what it was sent, because a reply that appears instantly makes the
 * typing signal impossible to see: it is the only part of this that a person has to be looking at
 * the screen for. Bounded at both ends so a one-word message still takes long enough to notice and
 * a long one does not hold the reply for several seconds.
 */
export function botTypingDelay(text: string) {
  return 900 + Math.min(text.trim().length * 40, 2_000);
}
