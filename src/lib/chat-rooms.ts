import {
  addDoc,
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  limit as limitQuery,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';

import { forgetChatSettings } from './chat-settings';
import { getFirebaseAuth, getFirebaseDb, getFirebaseStorage } from './firebase';
import { getString, getParticipants, UserData } from './user-data';

/**
 * What a room is.
 *
 * `direct` is one other person, `group` is several people who can all talk, and `channel` is several
 * people of whom only the owner can talk. The third is the reason this type exists rather than a
 * boolean: a channel is the same document with a different rule about who may write to it, and the rule
 * lives in firestore.rules.
 */
export type RoomKind = 'direct' | 'group' | 'channel';

/**
 * Who may see a room exists, and who may ask to be added to it.
 *
 * `public` is discoverable and joinable by invite; `private` is reachable only by the people already in
 * it. Separate from `kind` because it answers a different question: a channel is about who may talk, and
 * privacy is about who may find it. A private channel is the ordinary combination of the two.
 */
export type RoomPrivacy = 'public' | 'private';

/**
 * A member's standing in a room.
 *
 * Owner, admin and member are one field's worth of difference rather than three kinds of room, so the
 * room document carries the owner as `ownerId` and the admins as `admins[]`, and this reads the two into
 * one word for the interface.
 */
export type RoomRole = 'owner' | 'admin' | 'member';

export function readRoomPrivacy(data: UserData): RoomPrivacy {
  return data.privacy === 'private' ? 'private' : 'public';
}

/** The accounts that may help run the room. Never contains the owner, who is named separately. */
export function readRoomAdminIds(data: UserData) {
  const admins = data.admins;

  if (!Array.isArray(admins)) {
    return [];
  }

  return admins.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/**
 * The accounts that may not be added back to the room.
 *
 * Kept on the room rather than only as "not in participants", so that an admin can tell a person who was
 * removed on purpose from one who simply left.
 */
export function readRoomBannedIds(data: UserData) {
  const banned = data.banned;

  if (!Array.isArray(banned)) {
    return [];
  }

  return banned.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/** The code an invite link carries, empty on a room that has never been shared. */
export function readRoomInviteCode(data: UserData) {
  return getString(data, ['inviteCode']);
}

/** One account's standing in a room, resolved from the owner id and the admin list. */
export function readRoomRole(data: UserData, uid: string): RoomRole {
  if (uid !== '' && readRoomOwnerId(data) === uid) {
    return 'owner';
  }

  return uid !== '' && readRoomAdminIds(data).includes(uid) ? 'admin' : 'member';
}

/**
 * Whether an account may change the room's settings or its membership.
 *
 * Owner or admin, and an empty uid is nobody: a signed-out screen, or one whose profile read has not
 * answered yet, must not be shown the controls. Deliberately generous to admins, because the whole point
 * of having one is that the owner is not the only person who can answer a question in the room.
 */
export function canManageRoom(data: UserData, uid: string) {
  if (uid === '') {
    return false;
  }

  return readRoomRole(data, uid) === 'owner' || readRoomRole(data, uid) === 'admin';
}

/**
 * The kind of a room document, read defensively.
 *
 * Rooms written before kinds existed carry no `kind`, and inferring one from the shape of the document is
 * how they are still shown correctly: more than two participants was always a group, anything else was
 * always a one to one. So `kind` is authoritative when present and the participant count is the fallback,
 * which means a room created by an older build of the app keeps working in a newer one.
 */
export function readRoomKind(data: UserData): RoomKind {
  const kind = data.kind;

  if (kind === 'direct' || kind === 'group' || kind === 'channel') {
    return kind;
  }

  const participants = Array.isArray(data.participants) ? data.participants : [];

  return participants.length > 2 ? 'group' : 'direct';
}

/** Whether the room is a group or a channel, which is everything a direct chat is not. */
export function isGroupRoom(kind: RoomKind) {
  return kind === 'group' || kind === 'channel';
}

/**
 * The account that owns a room, or an empty string for a room written before owners existed.
 *
 * Empty rather than null so callers can compare it to a uid without a check, and because "nobody owns
 * this" is the honest answer for those rooms rather than a claim that the first participant does.
 */
export function readRoomOwnerId(data: UserData) {
  return typeof data.ownerId === 'string' ? data.ownerId : '';
}

/**
 * Whether an account may post into a room.
 *
 * The same test firestore.rules makes, kept here so the composer can be hidden rather than letting
 * somebody type a message that is certain to be refused. The rules remain the authority: this only
 * decides what the screen offers, and a room whose owner cannot be read posts for nobody, which is what
 * the rule does too when `ownerId` is missing from a channel.
 *
 * Admins may post in a channel as well as the owner. Without that, an admin could be shown the member
 * list and the room's settings and be unable to answer anybody in the room itself, which is not a role
 * anybody wants.
 */
export function canPostToRoom(kind: RoomKind, ownerId: string, adminIds: string[], uid: string) {
  if (kind !== 'channel') {
    return true;
  }

  if (uid === '') {
    return false;
  }

  return (ownerId !== '' && ownerId === uid) || adminIds.includes(uid);
}

/** The participant ids of a room document, filtered down to things that can be ids. */
export function readParticipantIds(data: UserData) {
  const participants = data.participants;

  if (!Array.isArray(participants)) {
    return [];
  }

  return participants.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/** The name of a room, falling back to what the caller knows rather than to a blank string. */
export function readRoomName(data: UserData, fallback: string) {
  return getString(data, ['name'], fallback);
}

/** What a room says about itself, if anything. */
export function readRoomAbout(data: UserData) {
  return getString(data, ['about']);
}

/** The room's picture, if it has one. */
export function readRoomAvatarUrl(data: UserData) {
  return getString(data, ['avatarUrl']);
}

/**
 * The display name of a person, and their picture, read the way the rest of the app reads a profile.
 *
 * Every name field the app has ever written is tried in turn. That is not tidiness: profiles in this
 * database were written by several generations of the app under different field names, and reading only
 * the newest one leaves some people nameless.
 */
export function readPerson(data: UserData, fallbackName = '') {
  return {
    about: getString(data, ['about', 'bio']),
    name: getString(data, ['displayName', 'name', 'username'], fallbackName),
    photoUrl: getString(data, ['profilePictureUrl', 'photoURL', 'photoUrl', 'avatarUrl']),
  };
}

export type PersonSummary = {
  id: string;
  name: string;
  photoUrl: string;
};

/**
 * Finds people to put in a new room.
 *
 * Firestore cannot search a string by "contains", and a range query would only work on one of the name
 * fields listed in readPerson while profiles here are spread across several. So this reads a bounded
 * slice of the accounts and filters it in memory.
 *
 * That is a real limit and it is deliberate at this size: the slice is alphabetical-ish in whatever order
 * the backend returns, so somebody who has never had their profile read may be outside it. When the
 * account count outgrows the slice this needs a real search index, and the honest fix is a denormalised
 * lowercase name field with a range query rather than a bigger limit.
 */
export async function searchPeople(
  searchText: string,
  excludeUids: string[],
  max = 100,
): Promise<PersonSummary[]> {
  const needle = searchText.trim().toLowerCase();
  const excluded = new Set(excludeUids);
  const snapshot = await getDocs(query(collection(getFirebaseDb(), 'users'), limitQuery(max)));

  return snapshot.docs
    .filter((userDocument) => !excluded.has(userDocument.id))
    .map((userDocument) => {
      const person = readPerson(userDocument.data(), '');

      return { id: userDocument.id, name: person.name, photoUrl: person.photoUrl };
    })
    .filter((person) => {
      if (!needle) {
        // Everybody with a name worth showing. An account that has never set one is skipped rather than
        // listed as a blank row nobody can pick on purpose.
        return person.name !== '';
      }

      return person.name.toLowerCase().includes(needle);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type CreateRoomInput = {
  about?: string;
  avatarUri?: string;
  kind: RoomKind;
  name: string;
  participantIds: string[];
  privacy?: RoomPrivacy;
};

/**
 * The characters an invite code is built from.
 *
 * No 0/O or 1/I/l, because this gets read aloud and typed off a screen by hand as often as it gets
 * scanned, and the pairs people confuse are exactly the ones that make somebody look at a link twice
 * before trusting it.
 */
const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * A short random code for an invite link.
 *
 * Sixteen characters out of a 30 letter alphabet, so roughly 79 bits of space, which is far more than
 * makes a code guessable in practice even though `Math.random` is not a cryptographic source. What
 * actually protects a private room is not the secrecy of this string: firestore.rules refuses to add
 * anybody to a room on the strength of an invite alone, so guessing a code at worst reveals that a
 * private room exists and that this person was invited to it. The invite has to be shared deliberately
 * either way.
 *
 * The first four characters carry a checksum of the rest, so a mistyped code is rejected by the reader
 * instead of turning into a join request that fails later for no visible reason.
 */
export function createInviteCode() {
  const pick = () => INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
  let body = '';

  for (let index = 0; index < 12; index += 1) {
    body += pick();
  }

  // Modulo arithmetic over the character codes, which is enough for a typo check and costs nothing.
  const sum = body.split('').reduce((total, character) => total + character.charCodeAt(0), 0);
  const checksum = sum % 30;

  return `${INVITE_ALPHABET[checksum]}${body}`;
}

/** Whether a code could have been produced by createInviteCode, which is what a join reader checks. */
export function isWellFormedInviteCode(code: string) {
  const normalized = normalizeInviteCode(code);

  if (normalized.length !== 13) {
    return false;
  }

  const [checksum, ...rest] = normalized.split('');
  const body = rest.join('');
  const sum = body.split('').reduce((total, character) => total + character.charCodeAt(0), 0);

  return INVITE_ALPHABET[sum % 30] === checksum;
}

/** Uppercase, and without the separators people paste in from a chat app or a printed card. */
export function normalizeInviteCode(code: string) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Writes a new room, and returns its id.
 *
 * The owner is written onto the document rather than worked out later from the participant list, because
 * "the first person in the array" is a fact about how the client sorted it and would make renaming or
 * deleting the room depend on that sort. The rules refuse a room whose `ownerId` is not the account that
 * created it, so this cannot be used to make a room somebody else owns.
 *
 * Every field the rules validate is written, including the empty ones. A missing `about` is a different
 * thing from an empty one when the profile screen reads it, and the rules accept either.
 *
 * The invite code is written here rather than generated on demand, so that a link to a room cannot
 * start working for somebody who was given an old one after the owner turned codes off. Turning invites
 * off empties the field, which makes every link already in the wild fail.
 */
export async function createRoom(input: CreateRoomInput) {
  const currentUser = getFirebaseAuth().currentUser;

  if (!currentUser) {
    throw new Error('You need to be signed in to create a room.');
  }

  // Deduplicated and sorted, because the same person picked twice is still one participant and because
  // the owner has to be findable in the array by the rules and by the profile screen. Sorting is only
  // for tidiness; the owner is identified by `ownerId`, not by position.
  const participants = [...new Set([currentUser.uid, ...input.participantIds])].sort();

  if (participants.length < 2) {
    throw new Error('Pick at least one person to add.');
  }

  const about = input.about?.trim() ?? '';
  // A one-to-one is private whatever was asked for: its whole audience is the two people in it, and a
  // "public" flag on it would claim there is a wider one.
  const privacy: RoomPrivacy = input.kind === 'direct' ? 'private' : (input.privacy ?? 'public');

  const room = await addDoc(collection(getFirebaseDb(), 'chats'), {
    about,
    avatarUrl: '',
    // Written empty rather than left off, so the rules can hold it to being a list and the profile
    // screen can tell "nobody is banned" from "this room predates bans".
    admins: [],
    banned: [],
    createdAt: serverTimestamp(),
    inviteCode: createInviteCode(),
    kind: input.kind,
    // The preview the inbox reads before anybody has spoken, and the timestamp it orders the list by.
    // A room written without the timestamp is excluded from the list entirely, so both are written here
    // rather than left to the first message.
    lastMessage: ROOM_PREVIEW_PLACEHOLDER,
    lastMessageSenderId: currentUser.uid,
    lastMessageTime: serverTimestamp(),
    name: input.name.trim(),
    ownerId: currentUser.uid,
    participants,
    privacy,
  });

  // The picture is written after the room exists, because its path is keyed on the room id. A failure
  // here leaves a room without a picture rather than no room at all, which is the better of the two
  // outcomes: the picture can be added from the profile afterwards, and the room cannot.
  if (input.avatarUri) {
    try {
      const avatarUrl = await uploadRoomAvatar(room.id, currentUser.uid, input.avatarUri);

      await updateDoc(doc(getFirebaseDb(), 'chats', room.id), { avatarUrl });
    } catch (error) {
      console.warn('Could not upload the room picture:', error);
    }
  }

  return room.id;
}

/**
 * Uploads a room picture and returns its url, or an empty string when there is no picture to upload.
 *
 * Written into the room's own folder rather than a shared one so a room's picture cannot be overwritten by
 * an unrelated upload, and so deleting a room leaves its picture identifiable rather than mixed in with
 * every other image in the bucket.
 */
export async function uploadRoomAvatar(chatId: string, uid: string, avatarUri: string) {
  if (!avatarUri) {
    return '';
  }

  const response = await fetch(avatarUri);

  if (!response.ok) {
    throw new Error('Could not read the selected picture.');
  }

  const blob = await response.blob();
  const extension = avatarUri.toLowerCase().split('?')[0].endsWith('.png') ? 'png' : 'jpg';
  const avatarRef = ref(
    getFirebaseStorage(),
    `chats/${chatId}/avatar/${uid}_${Date.now()}.${extension}`,
  );

  await uploadBytes(avatarRef, blob, { contentType: blob.type || `image/${extension}` });

  return getDownloadURL(avatarRef);
}

/**
 * The conversation with one other person, opened or made.
 *
 * Found rather than always made, because the participant list cannot be changed after a room is
 * written: a second room with the same two people is a second conversation with them, and nobody
 * means to start one. Firestore cannot search a room by the people in it, so this reads the caller's
 * own rooms -- which is every room they can read anyway -- and matches on two participants.
 *
 * Two participants is enough of a test without also asking for the kind: the list is immutable, so a
 * room with two people in it is two people and always will be.
 *
 * Shared because two places open the same conversation -- the find-people screen and somebody's
 * profile -- and two copies of "look first, then make" is how one of them ends up making a duplicate
 * the other one would have found.
 */
export async function openDirectChat(otherUserId: string, nameForRoom = '') {
  const currentUser = getFirebaseAuth().currentUser;

  if (!currentUser) {
    throw new Error('You need to be signed in to start a conversation.');
  }

  const db = getFirebaseDb();
  const existingChats = await getDocs(query(
    collection(db, 'chats'),
    where('participants', 'array-contains', currentUser.uid),
  ));

  const existing = existingChats.docs.find((chatDocument) => {
    const participants = getParticipants(chatDocument.data().participants);

    return participants.length === 2 && participants.includes(otherUserId);
  });

  if (existing) {
    return existing.id;
  }

  return createRoom({ kind: 'direct', name: nameForRoom, participantIds: [otherUserId] });
}

/** Renames, redescribes, re-pictures or re-privacies a room. Only the owner may, and only these fields. */
export async function updateRoomDetails(
  chatId: string,
  details: { about?: string; avatarUrl?: string; name?: string; privacy?: RoomPrivacy },
) {
  const update: Record<string, string> = {};

  // Only the fields actually being changed. `updateDoc` rejects an undefined value, and the rules check
  // which fields a write touched, so passing all three every time would ask for permission to write the
  // ones that are not changing.
  if (typeof details.name === 'string') {
    update.name = details.name;
  }

  if (typeof details.about === 'string') {
    update.about = details.about;
  }

  if (typeof details.avatarUrl === 'string') {
    update.avatarUrl = details.avatarUrl;
  }

  if (typeof details.privacy === 'string') {
    update.privacy = details.privacy;
  }

  if (Object.keys(update).length === 0) {
    return;
  }

  await updateDoc(doc(getFirebaseDb(), 'chats', chatId), update);
}

/**
 * Turns a room's invite link on or off, by emptying or filling its code.
 *
 * Two writes and not one, because the code is kept in two places on purpose. On the room it is what the
 * join is allowed by, and in `chats/{chatId}/invites/{code}` it is the directory that makes the room
 * findable from the code at all: Firestore cannot run a query across subcollections of other documents,
 * so without that directory document the only way to resolve a code would be a query on the rooms
 * themselves, which the rules cannot prove and which would list every room in the app.
 *
 * Empty rather than a flag, so there is one thing to revoke: a link handed out before the owner turned
 * invites off stops working, which a boolean alongside the code could not do. The code's own document is
 * deleted rather than left behind, because a directory entry that is still there would keep resolving the
 * link even though the room would refuse the join.
 */
export async function setRoomInviteCode(chatId: string, enabled: boolean) {
  const roomRef = doc(getFirebaseDb(), 'chats', chatId);
  const currentUser = getFirebaseAuth().currentUser;

  if (!currentUser) {
    throw new Error('Sign in to share this group.');
  }

  const snapshot = await getDoc(roomRef);
  const existing = snapshot.exists() ? readRoomInviteCode(snapshot.data()) : '';

  // The room stops accepting joins first. A directory entry deleted after a failure here would resolve
  // the link to a room that turns the join away, which is a worse answer than a link that plainly does
  // not work.
  await updateDoc(roomRef, { inviteCode: '' });

  if (existing !== '') {
    await deleteDoc(doc(getFirebaseDb(), 'chats', chatId, 'invites', existing)).catch(() => {
      // Already gone, or a room written before the directory existed. Neither leaves anything that can
      // be joined, because the room has no code any more.
    });
  }

  if (!enabled) {
    return;
  }

  const inviteCode = createInviteCode();

  await setDoc(doc(getFirebaseDb(), 'chats', chatId, 'invites', inviteCode), {
    chatId,
    code: inviteCode,
    createdAt: serverTimestamp(),
  });
  await updateDoc(roomRef, { inviteCode });
}

/**
 * Writes the line the inbox shows for a room, and moves everybody else's unread badge.
 *
 * The inbox reads `lastMessage` off the room rather than reading the newest message in each room, so
 * nothing in the list changes until this is written. It lives here rather than only on the conversation
 * screen because a message can be sent from a screen that never read the room -- the contact picker is
 * the one that has to -- and a message whose room never learned about it is a message the reader never
 * finds.
 *
 * Recipients are passed in by a caller that already has them, and read from the room when it does not.
 * One extra read on a rare path beats making every screen track participants itself.
 */
export async function recordMessagePreview(input: {
  chatId: string;
  preview: string;
  senderId: string;
  recipients?: string[];
}) {
  const roomRef = doc(getFirebaseDb(), 'chats', input.chatId);
  const recipients = input.recipients ?? await readRecipients(roomRef);
  const update: Record<string, unknown> = {
    lastMessage: input.preview.slice(0, 120),
    lastMessageSenderId: input.senderId,
    // Written on every message, not only when it changes: a room written before this field existed is
    // filtered out of the inbox entirely, since the list orders on it.
    lastMessageTime: serverTimestamp(),
  };

  recipients.forEach((participantId) => {
    if (participantId !== input.senderId) {
      // Dot path rather than a nested object, so the increment applies to one participant's counter and
      // leaves the rest of the map alone.
      update[`unreadCounts.${participantId}`] = increment(1);
    }
  });

  await updateDoc(roomRef, update);
}

async function readRecipients(roomRef: ReturnType<typeof doc>) {
  try {
    const snapshot = await getDoc(roomRef);
    return snapshot.exists() ? readParticipantIds(snapshot.data()) : [];
  } catch (error) {
    // A room that cannot be read here is still worth a preview: the line and the timestamp are written
    // either way, and only the badges are missed.
    console.warn('Could not read the room participants:', error);

    return [];
  }
}

/**
 * Makes somebody an admin of a room, or takes it away from them.
 *
 * Not offered for the owner, whose standing is `ownerId` and cannot be edited here: writing somebody else
 * as owner would move the room out from under the person who made it, and firestore.rules refuses any
 * write to `ownerId` for the same reason.
 *
 * An admin cannot promote themselves, which is what the rules enforce, so the caller is dropped from the
 * admin list whatever they asked for. Better a clear refusal than a room quietly full of admins.
 */
/**
 * Clears this account's unread count in one room, and only theirs.
 *
 * The counter is per participant, so it is written with a dotted path: that way the write touches one
 * entry in the map and leaves the other person's count exactly as it was, which is what lets a member
 * read a room without also marking it read for everybody else in it.
 */
export async function markRoomRead(chatId: string, participantId: string) {
  await updateDoc(doc(getFirebaseDb(), 'chats', chatId), {
    [`unreadCounts.${participantId}`]: 0,
  });
}

/**
 * Clears this account's unread count in several rooms.
 *
 * One write per room rather than a batch, because a failure on one room is not a reason to leave the
 * others reading as unread, and clearing a room's count is true on its own -- there is nothing here
 * that has to land together. Failures are logged and stepped over rather than raised: this is called
 * from a button whose worst outcome is a badge that has not gone yet.
 */
export async function markRoomsRead(chatIds: string[], participantId: string) {
  for (const chatId of chatIds) {
    try {
      await markRoomRead(chatId, participantId);
    } catch (error) {
      console.warn(`Could not mark ${chatId} as read:`, error);
    }
  }
}

export async function setRoomAdmin(chatId: string, uid: string, makeAdmin: boolean) {
  const roomRef = doc(getFirebaseDb(), 'chats', chatId);
  const snapshot = await getDoc(roomRef);

  if (!snapshot.exists()) {
    return;
  }

  const data = snapshot.data();
  const admins = readRoomAdminIds(data).filter((adminId) => adminId !== uid && adminId !== readRoomOwnerId(data));
  const next = makeAdmin && uid !== readRoomOwnerId(data) ? [...admins, uid] : admins;

  await updateDoc(roomRef, { admins: next });
}

/**
 * Adds people to a room, or takes somebody out of it.
 *
 * The stored participant list is read first and rewritten whole, for the same reason leaveRoom does: the
 * rules compare the new list against the stored one, so a write built from what the screen happened to be
 * holding can be refused for looking at a stale room.
 *
 * A banned account is refused here as well as in the rules. A member who was removed on purpose can open
 * the room again through the invite link, and this is where that stops.
 */
export async function updateRoomMembers(chatId: string, addIds: string[], removeIds: string[]) {
  if (addIds.length === 0 && removeIds.length === 0) {
    return;
  }

  const roomRef = doc(getFirebaseDb(), 'chats', chatId);
  const snapshot = await getDoc(roomRef);

  if (!snapshot.exists()) {
    return;
  }

  const data = snapshot.data();
  const banned = new Set(readRoomBannedIds(data));
  const current = readParticipantIds(data);
  // Sorted and deduplicated because the rules check membership with `in`, and because a room whose
  // participant list has drifted is a room where two screens disagree about who is in it.
  const next = [...new Set([
    ...current.filter((participantId) => !removeIds.includes(participantId)),
    ...addIds.filter((participantId) => !banned.has(participantId)),
  ])].sort();

  if (next.length === current.length && next.every((participantId, index) => participantId === current[index])) {
    return;
  }

  // Nobody may leave a room to nobody: the rules require at least one participant, and a room with none is
  // a document the remaining members can never delete. Guarded here so the error is a sentence rather
  // than a permission error.
  if (next.length < 1) {
    throw new Error('A room cannot be left with nobody in it.');
  }

  await updateDoc(roomRef, { participants: next });
}

/**
 * Removes somebody and stops the invite from bringing them back.
 *
 * Two writes and not one, because the rules treat the two lists separately: removing the person is a
 * membership change, and adding them to `banned` is a moderation decision, and the caller has to be
 * allowed to do both. The removal goes first so that a failure leaves somebody removed but unbanned,
 * which they can undo by rejoining, rather than banned while still holding the room's messages.
 */
export async function banRoomMember(chatId: string, uid: string) {
  const roomRef = doc(getFirebaseDb(), 'chats', chatId);
  const snapshot = await getDoc(roomRef);

  if (!snapshot.exists()) {
    return;
  }

  const data = snapshot.data();
  const remaining = readParticipantIds(data).filter((participantId) => participantId !== uid);

  if (remaining.length === readParticipantIds(data).length) {
    return;
  }

  await updateDoc(roomRef, { participants: remaining });
  await updateDoc(roomRef, { banned: [...new Set([...readRoomBannedIds(data), uid])] });
}

/** Lets a banned account be added again. */
export async function unbanRoomMember(chatId: string, uid: string) {
  const roomRef = doc(getFirebaseDb(), 'chats', chatId);
  const snapshot = await getDoc(roomRef);

  if (!snapshot.exists()) {
    return;
  }

  const banned = readRoomBannedIds(snapshot.data()).filter((bannedId) => bannedId !== uid);

  await updateDoc(roomRef, { banned });
}

/**
 * Joins the caller to a room from an invite code, and returns the room's id.
 *
 * Three steps, each because the step before it is not allowed on its own. The code is turned into a room
 * id by reading the invite directory, which any account may read because it holds nothing but the code and
 * the id it points at. The room is then read, which the rules allow for a public room that has invites
 * turned on, so the caller can see what they are about to join rather than being added blind. Only then
 * is the participant list written, and the rules check that write against the stored one, so a room cannot
 * be joined by a client that would also have been free to drop somebody on the way in.
 *
 * Already a member, or banned from the room, and the room id comes back rather than an error: a link
 * opened twice, or reopened later, should land on the conversation and not look like a failure.
 */
export async function joinRoomByInviteCode(code: string) {
  const currentUser = getFirebaseAuth().currentUser;

  if (!currentUser) {
    throw new Error('Sign in to join this group.');
  }

  const normalized = normalizeInviteCode(code);

  if (normalized === '') {
    throw new Error('That link has no group code on it.');
  }

  // The checksum is checked before anything is sent, so an obviously mistyped code fails immediately
  // rather than as a permission error on a room that does not exist.
  if (!isWellFormedInviteCode(normalized)) {
    throw new Error('That group code is not valid. Check it and try again.');
  }

  // A collection group rather than a rooms query, because the directory is the only place a code can be
  // looked up: the same equality on `chats` would have to be provable against a room the caller is not in.
  const matches = await getDocs(query(
    collectionGroup(getFirebaseDb(), 'invites'),
    where('code', '==', normalized),
    limitQuery(1),
  ));
  const invite = matches.docs[0];

  if (!invite) {
    throw new Error('That group link is no longer valid.');
  }

  const chatId = getString(invite.data(), ['chatId']);

  if (chatId === '') {
    throw new Error('That group link is no longer valid.');
  }

  const roomRef = doc(getFirebaseDb(), 'chats', chatId);
  const snapshot = await getDoc(roomRef);

  if (!snapshot.exists()) {
    throw new Error('That group is no longer available.');
  }

  const data = snapshot.data();

  if (readRoomPrivacy(data) !== 'public' || readRoomInviteCode(data) === '') {
    throw new Error('That group is private. Ask somebody in it for an invite.');
  }

  if (readRoomBannedIds(data).includes(currentUser.uid)) {
    throw new Error('You cannot join this group.');
  }

  if (!readParticipantIds(data).includes(currentUser.uid)) {
    await updateRoomMembers(chatId, [currentUser.uid], []);
  }

  return chatId;
}

/**
 * Removes this account from a room.
 *
 * The read first is not decoration: the rules allow a participant list to change only by losing exactly
 * the caller and nothing else, so the new list has to be built from the stored one rather than from
 * whatever the screen happened to be holding. A room that has been deleted underneath this one throws,
 * and the caller is already somewhere else by then.
 */
export async function leaveRoom(chatId: string, uid: string) {
  const roomRef = doc(getFirebaseDb(), 'chats', chatId);
  const snapshot = await getDoc(roomRef);

  if (!snapshot.exists()) {
    return;
  }

  const remaining = readParticipantIds(snapshot.data()).filter((participantId) => participantId !== uid);

  await updateDoc(roomRef, { participants: remaining });

  // The account's own settings for this room go at the same time. Absent means defaults, so this is tidying
  // rather than correctness -- but without it the account keeps a mute and a disappearing-messages timer for
  // a room it has left, and re-joining later would silently restore a setting nobody remembers choosing.
  await forgetChatSettings(chatId, uid);
}

/** The fields a room document is written with, shared by the creation path and its documentation. */
export const ROOM_PREVIEW_PLACEHOLDER = 'Say hello';
