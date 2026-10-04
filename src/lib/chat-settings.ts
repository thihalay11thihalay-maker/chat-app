import { deleteDoc, doc, getDoc, setDoc } from 'firebase/firestore';

import { getFirebaseDb } from './firebase';
import { UserData } from './user-data';

/**
 * One account's own settings for one room: whether it is muted, what it should sound like, and how long
 * its messages should live.
 *
 * These live under the account rather than on the room, and that is the whole design. A room document is
 * shared by every person in it, so a mute written there would mute the room for all of them, and one
 * person's timer would delete everybody's messages. There is nothing per-user about a room's name or its
 * members; there is a great deal per-user about how you want to be spoken to.
 *
 * firestore.rules keeps this collection to its own owner, so the room's rules are not widened by any of
 * it: a member can write here and nowhere else on somebody else's behalf.
 */

/** The sounds a room can be announced with. `default` is the system tone, `none` is silence. */
export type NotificationSound = 'default' | 'none' | 'chime' | 'pop' | 'ping';

export const NOTIFICATION_SOUNDS: { label: string; value: NotificationSound }[] = [
  { label: 'Default', value: 'default' },
  { label: 'Chime', value: 'chime' },
  { label: 'Pop', value: 'pop' },
  { label: 'Ping', value: 'ping' },
  { label: 'None', value: 'none' },
];

/**
 * How long a message in this room survives, in seconds. Zero is off.
 *
 * Off by default rather than a timer: a timer that deletes what somebody wrote because they were in the
 * wrong room is not something to switch on for people behind their back.
 */
export const DISAPPEARING_OPTIONS: { label: string; seconds: number }[] = [
  { label: 'Off', seconds: 0 },
  { label: '1 minute', seconds: 60 },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '1 day', seconds: 24 * 60 * 60 },
  { label: '1 week', seconds: 7 * 24 * 60 * 60 },
];

export type ChatSettings = {
  /** When the timer is longer than a minute, the hour and day figures are worth showing a sample of. */
  disappearingAfterSeconds: number;
  muted: boolean;
  notificationSound: NotificationSound;
};

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  disappearingAfterSeconds: 0,
  muted: false,
  notificationSound: 'default',
};

/** Settings as they are read from a document, falling back to the defaults field by field. */
export function readChatSettings(data: UserData): ChatSettings {
  const sound = data.notificationSound;

  return {
    disappearingAfterSeconds: typeof data.disappearingAfterSeconds === 'number'
      && data.disappearingAfterSeconds >= 0
      ? data.disappearingAfterSeconds
      : DEFAULT_CHAT_SETTINGS.disappearingAfterSeconds,
    muted: data.muted === true,
    notificationSound: sound === 'none' || sound === 'chime' || sound === 'pop' || sound === 'ping'
      ? sound
      : DEFAULT_CHAT_SETTINGS.notificationSound,
  };
}

function settingsRef(chatId: string, uid: string) {
  return doc(getFirebaseDb(), 'users', uid, 'chatSettings', chatId);
}

/**
 * Reads one room's settings for this account, or the defaults when there are none.
 *
 * A room with no settings document is not an error and not a reason to write one: the defaults already
 * say what an absent document means, so a room that was never touched costs nothing to open.
 */
export async function loadChatSettings(chatId: string, uid: string): Promise<ChatSettings> {
  if (!chatId || !uid) {
    return DEFAULT_CHAT_SETTINGS;
  }

  try {
    const snapshot = await getDoc(settingsRef(chatId, uid));

    return snapshot.exists() ? readChatSettings(snapshot.data()) : DEFAULT_CHAT_SETTINGS;
  } catch (error) {
    // A room the account is no longer in, or a rules change in flight. The defaults are the right answer
    // either way: unmuted, with the system tone, and nothing that deletes.
    console.warn('Could not read the room settings:', error);
    return DEFAULT_CHAT_SETTINGS;
  }
}

/** Writes this account's settings for a room, leaving the fields this call does not mention alone. */
export async function saveChatSettings(chatId: string, uid: string, settings: Partial<ChatSettings>) {
  if (!chatId || !uid) {
    return;
  }

  const update: Record<string, string | number | boolean> = {};

  if (typeof settings.muted === 'boolean') {
    update.muted = settings.muted;
  }

  if (typeof settings.notificationSound === 'string') {
    update.notificationSound = settings.notificationSound;
  }

  if (typeof settings.disappearingAfterSeconds === 'number' && settings.disappearingAfterSeconds >= 0) {
    update.disappearingAfterSeconds = settings.disappearingAfterSeconds;
  }

  if (Object.keys(update).length === 0) {
    return;
  }

  await setDoc(settingsRef(chatId, uid), update, { merge: true });
}

/**
 * Forgets a room's settings, which is what leaving does.
 *
 * Not required for correctness, since an absent document already means the defaults, but it keeps the
 * account's collection from holding a mute for a room that has been left and a timer for a room that
 * has been deleted. Without it, re-joining later silently restores a setting nobody remembers choosing.
 *
 * Called from `leaveRoom` in chat-rooms.ts. Failures are swallowed on purpose: this is tidying, and being
 * unable to tidy must not stop somebody leaving.
 */
export async function forgetChatSettings(chatId: string, uid: string) {
  try {
    await deleteDoc(settingsRef(chatId, uid));
  } catch (error) {
    console.warn('Could not clear the room settings:', error);
  }
}

/** A human label for a timer, for the settings screen and the composer placeholder. */
export function describeDisappearing(seconds: number) {
  return DISAPPEARING_OPTIONS.find((option) => option.seconds === seconds)?.label ?? 'Off';
}