import {
    collection,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    onSnapshot,
    query,
    serverTimestamp,
    setDoc,
    where,
} from 'firebase/firestore';

import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';
import { phoneIndexId } from '@/lib/phone-index';
import { getString, PERSON_NAME_KEYS, PERSON_PHOTO_KEYS, type UserData } from '@/lib/user-data';

/**
 * Friend requests, as one document per pair of people.
 *
 * The document id is both uids sorted and joined, which is what makes the whole thing work without a
 * server:
 *
 *   Both sides can find it. A request is something two people have to see -- the sender wants to know it
 *   was sent, the receiver has to be able to accept it -- and a per-account subcollection would mean the
 *   sender could only read their own copy. Two copies drift; one document cannot. The rules can then read
 *   `from` and `to` off it and answer "is this one of mine", which is what lets a plain collection query
 *   be filtered rather than a collection group across every request in the app.
 *
 *   A second request between the same two people lands on the same document, so re-sending after somebody
 *   declined updates one row instead of stacking up a history of identical ones.
 *
 *   Neither side can be tricked into sending one to themselves, and only the receiver can accept -- the
 *   rules check both, and the sender is left able to delete their own request to take it back.
 *
 * Accepted requests double as the friend list. There is no separate friendship: once both sides agree,
 * the document is the fact, and a second collection would be a second thing to keep in step with the
 * first and could disagree with it.
 */

export type FriendRequestStatus = 'pending' | 'accepted' | 'declined';

export type FriendRequest = {
  /** When it was last written, so the inbox can show what changed. */
  updatedAt?: unknown;
  createdAt?: unknown;
  from: string;
  /** Copied onto the request so the receiver can draw the sender without a profile read per row. */
  fromName?: string;
  fromPhotoUrl?: string;
  /** Whether the receiver has answered. Absent rather than pending on requests written before this. */
  status?: FriendRequestStatus;
  to: string;
};

export type FriendRequestId = {
  id: string;
  request: FriendRequest;
};

/**
 * The one document id both sides of a relationship share.
 *
 * Sorted, so that A asking B and B asking A are the same row rather than two rows that each wait for the
 * other. The separator cannot appear in a Firebase uid, so no pair of ids can collide by running together.
 */
export function friendRequestId(firstUid: string, secondUid: string) {
  return [firstUid, secondUid].sort().join('__');
}

function requestsRef() {
  return collection(getFirebaseDb(), 'friendRequests');
}

/**
 * Writes this account's own details onto a request.
 *
 * A profile read per row would be a read per person in somebody's request list, which for a list of any
 * length is a list of any length of reads. The name is copied instead, in the same spirit as a message's
 * `senderName`: briefly out of date is much cheaper than a read per bubble.
 */
async function readSenderProfile(uid: string) {
  const fallback = { fromName: 'Someone', fromPhotoUrl: '' };

  try {
    const snapshot = await getDoc(doc(getFirebaseDb(), 'users', uid));

    if (!snapshot.exists()) {
      return fallback;
    }

    const data = snapshot.data() as UserData;

    // The shared chains from user-data, not a third copy of them. This one is the most consequential of the
    // duplicates: whatever it stamps onto the request is exactly what the Find Friends screen reads back to
    // draw the row, so a name field added to the profile resolution elsewhere would have left requests
    // labelled with the old chain's answer.
    //
    // The difference in behaviour is small but was real: this copy accepted a whitespace-only string as a
    // name, so a profile with `displayName: '   '` produced a request labelled with three spaces.
    return {
      fromName: getString(data, PERSON_NAME_KEYS) || fallback.fromName,
      fromPhotoUrl: getString(data, PERSON_PHOTO_KEYS),
    };
  } catch {
    // A request that cannot name its sender is still a request that can be accepted; the receiver's list
    // falls back to the uid. Losing the picture is a much smaller problem than losing the request.
    return fallback;
  }
}

/**
 * Asks somebody to be a friend.
 *
 * Throws when the write fails rather than reporting a success it did not achieve: a button that says
 * "Request sent" over a request nobody received is worse than one that says it failed.
 */
export async function sendFriendRequest(toUid: string) {
  const currentUser = getFirebaseAuth().currentUser;

  if (!currentUser) {
    throw new Error('Sign in to send a friend request.');
  }

  if (!toUid || toUid === currentUser.uid) {
    return '';
  }

  const id = friendRequestId(currentUser.uid, toUid);
  const existing = await getDoc(doc(getFirebaseDb(), 'friendRequests', id));

  // Somebody already accepted this one, so it is a friendship rather than a request and there is nothing
  // to ask for. Said as a no-op rather than an error: the button is the same either way, and refusing it
  // would only happen for the person whose request was accepted.
  if (existing.exists() && existing.data()?.status === 'accepted') {
    return id;
  }

  const profile = await readSenderProfile(currentUser.uid);

  await setDoc(
    doc(getFirebaseDb(), 'friendRequests', id),
    {
      createdAt: serverTimestamp(),
      // Rewritten on every send, so re-sending after a decline leaves the row dated as new rather than
      // looking like a request from months ago sitting there.
      updatedAt: serverTimestamp(),
      from: currentUser.uid,
      fromName: profile.fromName,
      fromPhotoUrl: profile.fromPhotoUrl,
      status: 'pending' as const,
      to: toUid,
    },
    { merge: true },
  );

  return id;
}

/**
 * Answers a request that was sent to this account.
 *
 * Only `accepted` and `declined`, because the sender is not the one who answers. Declining keeps the
 * document rather than deleting it, which is what lets the sender see the answer instead of a request
 * that silently never changes.
 */
export async function answerFriendRequest(requestId: string, status: 'accepted' | 'declined') {
  const currentUser = getFirebaseAuth().currentUser;

  if (!currentUser) {
    throw new Error('Sign in to answer a friend request.');
  }

  const requestRef = doc(getFirebaseDb(), 'friendRequests', requestId);
  const snapshot = await getDoc(requestRef);

  // Checked here as well as in the rules. The rules are the part that cannot be bypassed; this is so that
  // a wrong call fails in the app with a sentence instead of an alert about permissions.
  if (!snapshot.exists() || snapshot.data()?.to !== currentUser.uid) {
    throw new Error('That request is not yours to answer.');
  }

  await setDoc(requestRef, { status, updatedAt: serverTimestamp() }, { merge: true });
}

/** Takes back a request this account sent. Only the sender may do this. */
export async function cancelFriendRequest(requestId: string) {
  const currentUser = getFirebaseAuth().currentUser;

  if (!currentUser) {
    return;
  }

  const requestRef = doc(getFirebaseDb(), 'friendRequests', requestId);
  const snapshot = await getDoc(requestRef);

  if (snapshot.exists() && snapshot.data()?.from === currentUser.uid) {
    await deleteDoc(requestRef);
  }
}

/**
 * Where this account's requests live.
 *
 * Filtered on one field and nothing else, deliberately: a single equality is served by the single-field
 * index, so this needs no composite index and cannot fail for want of one the day it is deployed. The
 * newest-first order the screens want is applied on the client, over a list that is one person's requests
 * and is short enough to sort in memory.
 */
function subscribeToRequests(uid: string, field: 'from' | 'to', onChange: (rows: FriendRequestId[]) => void) {
  return onSnapshot(
    query(
      requestsRef(),
      where(field, '==', uid),
    ),
    (snapshot) => {
      onChange(
        snapshot.docs
          .map((requestDocument) => ({
            id: requestDocument.id,
            request: requestDocument.data() as FriendRequest,
          }))
          .filter((row) => Boolean(row.request?.from && row.request?.to)),
      );
    },
    (error) => {
      // The list is empty rather than an error state, because a screen that cannot show requests is still
      // a usable screen: the reader can search for the person and send again.
      console.warn(`Could not watch ${field === 'to' ? 'incoming' : 'outgoing'} friend requests:`, error);
      onChange([]);
    },
  );
}

/** Requests waiting for this account to answer them. */
export function subscribeToIncomingFriendRequests(uid: string, onChange: (rows: FriendRequestId[]) => void) {
  if (!uid) {
    onChange([]);

    return () => {};
  }

  return subscribeToRequests(uid, 'to', onChange);
}

/** Requests this account has sent and not had answered. */
export function subscribeToOutgoingFriendRequests(uid: string, onChange: (rows: FriendRequestId[]) => void) {
  if (!uid) {
    onChange([]);

    return () => {};
  }

  return subscribeToRequests(uid, 'from', onChange);
}

/** Everybody this account is already friends with, read once rather than watched. */
export async function loadFriendIds(uid: string) {
  if (!uid) {
    return new Set<string>();
  }

  try {
    const snapshot = await getDocs(query(
      requestsRef(),
      where('from', '==', uid),
      where('status', '==', 'accepted'),
    ));
    const friends = new Set<string>();

    snapshot.docs.forEach((requestDocument) => {
      const request = requestDocument.data() as FriendRequest;

      // Either direction can be the accepted one, depending on who sent it, so both sides are offered and
      // the caller's own id is never in the result.
      if (request.to !== uid) {
        friends.add(request.to);
      }

      if (request.from !== uid) {
        friends.add(request.from);
      }
    });

    return friends;
  } catch (error) {
    console.warn('Could not load the friend list:', error);

    return new Set<string>();
  }
}

/** Everybody with an unanswered request from this account. */
export async function loadPendingRequestIds(uid: string) {
  if (!uid) {
    return new Set<string>();
  }

  try {
    const snapshot = await getDocs(query(
      requestsRef(),
      where('from', '==', uid),
      where('status', '==', 'pending'),
    ));

    return new Set(snapshot.docs.map((requestDocument) => requestDocument.data().to as string));
  } catch (error) {
    console.warn('Could not load the pending friend requests:', error);

    return new Set<string>();
  }
}

/**
 * Writing to the index is deliberately not implemented here.
 *
 * Reading is the safe direction and `matchContactsToAccounts` below does it: a client can only ask about a
 * number it already holds, so the index reveals nothing the caller did not bring with it.
 *
 * Writing is the direction that needs infrastructure this app does not have yet, and shipping it without
 * them would be worse than not shipping it:
 *
 *   The hash is an unpeppered SHA-256 of the last nine digits. A phone number has roughly 10^10
 *   possibilities, so a stored hash is confirmable against a candidate list in a few thousand tries per
 *   second by anyone who can read the collection. Every number written here is therefore recoverable in
 *   practice, which is why the numbers must be the account's own and verified ones -- never an address
 *   book, whose entries also do not belong to the account doing the writing.
 *
 *   There is no way to prove a number belongs to the caller. The rules can check that the document's uid
 *   equals the caller's uid, but the hash in the document path is whatever the client computed, so a
 *   client can claim any number it likes. Closing that needs a trusted party: an OTP challenge against the
 *   number, verified server side, with the pepper held in the same server.
 *
 * When both exist, the write is a Cloud Function rather than a client call, keyed on a hash the server
 * recomputes. Until then this screen finds people and is not itself findable, which is the half that can
 * be shipped honestly.
 */
export type ContactMatch = {
  /** Whose address book the number came from, so the suggestion can say whose contact it is. */
  contactName: string;
  matchedUid: string;
};

/**
 * Finds which of a list of contacts have an account here.
 *
 * One `get` per hash rather than one query over the collection, because the collection refuses to be
 * listed and that refusal is the whole privacy property of it: a client can only ask about a number it
 * already has. The cost is a read per contact, which is why the caller bounds the address book it reads
 * and this runs off the back of a button rather than on every visit.
 *
 * The account's own number matches itself, so it is dropped here rather than by every caller.
 */
export async function matchContactsToAccounts(uid: string, contacts: { name: string; phone: string }[]) {
  const matches: ContactMatch[] = [];
  const seen = new Set<string>();

  for (const contact of contacts) {
    const hash = await phoneIndexId(contact.phone);

    if (hash === '') {
      continue;
    }

    try {
      const snapshot = await getDoc(doc(getFirebaseDb(), 'phoneIndex', hash));

      if (!snapshot.exists()) {
        continue;
      }

      const matchedUid = snapshot.data()?.uid as string | undefined;

      if (!matchedUid || matchedUid === uid || seen.has(matchedUid)) {
        continue;
      }

      seen.add(matchedUid);
      matches.push({ contactName: contact.name, matchedUid });
    } catch (error) {
      console.warn('Could not check one contact against the index:', error);
    }
  }

  return matches;
}