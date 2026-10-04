import {
  addDoc,
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';

import { getFirebaseAuth, getFirebaseDb } from './firebase';
import { readPerson, recordMessagePreview } from './chat-rooms';

/**
 * Everything one chat message can be.
 *
 * `type` is the discriminator and the rest is optional, which is what lets one collection hold a text
 * message, a picture, a voice note, a file, a place and a contact card without a schema migration for
 * each. A reader that does not know a type shows the file name rather than nothing, because a message
 * this build cannot draw is still a message somebody sent.
 *
 * Two fields are copies of other documents on purpose. `senderName` would otherwise need a profile read
 * per message, which for a screen full of them is a screen full of reads; `replyTo` would need the same
 * read for the message being replied to, and that message may since have been deleted. A copy that is
 * briefly out of date is much cheaper than a read per bubble, and it is the same trade the comments
 * subcollection already makes with `displayName`.
 */
export type ChatMessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'location'
  | 'contact'
  | 'album';

/**
 * One photograph or one clip inside an album.
 *
 * Enough to draw the tile and to save it, and no more: the bubble needs to know whether this is a picture
 * or a clip to put a play badge on it, the viewer needs the length to show, and the gallery needs a name and
 * a size. The bytes are already at `mediaUrl`.
 */
export type AlbumItem = {
  /** How long a clip runs, in seconds, when the picker's device knew. Absent on a photograph. */
  durationSeconds?: number;
  fileName?: string;
  fileSize?: number;
  mediaUrl: string;
  /** Which of the two this is, rather than guessed from the extension: a signed url's query string can. */
  type: 'image' | 'video';
};

/** How many items one album may hold. Sent as one document, so this is also how long that write waits. */
export const MAX_ALBUM_ITEMS = 10;

/**
 * A message as the screen draws it: the stored fields, plus the two the interface needs that Firestore
 * does not keep -- the document id, and the moment as a value rather than a Timestamp to be unwrapped at
 * every call site.
 */
export type ChatMessage = {
  id: string;
  senderId: string;
  senderName?: string;
  type: ChatMessageType;
  text?: string;
  mediaUrl?: string;
  fileName?: string;
  fileSize?: number;
  latitude?: number;
  longitude?: number;
  locationName?: string;
  contactName?: string;
  contactPhone?: string;
  contactPhotoUrl?: string;
  /**
   * Every photo and clip in this message, when it is an album.
   *
   * The whole album on one message rather than one document per photograph. The two reasons it used to be
   * one document each were both about the reader rather than the data: the group could be drawn from the
   * documents either side of this one, and the count could be read off them. Both broke the moment the
   * conversation was paginated, or the moment another person's message landed between two of the photos,
   * and a broken album is worse than an ugly one -- a half-sent album of ten leaves nine photographs in the
   * room that the sender never meant to send and cannot take back as a group.
   *
   * These three older fields are still read, because albums sent before this change are still in the rooms
   * they were sent in and there is nothing to migrate them out of.
   */
  albumItems?: AlbumItem[];
  albumId?: string;
  albumIndex?: number;
  albumCount?: number;
  /** How long a video runs, in seconds, when the sender's device knew. Drawn on the video's poster. */
  durationSeconds?: number;
  /** What the message answered, copied onto it so the quote does not need the original to still exist. */
  replyTo?: ReplyPreview | null;
  /** The room it was forwarded from, so a reader can tell it did not originate in this one. */
  forwardedFrom?: ForwardOrigin | null;
  pinned?: boolean;
  editedAt?: unknown;
  expiresAt?: unknown;
  createdAt?: unknown;
};

/** What a reply shows above the text: who said it, and the first line of what they said. */
export type ReplyPreview = {
  id: string;
  senderName: string;
  text: string;
};

/** Where a forwarded message came from, so the reader can see it did not originate here. */
export type ForwardOrigin = {
  roomId: string;
  roomName: string;
};

export type ChatMessageRecord = {
  senderId: string;
  senderName: string;
  type: ChatMessageType;
  text?: string;
  mediaUrl?: string;
  fileName?: string;
  fileSize?: number;
  /** A place, as coordinates and whatever the device could name it. */
  latitude?: number;
  longitude?: number;
  locationName?: string;
  /** A contact card: enough to show and to dial, and no more than the picker handed over. */
  contactName?: string;
  contactPhone?: string;
  contactPhotoUrl?: string;
  /** Every photo and clip in an album, on the one message that carries them. Absent on anything else. */
  albumItems?: AlbumItem[];
  /** How an album used to be written, one document per photograph. Still read, still in old rooms. */
  albumId?: string;
  albumIndex?: number;
  albumCount?: number;
  /** How long a video or voice message runs, in seconds, when it was known at sending time. */
  durationSeconds?: number;
  replyTo?: ReplyPreview | null;
  forwardedFrom?: ForwardOrigin | null;
  pinned?: boolean;
  editedAt?: unknown;
  expiresAt?: unknown;
  createdAt?: unknown;
};

/** The line shown for a message this build cannot draw, per type. */
export function describeMessage(record: {
  albumItems?: AlbumItem[];
  fileName?: string;
  locationName?: string;
  contactName?: string;
  type: ChatMessageType;
}) {
  switch (record.type) {
    case 'file':
      return record.fileName || 'File';
    case 'audio':
      return record.fileName || 'Voice message';
    case 'video':
      return record.fileName || 'Video';
    case 'location':
      return record.locationName || 'Location';
    case 'contact':
      return record.contactName || 'Contact';
    case 'album':
      return describeAlbum(record.albumItems);
    default:
      return 'Message';
  }
}

/**
 * What an album is called in one line, which depends on what is in it rather than on how much.
 *
 * A room full of photographs and a room full of clips are told apart by the noun, and a mixed album is
 * named for the photographs it contains because that is what a reader looks for first.
 */
function describeAlbum(items?: AlbumItem[]) {
  const count = items?.length ?? 0;

  if (count === 0) {
    return 'Album';
  }

  const clips = items?.filter((item) => item.type === 'video').length ?? 0;

  if (clips === 0) {
    return `${count} ${count === 1 ? 'photo' : 'photos'}`;
  }

  if (clips === count) {
    return `${count} ${count === 1 ? 'video' : 'videos'}`;
  }

  return `Album of ${count}`;
}

/** What a message looks like in one line, for a reply quote and for the room's last-message preview. */
export function summarizeMessage(record: {
  albumItems?: AlbumItem[];
  fileName?: string;
  locationName?: string;
  contactName?: string;
  text?: string;
  type: ChatMessageType;
}) {
  if (record.type === 'text') {
    return (record.text ?? '').trim();
  }

  if (record.type === 'album') {
    return `🖼️ ${describeAlbum(record.albumItems)}`;
  }

  if (record.type === 'location') {
    return record.locationName ? `📍 ${record.locationName}` : '📍 Location';
  }

  if (record.type === 'contact') {
    return record.contactName ? `👤 ${record.contactName}` : '👤 Contact';
  }

  if (record.type === 'image') {
    return '🖼️ Photo';
  }

  return describeMessage(record);
}

function messagesRef(chatId: string) {
  return collection(getFirebaseDb(), 'chats', chatId, 'messages');
}

async function currentSenderName(uid: string, fallback: string) {
  try {
    const snapshot = await getDoc(doc(getFirebaseDb(), 'users', uid));

    if (!snapshot.exists()) {
      return fallback;
    }

    return readPerson(snapshot.data(), fallback).name || fallback;
  } catch {
    // A profile that cannot be read is not a reason to refuse to send a message. The name is copied onto
    // the message for the group's benefit only; the rules identify the sender by id, not by this string.
    return fallback;
  }
}

export type SendTextInput = {
  chatId: string;
  expiresInSeconds?: number;
  forwardedFrom?: ForwardOrigin | null;
  replyTo?: ReplyPreview | null;
  text: string;
};

/**
 * Sends a text message, copying the sender's name onto it.
 *
 * The name is one read per message rather than one per screen, because the alternative is a read for
 * every bubble in the room, and it is cached for the rest of the session by the caller: `senderName` is
 * written for new messages only, and the room screen resolves the rest from the participant profiles it
 * already has.
 */
export async function sendTextMessage(input: SendTextInput) {
  const currentUser = getFirebaseAuth().currentUser;

  if (!currentUser) {
    throw new Error('Sign in to send a message.');
  }

  const text = input.text.trim();

  if (text === '') {
    return '';
  }

  const senderName = await currentSenderName(currentUser.uid, currentUser.displayName || 'Someone');

  const record: ChatMessageRecord = {
    createdAt: serverTimestamp(),
    ...expiryField(input.expiresInSeconds),
    forwardedFrom: input.forwardedFrom ?? null,
    replyTo: input.replyTo ?? null,
    senderId: currentUser.uid,
    senderName,
    text,
    type: 'text',
  };

const written = await addDoc(messagesRef(input.chatId), record);

    return written.id;
}

export type SendContactInput = {
  chatId: string;
  contactName: string;
  contactPhone: string;
  contactPhotoUrl?: string;
  expiresInSeconds?: number;
};

/**
 * Sends somebody's contact card.
 *
 * A card rather than the words, because the number is the message: written as text it reads as a
 * sentence somebody typed rather than as somebody to call. Only the three fields the picker handed over
 * are written, so what travels is what was chosen to travel and not the rest of the phone's address book.
 */
export async function sendContactMessage(input: SendContactInput) {
  const currentUser = getFirebaseAuth().currentUser;

  if (!currentUser) {
    throw new Error('Sign in to send a message.');
  }

  const contactName = input.contactName.trim();

  if (contactName === '' && input.contactPhone.trim() === '') {
    return '';
  }

  const senderName = await currentSenderName(currentUser.uid, currentUser.displayName || 'Someone');

  const record: ChatMessageRecord = {
    contactName: contactName || input.contactPhone.trim(),
    contactPhone: input.contactPhone.trim(),
    createdAt: serverTimestamp(),
    ...expiryField(input.expiresInSeconds),
    // The picker's photo, when it had one. Absent rather than null, so the bubble draws its initials
    // rather than trying to load a picture that is not there.
    ...(input.contactPhotoUrl ? { contactPhotoUrl: input.contactPhotoUrl } : {}),
    forwardedFrom: null,
    replyTo: null,
    senderId: currentUser.uid,
    senderName,
    type: 'contact',
  };

  const written = await addDoc(messagesRef(input.chatId), record);

  // From a screen that never read the room, so the preview is written here rather than by the caller.
  // Best effort: the card itself is already written, and a room that does not learn about it is a much
  // smaller problem than a card the reader never sees.
  await recordMessagePreview({
    chatId: input.chatId,
    preview: `Shared ${record.contactName}`,
    senderId: currentUser.uid,
  }).catch((error) => {
    console.warn('Could not update the room preview for a contact card:', error);
  });

  return written.id;
}

/**
 * When a message should stop existing, given the timer this account has set for the room.
 *
 * Zero, absent or negative all mean off, which is the same answer and one less thing to get wrong: the
 * field is left off entirely rather than written as a time in the past, so a room with the timer off has
 * no expiry on its messages at all.
 */
export function expiryFor(seconds?: number) {
  if (!seconds || seconds <= 0) {
    return undefined;
  }

  // A real Timestamp rather than the `{ _seconds, _nanoseconds }` shape. A plain object looks like a
  // timestamp to the reader of this code and is not one to Firestore: the SDK has no way to tell it
  // apart from a map, so it stores a map, and the rule that lets a room sweep a message whose time has
  // come asks whether `expiresAt` is a timestamp. The message then outlives the timer the person set.
  return Timestamp.fromMillis(Date.now() + seconds * 1000);
}

/**
 * The `expiresAt` field for a message, or nothing at all when the timer is off.
 *
 * Spread into a record rather than assigned, because assigning `undefined` is not the same as leaving a
 * field out: Firestore has no undefined, and a write carrying one is refused outright rather than
 * dropping that one field. This is why a room with no disappearing timer could not send a message at all.
 */
export function expiryField(seconds?: number) {
  const expiresAt = expiryFor(seconds);

  return expiresAt ? { expiresAt } : {};
}

/** Turns a failed send into a line the person can act on, rather than a shrug. */
export function describeSendFailure(error: unknown) {
  const details = typeof error === 'object' && error !== null
    ? error as { code?: unknown; message?: unknown }
    : {};
  const code = typeof details.code === 'string' ? details.code : '';
  const message = typeof details.message === 'string' ? details.message : '';

  if (code === 'permission-denied' || /permission[- ]denied|insufficient permissions/i.test(message)) {
    return 'The database refused this message (permission denied).';
  }

  if (code === 'unavailable' || /offline|unavailable|network/i.test(message)) {
    return 'No connection to the database.';
  }

  if (message !== '') {
    return message.length > 160 ? `${message.slice(0, 160)}…` : message;
  }

  return 'Please try again.';
}

/** Whether a message's time has come, judged against the wall clock on the device. */
export function isExpired(expiresAt: unknown) {
  const seconds = (expiresAt as { _seconds?: number; toMillis?: () => number } | undefined)?._seconds;
  const millis = (expiresAt as { toMillis?: () => number } | undefined)?.toMillis?.();

  const deadline = typeof seconds === 'number'
    ? seconds * 1000
    : typeof millis === 'number'
      ? millis
      : null;

  return deadline !== null && deadline <= Date.now();
}

/** Rewrites a message's words, which its sender may do and nobody else may. */
export async function editMessageText(chatId: string, messageId: string, text: string) {
  const trimmed = text.trim();

  if (trimmed === '') {
    throw new Error('A message cannot be emptied. Delete it instead.');
  }

  await updateDoc(doc(getFirebaseDb(), 'chats', chatId, 'messages', messageId), {
    editedAt: serverTimestamp(),
    text: trimmed,
  });
}

/** Pins or unpins a message. Only somebody who runs the room may, which the rules enforce. */
export async function setMessagePinned(chatId: string, messageId: string, pinned: boolean) {
  await updateDoc(doc(getFirebaseDb(), 'chats', chatId, 'messages', messageId), { pinned });
}

/** Removes a message outright. The sender or somebody who runs the room may. */
export async function deleteChatMessage(chatId: string, messageId: string) {
  await deleteDoc(doc(getFirebaseDb(), 'chats', chatId, 'messages', messageId));
}

/** One reaction document per person, holding the single emoji they chose. */
export type ReactionEntry = {
  emoji: string;
  uid: string;
};

function reactionRef(chatId: string, messageId: string, uid: string) {
  return doc(getFirebaseDb(), 'chats', chatId, 'messages', messageId, 'reactions', uid);
}

/**
 * Sets this account's reaction, or takes it back if it was the same one.
 *
 * A person has one reaction on a message rather than a set of them, so the document is overwritten
 * instead of merged. Two people choosing different emoji produce two documents and both are counted,
 * which is the behaviour every other reaction row in this app already has.
 */
export async function toggleMessageReaction(chatId: string, messageId: string, emoji: string) {
  const currentUser = getFirebaseAuth().currentUser;

  if (!currentUser) {
    return;
  }

  const reaction = reactionRef(chatId, messageId, currentUser.uid);
  const snapshot = await getDoc(reaction);

  if (snapshot.exists() && snapshot.data()?.emoji === emoji) {
    await deleteDoc(reaction);
    return;
  }

  await setDoc(reaction, { emoji });
}

/**
 * Reads a set of messages' reactions at once, for a screen that has just loaded them.
 *
 * One query total rather than one per message, and one read rather than a listener per message: the room
 * listener calls this for the visible tail and then leaves it alone, so a listener per message would be a
 * listener per bubble held open for as long as the room is open.
 *
 * Bounded twice over. The caller passes only the messages it is about to draw, which keeps this from
 * becoming a read per message in the history; and the reads are batched into a single collection group
 * query, chunked at Firestore's 30-value `in` limit.
 */
export async function loadMessageReactions(chatId: string, messageIds: string[]) {
  if (messageIds.length === 0) {
    return {} as Record<string, ReactionEntry[]>;
  }

  const unique = [...new Set(messageIds)];
  const byMessage: Record<string, ReactionEntry[]> = {};

  unique.forEach((messageId) => {
    byMessage[messageId] = [];
  });

  // One collection group query rather than a query per message.
  //
  // It was `Promise.all` over `getDocs` per message id, which for the 24-message tail this is called with
  // is 24 separate collection queries and 24 billed reads -- and because it ran inside the room's
  // `onSnapshot`, every message arriving, edited or deleted paid that again.
  //
  // `documentId() in [...]` asks for the reaction documents of all of them at once. Firestore caps an `in`
  // at 30 values, so a longer tail is chunked rather than truncated: dropping the overflow would silently
  // lose the reactions on the oldest visible messages, which is exactly the part of the screen that looks
  // broken when it happens. 30 is the documented limit for a single disjunctive filter.
  //
  // The query is not narrowed to this room, and it does not need to be. The reaction rule is
  // `allow list: if inChat(chatId)`, which Firestore evaluates per document against the document's own
  // parent room, so reactions belonging to conversations this account is not in are filtered out of the
  // result rather than causing the whole query to fail. Filtering on a `chatId` field instead was the
  // obvious alternative and is wrong here: reaction documents have never stored one, so that query would
  // have matched nothing at all.
  const chunks: string[][] = [];

  for (let start = 0; start < unique.length; start += 30) {
    chunks.push(unique.slice(start, start + 30));
  }

  await Promise.all(chunks.map(async (chunk) => {
    try {
      const snapshot = await getDocs(query(
        collectionGroup(getFirebaseDb(), 'reactions'),
        where(documentId(), 'in', chunk),
      ));

      snapshot.docs.forEach((reactionDocument) => {
        const data = reactionDocument.data() as { emoji?: unknown };
        const emoji = data.emoji;
        // chats/{chatId}/messages/{messageId}/reactions/{uid} -- two levels up from the document is the
        // message it belongs to. Read from the path rather than from a field, because reaction documents
        // have only ever stored the emoji.
        const messageDocument = reactionDocument.ref.parent.parent;
        const messageId = messageDocument ? messageDocument.id : '';

        if (typeof emoji !== 'string' || emoji === '') {
          return;
        }

        // Ids outside the requested set are ignored rather than added, so a stray document cannot grow the
        // map, and a message whose reactions cannot be read simply shows without them.
        if (messageId !== '' && byMessage[messageId]) {
          byMessage[messageId].push({ emoji, uid: reactionDocument.id });
        }
      });
    } catch (error) {
      // A reaction read failing leaves the affected messages without reactions, which is a degraded bubble
      // rather than a broken room. Worth a warning because it is usually a missing index rather than a
      // transient network fault, and it would otherwise be invisible.
      console.warn('Could not read message reactions:', error);
    }
  }));

  return byMessage;
}

/**
 * Reacts, replies or forwards one message into another room.
 *
 * The text is copied rather than a link to the original, because the point of forwarding is that the
 * person receiving it may not be in the room it came from and must not be able to read it. What travels
 * is the words and where they came from, and nothing that would let the receiver reach into the room
 * they are not in.
 */
export async function forwardMessage(input: {
  expiresInSeconds?: number;
  message: {
    albumItems?: AlbumItem[];
    contactName?: string;
    contactPhone?: string;
    fileName?: string;
    locationName?: string;
    latitude?: number;
    longitude?: number;
    mediaUrl?: string;
    senderName?: string;
    text?: string;
    type: ChatMessageType;
  };
  origin: ForwardOrigin;
  targetChatId: string;
}) {
  const currentUser = getFirebaseAuth().currentUser;

  if (!currentUser) {
    throw new Error('Sign in to forward this message.');
  }

  const senderName = await currentSenderName(currentUser.uid, currentUser.displayName || 'Someone');
  const record: ChatMessageRecord = {
    contactName: input.message.contactName,
    contactPhone: input.message.contactPhone,
    createdAt: serverTimestamp(),
    ...expiryField(input.expiresInSeconds),
    fileName: input.message.fileName,
    forwardedFrom: input.origin,
    latitude: input.message.latitude,
    locationName: input.message.locationName,
    longitude: input.message.longitude,
    mediaUrl: input.message.mediaUrl,
    replyTo: null,
    senderId: currentUser.uid,
    senderName,
    text: input.message.text,
    type: input.message.type,
  };

  // The whole album, because a forwarded album that arrived as one photograph out of ten would be a
  // message the sender did not send. Absent on anything that is not an album, rather than an empty array,
  // so a photo is not written as a message holding no photos.
  if (input.message.type === 'album' && input.message.albumItems?.length) {
    record.albumItems = input.message.albumItems;
  }

  await addDoc(messagesRef(input.targetChatId), record);

  // The target room's inbox row is a different room from the one the reader is in, so nothing else would
  // update it. Best effort, like every other preview write: the forwarded message itself is the thing
  // that has to land.
  await recordMessagePreview({
    chatId: input.targetChatId,
    preview: `Forwarded: ${summarizeMessage(record)}`,
    senderId: currentUser.uid,
  }).catch((error) => {
    console.warn('Could not update the room preview for a forwarded message:', error);
  });
}

/**
 * Reads a room's messages, oldest first, once.
 *
 * For searching and for the pinned list, neither of which is a live conversation. The conversation
 * screen uses a listener instead, because there the newest message arriving is the whole point.
 *
 * Bounded for the same reason the forward list is: this is a screen somebody is reading, not an export,
 * and a room with a very long history should not cost a read per message to search through.
 */
export async function loadRoomMessages(chatId: string, max = 500): Promise<LoadedMessage[]> {
  const snapshot = await getDocs(query(
    collection(getFirebaseDb(), 'chats', chatId, 'messages'),
    orderBy('createdAt', 'desc'),
    limit(max),
  ));

  return snapshot.docs
    .map((messageDocument) => ({
      ...messageDocument.data(),
      id: messageDocument.id,
      expired: isExpired(messageDocument.data().expiresAt),
    }) as LoadedMessage)
    .reverse();
}

/**
 * Only the pinned messages in a room, newest first.
 *
 * A query on `pinned` rather than a full-history read filtered on the client, which is what the pinned
 * screen used to do. That read up to 500 message documents on every focus -- and focus rather than mount,
 * because a pin made in the conversation underneath has to be there when the screen comes back -- so opening
 * the pinned list cost 500 reads to return the two or three messages that are actually pinned.
 *
 * An equality plus a sort is the shape Firestore usually serves from its automatic single-field indexes, so
 * this may need no composite index at all. If it does need one, the query fails loudly with
 * FAILED_PRECONDITION naming the index, which is a far better failure than quietly costing 500 reads per
 * open.
 */
export async function loadPinnedMessages(chatId: string): Promise<LoadedMessage[]> {
  const snapshot = await getDocs(query(
    collection(getFirebaseDb(), 'chats', chatId, 'messages'),
    where('pinned', '==', true),
    orderBy('createdAt', 'desc'),
  ));

  return snapshot.docs.map((messageDocument) => ({
    ...messageDocument.data(),
    expired: isExpired(messageDocument.data().expiresAt),
    id: messageDocument.id,
  } as LoadedMessage));
}

/** A message plus whether its time is up, which is what the search and pinned screens need to decide. */
export type LoadedMessage = ChatMessage & { expired: boolean };

/** Groups reactions by emoji for display: the emoji, how many chose it, and whether this account did. */
export function tallyReactions(reactions: ReactionEntry[], currentUid: string) {
  const counts = new Map<string, { count: number; mine: boolean }>();

  for (const reaction of reactions) {
    const entry = counts.get(reaction.emoji) ?? { count: 0, mine: false };

    counts.set(reaction.emoji, {
      count: entry.count + 1,
      mine: entry.mine || reaction.uid === currentUid,
    });
  }

  return [...counts.entries()].map(([emoji, value]) => ({ emoji, ...value }));
}

/**
 * The heart on its own, because it is the one reaction the conversation screen puts in reach without
 * asking: the heart on a bubble sends exactly this emoji, and the picker offers it first for the same
 * reason. Shared rather than typed twice, so the button and the picker can never disagree about what
 * the button sends.
 */
export const HEART_EMOJI = '❤️';

/** The emoji offered by the reaction picker. Chosen to be the ones people actually reach for. */
export const REACTION_EMOJI = [HEART_EMOJI, '👍', '😂', '😮', '😢', '🙏'];