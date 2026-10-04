import { Ionicons } from '@expo/vector-icons';
import * as Contacts from 'expo-contacts';
import { router } from 'expo-router';
import {
    collection,
    documentId,
    endAt,
    getDocs,
    limit as firestoreLimit,
    orderBy,
    query,
    startAt,
    where,
} from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    Pressable,
    RefreshControl,
    StyleSheet,
    Text,
    TextInput,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PersonAvatar } from '@/components/person-avatar';
import {
    answerFriendRequest,
    cancelFriendRequest,
    ContactMatch,
    FriendRequestId,
    loadFriendIds,
    loadPendingRequestIds,
    matchContactsToAccounts,
    sendFriendRequest,
    subscribeToIncomingFriendRequests,
    subscribeToOutgoingFriendRequests,
} from '@/lib/friend-requests';
import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';
import { loadFollowIds } from '@/lib/follow';
import { getString, PERSON_NAME_KEYS, PERSON_PHOTO_KEYS, UserData } from '@/lib/user-data';

/** A name and a picture, as read off a profile document. */
type Person = { displayName: string; photoUrl: string };

/**
 * Find people, and the people who have asked to find this account.
 *
 * Three ways in, because "how do I find people in this app" has three different answers:
 *
 *   Search       - somebody already knows the name. Firestore cannot match a name by "contains", so this
 *                  is a prefix range query: it finds accounts whose name begins with what was typed and
 *                  nobody in the middle of it. That is a limit of the query rather than a shortcut, and
 *                  the empty state says so instead of implying nobody matched.
 *   Contacts     - somebody knows the person but not their username. Their number is hashed and looked up
 *                  in the index; see src/lib/phone-index.ts for exactly what that does and does not
 *                  protect, which is worth reading before this feature ships to anybody.
 *   Suggestions  - nobody knows who they are after, so this offers accounts this one has something in
 *                  common with. Mutual follows only, and that is a deliberate narrowing: the alternative
 *                  is "whoever registered recently", which is how a brand new account is shown a screen
 *                  full of strangers with nothing in common, which is worse than showing nothing.
 *
 * The request list lives at the top of this screen rather than on a screen of its own. Sending is half of
 * this feature and being answered is the other, and somebody who has just asked to be someone's friend
 * wants to see the answer without going looking for it.
 */

type Candidate = {
  /** Whose contact it was, for a row that came out of the address book. */
  contactName?: string;
  displayName: string;
  id: string;
  mutualCount: number;
  photoUrl: string;
  source: 'contact' | 'search' | 'suggested';
};

/** How many accounts one search brings back. A search box is not a directory browser. */
const SEARCH_LIMIT = 25;
/** How many suggestions to offer before it stops being a suggestion and starts being a list. */
const SUGGESTION_LIMIT = 12;
/**
 * How many of this account's own follows are opened looking for mutual ones.
 *
 * Each one is a document read, so this is what bounds the suggestions query. It is the follows most
 * recently written that get looked at, which are the newest connections and so the likeliest to have
 * introduced anybody new.
 */
const FOLLOWS_TO_SCAN = 20;
/**
 * How many contacts to read, and how many to match at a time.
 *
 * An address book is a few hundred entries on a real phone and matching is one document read per number,
 * so this is what keeps a sync to seconds rather than a minute. The contacts are read newest-called-first,
 * because those are the people most likely to be a friend worth suggesting.
 */
const CONTACTS_LIMIT = 200;
const CONTACT_BATCH = 20;

const CONTACT_FIELDS = [
  Contacts.ContactField.FULL_NAME,
  Contacts.ContactField.PHONES,
] as const;

/**
 * How many of each follow's own follows are read when working out mutual connections.
 *
 * What bounds the suggestions query, along with `FOLLOWS_TO_SCAN`. A collection query is billed per document
 * returned, so this is the number that decides whether opening the screen costs tens of reads or thousands.
 * Capped well under the account's real follow count on purpose: the newest connections are the likeliest to
 * have introduced anybody new, so the tail a high-follow account is missing is the least interesting part.
 */
const FOLLOWS_PER_SCAN = 100;

function openProfile(uid: string, name: string) {
  router.push({ params: { name, uid }, pathname: '/user/[uid]' } as never);
}

/** The name and picture off a profile document, in the order this app has always preferred them. */
function readPerson(data: UserData): Person {
  return {
    displayName: getString(data, PERSON_NAME_KEYS, 'Someone new'),
    photoUrl: getString(data, PERSON_PHOTO_KEYS),
  };
}

/**
 * Profiles for a list of uids, in as few reads as Firestore will allow.
 *
 * `where(documentId(), 'in', ...)` rather than a read per uid. The difference is not a style preference:
 * a profile read per suggestion is twelve reads for twelve suggestions, and a contact sync does the same
 * again for every match, which is the shape of an N+1 that gets worse exactly when a screen is already
 * doing work. Firestore caps a single `in` at 30 values, so a longer list is chunked -- 30 is the documented
 * limit for one disjunctive filter.
 *
 * A uid with no profile is simply absent from the result rather than mapped to a placeholder, because every
 * caller here draws the person and has nothing sensible to draw for somebody who does not exist.
 */
async function loadPeople(uids: string[]): Promise<Record<string, Person>> {
  const unique = [...new Set(uids.filter((uid) => uid !== ''))];
  const people: Record<string, Person> = {};

  if (unique.length === 0) {
    return people;
  }

  const chunks: string[][] = [];

  for (let start = 0; start < unique.length; start += 30) {
    chunks.push(unique.slice(start, start + 30));
  }

  await Promise.all(chunks.map(async (chunk) => {
    try {
      const snapshot = await getDocs(query(
        collection(getFirebaseDb(), 'users'),
        where(documentId(), 'in', chunk),
      ));

      snapshot.forEach((profileDocument) => {
        people[profileDocument.id] = readPerson(profileDocument.data() as UserData);
      });
    } catch (error) {
      // A chunk that cannot be read leaves those people undrawn. One unreadable batch of profiles is not a
      // failed screen, and there is nothing actionable to show the reader about it.
      console.warn('Could not read some profiles:', error);
    }
  }));

  return people;
}

/** Reads the address book, and asks first. Returns the error rather than raising it. */
async function readAddressBook() {
  const empty = [] as { name: string; phone: string }[];

  const { status } = await Contacts.requestPermissionsAsync();

  if (status !== 'granted') {
    return {
      contacts: empty,
      error: 'Allow access to your contacts to see who you already know.',
    };
  }

  const container = await Contacts.Container.getDefault();
  const groups = container ? await container.getGroups() : [];
  const group = groups[0];

  if (!container || !group) {
    return { contacts: empty, error: 'This device has no contacts to look through.' };
  }

  const entries = await group.getContacts({
    limit: CONTACTS_LIMIT,
    sortOrder: Contacts.ContactsSortOrder.FamilyName,
  });

  // One detail read per contact rather than asking for the fields on the list: expo-contacts does not
  // return the field values until a contact is asked for them individually, which is why this is the
  // slow part of a sync and why the list is bounded.
  const contacts = await Promise.all(entries.map(async (contact) => {
    const details = await contact.getDetails(CONTACT_FIELDS);
    const [phone] = details.phones ?? [];

    return { name: details.fullName || '', phone: phone?.number ?? '' };
  }));

  return {
    contacts: contacts.filter((contact) => contact.name !== '' && contact.phone !== ''),
    error: '',
  };
}

export default function FindFriendsScreen() {
  // Read during render the same way the rest of the app does it, rather than mirrored into state by an
  // effect on mount: the session is already resolved by the time a tab under the auth gate renders, and a
  // copy in state can only ever be one render out of date.
  const currentUid = getFirebaseAuth().currentUser?.uid ?? '';

  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState<Candidate[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  const [incoming, setIncoming] = useState<FriendRequestId[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequestId[]>([]);
  const [friendIds, setFriendIds] = useState<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());
  // Who an outgoing request actually went to. The request document stamps the *sender's* name and photo,
  // so nothing on the document names the recipient, and reading it back is what this holds.
  const [outgoingPeople, setOutgoingPeople] = useState<Record<string, Person>>({});

  const [contactMatches, setContactMatches] = useState<Candidate[]>([]);
  const [isSyncingContacts, setIsSyncingContacts] = useState(false);
  const [contactsMessage, setContactsMessage] = useState('');
  const [hasSyncedContacts, setHasSyncedContacts] = useState(false);

  const [suggested, setSuggested] = useState<Candidate[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  /**
   * The relationships, loaded once and then watched.
   *
   * Two listeners rather than one query over everything: "sent to me" and "sent by me" are different
   * questions, one query cannot be filtered for both, and the rules refuse a request query that does not
   * narrow to one of the two.
   */
  useEffect(() => {
    if (!currentUid) {
      return undefined;
    }

    void (async () => {
      setFriendIds(await loadFriendIds(currentUid));
      setPendingIds(await loadPendingRequestIds(currentUid));
      setFollowedIds(await loadFollowIds(currentUid));
    })();

    const unsubscribeIncoming = subscribeToIncomingFriendRequests(currentUid, setIncoming);
    const unsubscribeOutgoing = subscribeToOutgoingFriendRequests(currentUid, setOutgoing);

    return () => {
      unsubscribeIncoming();
      unsubscribeOutgoing();
    };
  }, [currentUid]);

  /**
   * Names and pictures for the people an outgoing request went to.
   *
   * A request document stamps `fromName` and `fromPhotoUrl`, which is the *sender* -- from this account's
   * point of view. So there is nothing on the document naming who it was sent to, and a "Sent" list built
   * from it alone can only show a placeholder. That is what it did: every row said "Someone you added" with
   * a letter avatar, which is a list a sender cannot use to tell two pending requests apart.
   *
   * Keyed by uid and merged into the existing map rather than replaced, so a listener event that changes one
   * request's status does not blank the names of the others while their reads are in flight.
   */
  useEffect(() => {
    // Which recipients still have no name resolved. Reading `outgoingPeople` here is the point -- it is what
    // stops the effect re-reading a profile it already has -- and it is a state read rather than a write, so
    // depending on it re-runs the effect only when a name has just been added, at which point `wanted` is
    // empty and it returns immediately.
    const wanted = [...new Set(outgoing
      .map((row) => row.request.to)
      .filter((uid) => uid !== '' && outgoingPeople[uid] === undefined))];

    if (wanted.length === 0) {
      return undefined;
    }

    let isCancelled = false;

    void (async () => {
      const people = await loadPeople(wanted);

      if (isCancelled) {
        return;
      }

      // Merged rather than replaced, so a listener event that changes one request's status does not blank
      // the names of the others while their reads are in flight.
      setOutgoingPeople((current) => ({ ...current, ...people }));
    })();

    return () => {
      isCancelled = true;
    };
  }, [outgoing, outgoingPeople]);

  /**
   * Accounts this one might know: the people its own follows also follow.
   *
   * One read per follow, capped, and only for accounts this one already follows -- which the rules allow
   * it to read and which no stranger's list is readable for. That is the whole constraint here, and it is
   * why the suggestions are as narrow as they are: the app has no server that could work this out for
   * every account.
   *
   * The exclusion of people already connected is not done here. It used to be -- this read
   * `loadFriendIds` and `loadPendingRequestIds` a second time, on top of the copy the mount effect already
   * holds, so one pull-to-refresh performed the same two reads three times and could disagree with what the
   * rest of the screen believes. `connectedIds` already unions all of it, including incoming requests and
   * follows, and the render filters against that, so the filter belongs in one place.
   */
  const loadSuggestions = useCallback(async () => {
    if (!currentUid) {
      return;
    }

    const db = getFirebaseDb();

    try {
      const followed = await loadFollowIds(currentUid);

      const followedLists = await Promise.all([...followed].slice(0, FOLLOWS_TO_SCAN).map(async (uid) => {
        try {
          // Bounded per follow list. A collection query is billed one read per document it returns, not
          // one per query, so an unbounded read of somebody with 800 follows costs 800 -- times the 20
          // accounts scanned here. The cap costs a few weaker suggestions for an account that follows
          // hundreds of people, which is a much better trade than a few thousand reads on every visit.
          const snapshot = await getDocs(query(
            collection(db, 'users', uid, 'following'),
            firestoreLimit(FOLLOWS_PER_SCAN),
          ));

          return snapshot.docs.map((followDocument) => followDocument.id);
        } catch {
          // One follow list that cannot be read is a few missing suggestions, not a failed screen. The
          // rules already refuse this for accounts this one does not follow, which is the point.
          return [];
        }
      }));

      const mutualCounts = new Map<string, number>();

      followedLists.flat().forEach((uid) => {
        // This account itself, and everybody already followed, are not suggestions however many people
        // follow them.
        if (uid !== currentUid && !followed.has(uid)) {
          mutualCounts.set(uid, (mutualCounts.get(uid) ?? 0) + 1);
        }
      });

      const ranked = [...mutualCounts.entries()]
        // Most shared follows first, so the strongest suggestion is the one at the top rather than
        // whichever uid happened to sort first.
        .sort((first, second) => second[1] - first[1])
        .slice(0, SUGGESTION_LIMIT);

      // One chunked query for the profiles rather than one read per suggestion.
      const profiles = await loadPeople(ranked.map(([uid]) => uid));

      setSuggested(ranked
        .map(([uid, mutualCount]): Candidate | null => {
          const person = profiles[uid];

          return person ? { ...person, id: uid, mutualCount, source: 'suggested' } : null;
        })
        .filter((row): row is Candidate => row !== null));
    } catch (error) {
      console.error('Could not work out who to suggest:', error);
      setErrorMessage('Could not load suggestions.');
    }
  }, [currentUid]);

  // Suggestions are fetched on open as well as on pull-to-refresh. The rule this trips is aimed at an
  // effect mirroring its own props into state; this one is reading data this component does not have yet.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a first load of remote data, not derived state.
    void loadSuggestions();
  }, [loadSuggestions]);

  /**
   * Finds accounts whose name begins with what was typed.
   *
   * A range rather than a filter, because Firestore has no "contains" for a string: the closest it offers
   * is "at or after this prefix" and "before the next one", which is what `startAt`/`endAt` are here. It
   * cannot find somebody in the middle of a name, and the empty state below says exactly that.
   *
   * Debounced, because each of these is a query somebody pays for and somebody typing "Alexandra" should
   * cost one read rather than nine.
   */
  useEffect(() => {
    const trimmed = searchText.trim();

    if (!currentUid || trimmed.length < 2) {
      // Nothing to look for. The results are cleared by the change handler below rather than here, because
      // an effect cannot tell "the results are stale" from "the results are current" and blanking the list
      // mid-keystroke is worse than holding the last good results for a beat.
      return undefined;
    }

    let isCancelled = false;

    const timer = setTimeout(() => {
      void (async () => {
        setIsSearching(true);
        setSearchError('');

        try {
          const snapshot = await getDocs(query(
            collection(getFirebaseDb(), 'users'),
            orderBy('displayName'),
            startAt(trimmed),
            endAt(`${trimmed}\uf8ff`),
            firestoreLimit(SEARCH_LIMIT),
          ));

          const rows: Candidate[] = [];

          snapshot.docs.forEach((userDocument) => {
            if (userDocument.id === currentUid) {
              return;
            }

            rows.push({
              ...readPerson(userDocument.data() as UserData),
              id: userDocument.id,
              mutualCount: 0,
              source: 'search',
            });
          });

          if (!isCancelled) {
            setSearchResults(rows);
          }
        } catch (error) {
          console.error('Could not search for people:', error);

          if (!isCancelled) {
            setSearchResults([]);
            setSearchError('Could not search right now. Please try again.');
          }
        } finally {
          if (!isCancelled) {
            setIsSearching(false);
          }
        }
      })();
    }, 300);

    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
  }, [currentUid, searchText]);

  /**
   * Typing clears the last results once there is nothing left to search for.
   *
   * One character is not a query, so a single letter should not leave somebody's previous results sitting
   * under the box. Going the other way, shortening "Ali" to "Al" holds the old results until the new
   * query comes back, which is what stops the list flickering empty between keystrokes.
   */
  const onSearchChange = useCallback((text: string) => {
    setSearchText(text);

    if (text.trim().length < 2) {
      setSearchResults([]);
      setSearchError('');
      setIsSearching(false);
    }
  }, []);

  /**
   * Matches the address book against the index, and publishes this account's own numbers so that the next
   * person's sync can find it.
   *
   * Behind a button rather than on mount. This asks for the whole address book, which is the largest
   * single permission this app can request, and a screen that asks for it the moment it opens is a screen
   * that gets it refused and never offers again.
   *
   * Publishing is what makes the feature two-sided: without it this account would find its own contacts
   * and never be found by them.
   */
  const syncContacts = useCallback(async () => {
    if (!currentUid || isSyncingContacts) {
      return;
    }

    setIsSyncingContacts(true);
    setContactsMessage('');

    try {
      const { contacts, error } = await readAddressBook();

      if (error) {
        setContactsMessage(error);
        setHasSyncedContacts(true);

        return;
      }

      if (contacts.length === 0) {
        setContactsMessage('No contacts with a phone number were found on this device.');
        setHasSyncedContacts(true);

        return;
      }

      // Nothing is published here, and that is deliberate rather than a missing feature.
      //
      // Matching is safe in one direction: a client can only ask about a number it already has, so reading
      // the index reveals nothing it did not start with. Publishing is the other direction, and it is not
      // safe yet. The index is a plain SHA-256 of the last nine digits with no pepper (see
      // src/lib/phone-index.ts), so every number written there is confirmable offline from a short
      // candidate list, and writing other people's numbers would both leak an address book and attribute
      // each contact to the wrong account.
      //
      // Publishing only this account's own number needs two things that do not exist yet: phone
      // verification, so the number is known to belong to the account rather than typed into a form, and a
      // server-side pepper, so the hash cannot be reversed by whoever can read the collection. Until both
      // are in place this screen finds people but is not findable, which is the safe half to ship.
      const matches: ContactMatch[] = [];

      // In batches so the screen yields between them and the spinner keeps turning, rather than the whole
      // address book being read in one pass with nothing on screen until it is finished.
      for (let start = 0; start < contacts.length; start += CONTACT_BATCH) {
        const batch = contacts.slice(start, start + CONTACT_BATCH);

        // Serial on purpose: a few hundred reads at once is a burst of traffic and a memory spike for no
        // wall-clock gain on a screen that is showing a spinner the whole time.
        matches.push(...await matchContactsToAccounts(currentUid, batch));
      }

      // One chunked query for every matched profile rather than a read per match, which on a real address book
      // is a few dozen reads for a feature that only needs the names and pictures.
      const matchedPeople = await loadPeople(matches.map((match) => match.matchedUid));

      setContactMatches(matches
        .map((match): Candidate | null => {
          const person = matchedPeople[match.matchedUid];

          return person ? {
            ...person,
            contactName: match.contactName,
            id: match.matchedUid,
            mutualCount: 0,
            source: 'contact',
          } : null;
        })
        .filter((row): row is Candidate => row !== null));
      setHasSyncedContacts(true);
    } catch (error) {
      console.error('Could not match the contacts:', error);
      setContactsMessage('Could not read your contacts. Please try again.');
      setHasSyncedContacts(true);
    } finally {
      setIsSyncingContacts(false);
    }
  }, [currentUid, isSyncingContacts]);

  /** Sends a request and moves the row to "sent" without re-reading anything. */
  const addFriend = useCallback(async (candidate: Candidate) => {
    if (!currentUid || busyId) {
      return;
    }

    setBusyId(candidate.id);
    setErrorMessage('');

    try {
      await sendFriendRequest(candidate.id);
      setPendingIds((current) => new Set(current).add(candidate.id));
    } catch (error) {
      console.error('Could not send the friend request:', error);
      setErrorMessage('Could not send that request. Please try again.');
    } finally {
      setBusyId('');
    }
  }, [busyId, currentUid]);

  const accept = useCallback(async (row: FriendRequestId) => {
    if (busyId) {
      return;
    }

    setBusyId(row.id);
    setErrorMessage('');

    try {
      await answerFriendRequest(row.id, 'accepted');
      setFriendIds((current) => new Set(current).add(row.request.from));
    } catch (error) {
      console.error('Could not accept the friend request:', error);
      setErrorMessage('Could not accept that request.');
    } finally {
      setBusyId('');
    }
  }, [busyId]);

  const decline = useCallback(async (row: FriendRequestId) => {
    if (busyId) {
      return;
    }

    setBusyId(row.id);
    setErrorMessage('');

    try {
      await answerFriendRequest(row.id, 'declined');
    } catch (error) {
      console.error('Could not decline the friend request:', error);
      setErrorMessage('Could not decline that request.');
    } finally {
      setBusyId('');
    }
  }, [busyId]);

  const takeBack = useCallback((row: FriendRequestId) => {
    void cancelFriendRequest(row.id).then(() => {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(row.request.to);
        return next;
      });
    }).catch((error) => {
      console.error('Could not take back the request:', error);
      setErrorMessage('Could not take that request back.');
    });
  }, []);

  /**
   * Requests still worth showing.
   *
   * A declined one is left in the data rather than deleted -- that is what lets the sender see the answer
   * -- but there is no reason to keep offering the receiver buttons for it, and a row per declined request
   * is a list of strangers that only grows.
   *
   * An accepted one is dropped for the same reason, and it is filtered on the accepted status rather than
   * on the live listener's contents: the Firestore listener keeps delivering the document after it is
   * answered, so accepting a request left its row sitting under the heading with working Accept and Decline
   * buttons, and tapping Accept again re-answered an already-answered request. `pending` and `accepted` are
   * the two states that want an action; `declined` does not.
   */
  const pendingIncoming = useMemo(
    () => incoming.filter((row) => row.request.status === 'pending'),
    [incoming],
  );

  /**
   * Requests this account sent, and what became of them.
   *
   * Every state is rendered, which is the whole point of declining rather than deleting: a sender who gets
   * no answer learns nothing, so "Request declined" is shown as a dead row with no buttons. Filtering to
   * `pending` -- which is what this did at first -- threw that away and made a decline look like the
   * request vanishing, even though the document was still there waiting to be read.
   */
  const settledOutgoing = useMemo(
    () => outgoing.filter((row) => row.request.status === 'pending' || row.request.status === 'declined'),
    [outgoing],
  );

  /**
   * Everybody this account already has a relationship with.
   *
   * Four sets, because there are four ways to already be connected, and a candidate list filtered against
   * only some of them offers an "Add" button that cannot work:
   *
   *   friends   - accepted, so there is nothing left to ask for
   *   pending   - asked and not yet answered, in either direction
   *   incoming  - somebody who has asked *us*. This one was the expensive omission: `pendingIds` is built
   *               from `where('from','==',uid)`, which is outgoing only, so a person who had already sent
   *               a request still showed as a candidate. Tapping Add merged `from`/`to` onto the shared
   *               pair document and the rules refused it, so it always failed with permission-denied --
   *               and had the rules been laxer it would have overwritten their request and left them
   *               unable to accept it.
   *   following - already followed, which the People screen treats as the connect action, so an Add button
   *               on somebody already followed contradicts it
   *
   * One set rather than four tests at each filter site, because the next kind of relationship added later
   * would otherwise be remembered at one call site and not the others.
   */
  const connectedIds = useMemo(() => {
    const connected = new Set<string>([...friendIds, ...pendingIds, ...followedIds]);

    incoming.forEach((row) => connected.add(row.request.from));

    return connected;
  }, [friendIds, followedIds, incoming, pendingIds]);

  const trimmedSearch = searchText.trim();

  /**
   * The candidate lists, merged and de-duplicated.
   *
   * Contacts first, then the search, then suggestions: the strongest signal is the one that was not typed
   * by hand. A person found three ways is shown once, under the first of those.
   */
  const sections = useMemo(() => {
    const seen = new Set<string>();

    const take = (rows: Candidate[]) => rows.filter((row) => {
      if (seen.has(row.id) || connectedIds.has(row.id)) {
        return false;
      }

      seen.add(row.id);

      return true;
    });

    return [
      { data: take(contactMatches), key: 'contacts', title: 'People in your contacts' },
      { data: take(searchResults), key: 'search', title: 'Search results' },
      { data: take(suggested), key: 'suggested', title: 'Suggested for you' },
    ].filter((section) => section.data.length > 0);
  }, [connectedIds, contactMatches, searchResults, suggested]);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    setErrorMessage('');

    if (currentUid) {
      setFriendIds(await loadFriendIds(currentUid));
      setPendingIds(await loadPendingRequestIds(currentUid));
    }

    await loadSuggestions();
    setIsRefreshing(false);
  }, [currentUid, loadSuggestions]);

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <View style={styles.screen}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>FIND PEOPLE</Text>
            <Text style={styles.title}>Add friends</Text>
          </View>
          <Pressable
            accessibilityLabel="Refresh suggestions"
            accessibilityRole="button"
            onPress={() => void refresh()}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          >
            <Ionicons color="#363A42" name="refresh" size={20} />
          </Pressable>
        </View>

        {/*
          The placeholder says "by name" and the empty state below explains that names are matched from the
          first letter. Claiming to search every name and then finding nobody whose name merely starts with
          what was typed is how a reader decides the search is broken.
        */}
        <View style={styles.search}>
          <Ionicons color="#8D929C" name="search" size={17} />
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={onSearchChange}
            placeholder="Search by name"
            placeholderTextColor="#8D929C"
            returnKeyType="search"
            style={styles.searchInput}
            value={searchText}
          />
          {isSearching ? <ActivityIndicator color="#E56B4C" size="small" /> : null}
        </View>

        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
        {searchError ? <Text style={styles.error}>{searchError}</Text> : null}

        <FlatList
          contentContainerStyle={styles.list}
          data={sections}
          keyExtractor={(section) => section.key}
          ListEmptyComponent={(
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>
                {trimmedSearch.length >= 2 ? 'Nobody matches that' : 'No suggestions yet'}
              </Text>
              <Text style={styles.emptyText}>
                {trimmedSearch.length >= 2
                  ? 'Names are matched from their first letter, so try the beginning of the name you want.'
                  : 'Suggestions come from the people you follow, and the people they follow too.'}
              </Text>
            </View>
          )}
          ListHeaderComponent={(
            <>
              {/* The requests sit above every candidate list. Somebody who has just asked to be a
                  friend's friend wants the answer at the top of the screen, not in a section below. */}
              {pendingIncoming.length > 0 ? (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Friend requests</Text>
                  {pendingIncoming.map((row) => (
                    <RequestRow
                      busy={busyId === row.id}
                      key={row.id}
                      name={row.request.fromName || 'Someone'}
                      onAccept={() => void accept(row)}
                      onDecline={() => void decline(row)}
                      onOpen={() => openProfile(row.request.from, row.request.fromName || 'Someone')}
                      photoUrl={row.request.fromPhotoUrl || ''}
                      subtitle="wants to be your friend"
                    />
                  ))}
                </View>
              ) : null}

              {settledOutgoing.length > 0 ? (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Sent</Text>
                  {settledOutgoing.map((row) => {
                    const declined = row.request.status === 'declined';
                    // Falls back to the placeholder only until the profile read lands, which is a frame or
                    // two, rather than permanently. There is deliberately no `row.request.to === currentUid`
                    // case: these rows come from `where('from','==',uid)`, so `to` is always the other person.
                    const person = outgoingPeople[row.request.to];

                    return (
                      <RequestRow
                        busy={false}
                        key={row.id}
                        name={person?.displayName || 'Someone you added'}
                        onCancel={declined ? undefined : () => takeBack(row)}
                        onOpen={() => openProfile(
                          row.request.to,
                          person?.displayName || 'Someone you added',
                        )}
                        photoUrl={person?.photoUrl || ''}
                        subtitle={declined ? 'Request declined' : 'waiting for an answer'}
                      />
                    );
                  })}
                </View>
              ) : null}

              {/* Contacts behind a button, not on open: reading the address book is the biggest ask this
                  app makes, and asking for it before anybody has asked to find anybody is how a permission
                  gets refused for good. */}
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Your contacts</Text>
                <Pressable
                  accessibilityLabel="Find people in my contacts"
                  accessibilityRole="button"
                  disabled={isSyncingContacts}
                  onPress={() => void syncContacts()}
                  style={({ pressed }) => [styles.syncRow, pressed && styles.pressed]}
                >
                  <View style={styles.syncIcon}>
                    <Ionicons color="#3D765B" name="people" size={19} />
                  </View>
                  <View style={styles.syncCopy}>
                    <Text style={styles.syncTitle}>
                      {isSyncingContacts
                        ? 'Looking through your contacts...'
                        : hasSyncedContacts && contactMatches.length === 0
                          ? 'Check again'
                          : 'Find people I know'}
                    </Text>
                    <Text style={styles.syncMeta}>
                      {isSyncingContacts
                        ? 'Matching your contacts against this app'
                        : contactsMessage
                          || (hasSyncedContacts
                            ? 'Nobody in your contacts has an account here'
                            : 'Uses your contacts to suggest people')}
                    </Text>
                  </View>
                  {isSyncingContacts ? (
                    <ActivityIndicator color="#E56B4C" size="small" />
                  ) : (
                    <Ionicons color="#8D929C" name="chevron-forward" size={18} />
                  )}
                </Pressable>
              </View>
            </>
          )}
          refreshControl={(
            <RefreshControl onRefresh={() => void refresh()} refreshing={isRefreshing} tintColor="#E56B4C" />
          )}
          renderItem={({ item: section }) => (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              {section.data.map((candidate) => (
                <CandidateRow
                  busy={busyId === candidate.id}
                  candidate={candidate}
                  key={candidate.id}
                  onAdd={() => void addFriend(candidate)}
                  onOpen={() => openProfile(candidate.id, candidate.displayName)}
                />
              ))}
            </View>
          )}
          showsVerticalScrollIndicator={false}
        />
      </View>
    </SafeAreaView>
  );
}

/** One person to send a request to. */
function CandidateRow({
  busy,
  candidate,
  onAdd,
  onOpen,
}: {
  busy: boolean;
  candidate: Candidate;
  onAdd: () => void;
  onOpen: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={`Open ${candidate.displayName}`}
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.avatarWrap}>
        <PersonAvatar name={candidate.displayName} photoUrl={candidate.photoUrl || undefined} size={52} />
      </View>

      <View style={styles.rowCopy}>
        <Text numberOfLines={1} style={styles.rowName}>{candidate.displayName}</Text>
        {/* Why this person is on the screen at all, which is the question a list of strangers cannot
            answer by itself. */}
        <Text numberOfLines={1} style={styles.rowMeta}>
          {candidate.source === 'contact'
            ? `In your contacts as ${candidate.contactName}`
            : candidate.source === 'search'
              ? 'Matches your search'
              : candidate.mutualCount > 0
                ? `${candidate.mutualCount} mutual ${candidate.mutualCount === 1 ? 'friend' : 'friends'}`
                : 'On this app'}
        </Text>
      </View>

      <Pressable
        accessibilityLabel={`Send ${candidate.displayName} a friend request`}
        accessibilityRole="button"
        disabled={busy}
        onPress={onAdd}
        style={({ pressed }) => [styles.addChip, pressed && styles.pressed]}
      >
        {busy ? (
          <ActivityIndicator color="#FFFFFF" size="small" />
        ) : (
          <Text style={styles.addChipText}>Add</Text>
        )}
      </Pressable>
    </Pressable>
  );
}

/** A request somebody sent, or one this account sent and is waiting on. */
function RequestRow({
  busy,
  name,
  onAccept,
  onCancel,
  onDecline,
  onOpen,
  photoUrl,
  subtitle,
}: {
  busy: boolean;
  name: string;
  onAccept?: () => void;
  onCancel?: () => void;
  onDecline?: () => void;
  onOpen: () => void;
  photoUrl: string;
  subtitle: string;
}) {
  return (
    <View style={styles.row}>
      <Pressable onPress={onOpen} style={styles.requestIdentity}>
        <View style={styles.avatarWrap}>
          <PersonAvatar name={name} photoUrl={photoUrl || undefined} size={52} />
        </View>
        <View style={styles.rowCopy}>
          <Text numberOfLines={1} style={styles.rowName}>{name}</Text>
          <Text numberOfLines={1} style={styles.rowMeta}>{subtitle}</Text>
        </View>
      </Pressable>

      {onAccept && onDecline ? (
        <View style={styles.requestActions}>
          <Pressable
            accessibilityLabel={`Decline ${name}`}
            accessibilityRole="button"
            disabled={busy}
            onPress={onDecline}
            style={({ pressed }) => [styles.declineChip, pressed && styles.pressed]}
          >
            <Text style={styles.declineChipText}>Decline</Text>
          </Pressable>
          <Pressable
            accessibilityLabel={`Accept ${name}`}
            accessibilityRole="button"
            disabled={busy}
            onPress={onAccept}
            style={({ pressed }) => [styles.addChip, pressed && styles.pressed]}
          >
            {busy ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Text style={styles.addChipText}>Accept</Text>
            )}
          </Pressable>
        </View>
      ) : onCancel ? (
        <Pressable
          accessibilityLabel="Take this request back"
          accessibilityRole="button"
          onPress={onCancel}
          style={({ pressed }) => [styles.declineChip, pressed && styles.pressed]}
        >
          <Text style={styles.declineChipText}>Take back</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  screen: {
    flex: 1,
    paddingHorizontal: 22,
    paddingTop: 18,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  eyebrow: {
    color: '#E56B4C',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  title: {
    color: '#20232A',
    fontSize: 27,
    fontWeight: '800',
  },
  iconButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 21,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  search: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
    paddingHorizontal: 12,
  },
  searchInput: {
    color: '#20232A',
    flex: 1,
    fontSize: 15,
    paddingVertical: 11,
  },
  error: {
    color: '#C0392B',
    fontSize: 13,
    marginBottom: 10,
  },
  list: {
    paddingBottom: 130,
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    color: '#363A42',
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 8,
  },
  row: {
    alignItems: 'center',
    borderBottomColor: '#E7E2DA',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    minHeight: 74,
    paddingVertical: 11,
  },
  pressed: {
    opacity: 0.72,
  },
  avatarWrap: {
    height: 52,
    marginRight: 13,
    width: 52,
  },
  rowCopy: {
    flex: 1,
    minWidth: 0,
  },
  rowName: {
    color: '#20232A',
    fontSize: 15,
    fontWeight: '800',
  },
  rowMeta: {
    color: '#777C84',
    fontSize: 12,
    marginTop: 3,
  },
  requestIdentity: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    minWidth: 0,
  },
  requestActions: {
    flexDirection: 'row',
    gap: 8,
    marginLeft: 8,
  },
  addChip: {
    alignItems: 'center',
    backgroundColor: '#E56B4C',
    borderRadius: 999,
    justifyContent: 'center',
    marginLeft: 8,
    minWidth: 68,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  addChipText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  declineChip: {
    alignItems: 'center',
    borderColor: '#C9C3B8',
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  declineChipText: {
    color: '#656A73',
    fontSize: 13,
    fontWeight: '700',
  },
  syncRow: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 13,
  },
  syncIcon: {
    alignItems: 'center',
    backgroundColor: '#E8F1EC',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  syncCopy: {
    flex: 1,
    minWidth: 0,
  },
  syncTitle: {
    color: '#20232A',
    fontSize: 14,
    fontWeight: '800',
  },
  syncMeta: {
    color: '#777C84',
    fontSize: 12,
    marginTop: 2,
  },
  emptyState: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 30,
  },
  emptyTitle: {
    color: '#20232A',
    fontSize: 17,
    fontWeight: '800',
  },
  emptyText: {
    color: '#777C84',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 7,
    textAlign: 'center',
  },
});