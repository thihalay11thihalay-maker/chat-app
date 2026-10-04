import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  collection,
  documentId,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  where,
} from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PersonAvatar } from '@/components/person-avatar';
import { readRoomKind, readRoomPrivacy, RoomKind, markRoomsRead } from '@/lib/chat-rooms';
import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';
import { loadFollowIds } from '@/lib/follow';
import { MockChat, MOCK_CHATS } from '@/lib/mock-chats';
import { PresenceMap, subscribeToPresence } from '@/lib/presence';
import { subscribeToTyping } from '@/lib/typing';
import { getString, PERSON_NAME_KEYS, PERSON_PHOTO_KEYS } from '@/lib/user-data';

type FilterKey = 'All' | 'Friends' | 'Group chats' | 'Channel' | 'Message requests';

const FILTERS: FilterKey[] = ['All', 'Friends', 'Group chats', 'Channel', 'Message requests'];

/** `in` accepts at most 30 values, so the profile lookup is chunked rather than sent in one query. */
const IN_CHUNK_SIZE = 30;

/** Stands in for "nothing loaded", so the derived lookups keep a stable identity between reads. */
const EMPTY_PEOPLE: Record<string, Person> = {};
const EMPTY_FRIENDS = new Set<string>();
const EMPTY_ROOMS: ChatRoom[] = [];

/**
 * A chat room document from `chats`.
 *
 * Only the fields this screen reads are typed. The rest of the room (a group name, an avatar per
 * participant) is read from `users` or defaulted, so a room written by an older build still lists.
 */
type ChatRoom = {
  id: string;
  /** uids, in whatever order they were written. The other person is whoever is not you. */
  participants: string[];
  lastMessage?: string;
  lastMessageTime?: Timestamp | null;
  lastMessageSenderId?: string;
  /**
   * A group's name, written when the room is created from the people invited to it. Absent on a
   * direct chat, which is titled by the other participant, and on a room written before groups
   * existed.
   */
  name?: string;
  /**
   * `group`, `channel` or `direct`, written when the room is created. Absent on rooms written before
   * kinds existed, where the kind is worked out from the participant count instead. See readRoomKind.
   */
  kind?: RoomKind;
  /**
   * `public` or `private`, written when the room is created and changed from its profile. Absent on
   * rooms written before rooms could be closed, where every room is public. See readRoomPrivacy.
   */
  privacy?: string;
  /**
   * Unread per participant, because one number cannot be right for two people reading the same
   * room. `unreadCount` is accepted as the older single-number shape.
   */
  unreadCounts?: Record<string, number>;
  unreadCount?: number;
  /** Who started the room. A one-to-one started by somebody else is a message request until it is answered. */
  ownerId?: string;
};

type Person = {
  avatar: string;
  name: string;
};

/** A row in the list: the room plus everything read about it from elsewhere. */
type ChatListItem = {
  avatar: string;
  chatId: string;
  /** Empty for a group or channel, which have no single other person. */
  otherUserId: string;
  id: string;
  /**
   * Whether this account follows the other person. The inbox calls that a friend, which is what the
   * row has always called it here, and it is the one relationship the app has: there is no separate
   * friends list, because a second one could disagree with the follow list that a restricted post's
   * audience is actually built from.
   */
  isFriend: boolean;
  isGroup: boolean;
  /**
   * A one-to-one somebody else started, where they wrote last and this account has not answered.
   *
   * That is what "a message request" means here, and it is worked out from what the room document
   * already holds rather than from a request flag: this app has no accept step, so an unopened
   * conversation from somebody else is the honest thing a request can mean. A room this account
   * started is not a request -- the first move was its own.
   */
  isRequest: boolean;
  /**
   * A room only the people in it can find. Drawn on the row because whether a link still lets somebody
   * in is the one thing about a room a reader has to know before offering it to anybody else, and the
   * answer is a setting on the room's own profile two taps away.
   */
  isPrivate: boolean;
  /** A channel is a room too, but it has a tab of its own. This is which of the two room tabs a row belongs to. */
  isChannel: boolean;
  isOnline: boolean;
  lastMessage: string;
  name: string;
  time: string;
  unread: number;
};

function toCount(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function toMillis(value: unknown) {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  return 0;
}

/**
 * "10m ago", the way a conversation list reads. Recent enough gets minutes, then hours, then days,
 * and past a week a date, because "6d ago" stops being a useful thing to say about a conversation.
 */
function toRelativeTime(value: unknown) {
  const millis = toMillis(value);

  if (!millis) {
    return '';
  }

  const seconds = Math.floor((Date.now() - millis) / 1000);

  if (seconds < 60) {
    return 'now';
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);

  if (days < 7) {
    return `${days}d ago`;
  }

  return new Date(millis).toLocaleDateString();
}

/** Keeps the preview to one line's worth without cutting mid-word where it can be avoided. */
function truncate(text: string, limit = 80) {
  const collapsed = text.replace(/\s+/g, ' ').trim();

  if (collapsed.length <= limit) {
    return collapsed;
  }

  const cut = collapsed.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');

  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** The uids in a participants array, accepting either bare ids or `{ uid }` objects. */
function toParticipantIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry === 'string') {
      return [entry];
    }

    if (entry && typeof entry === 'object' && 'uid' in entry) {
      const { uid } = entry as { uid: unknown };

      return typeof uid === 'string' ? [uid] : [];
    }

    return [];
  });
}

/**
 * Reads the people named by the current list of rooms.
 *
 * One chunked `in` query rather than a `getDoc` per row: a list of forty rooms would otherwise be
 * forty reads, and the rules allow any signed-in user to read a profile, so a single batched query
 * is both faster and within what the rules permit. Returns a map so a missing profile is a missing
 * entry rather than a broken row.
 */
function usePeople(userIds: string[]) {
  const [people, setPeople] = useState<Record<string, Person>>(EMPTY_PEOPLE);
  // The ids sorted so the same set in a different order does not restart the query on every
  // snapshot, which would re-read every profile each time any room changed.
  const key = useMemo(() => [...new Set(userIds)].sort().join(','), [userIds]);

  useEffect(() => {
    const ids = key ? key.split(',') : [];

    // Nothing to read. The empty value is returned during render below rather than pushed through
    // state here, so a sign-out does not cost an extra render.
    if (ids.length === 0) {
      return undefined;
    }

    let cancelled = false;

    void (async () => {
      const next: Record<string, Person> = {};

      for (let index = 0; index < ids.length; index += IN_CHUNK_SIZE) {
        const chunk = ids.slice(index, index + IN_CHUNK_SIZE);

        try {
          const snapshot = await getDocs(
            query(collection(getFirebaseDb(), 'users'), where(documentId(), 'in', chunk)),
          );

          snapshot.forEach((document_) => {
            const data = document_.data() as Record<string, unknown>;

            // getString rather than hand-rolled chains, because this list and the profile screen, the
            // people-nearby screen, Find Friends and the friend-request writer all have to agree on which
            // field holds a name. These were separate implementations with separate rules, so a profile with
            // `profilePictureUrl: ''` and a real `photoURL` drew a letter initial here while every other
            // screen drew the picture -- and adding a field to one chain left the others behind.
            next[document_.id] = {
              avatar: getString(data, PERSON_PHOTO_KEYS),
              name: getString(data, PERSON_NAME_KEYS, 'Someone'),
            };
          });
        } catch (error) {
          // A profile that cannot be read leaves that row on its fallback rather than taking the
          // whole list down, which is what a throw out of this loop would do.
          console.error('Could not load chat participants:', error);
        }
      }

      if (!cancelled) {
        setPeople(next);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [key]);

  // Held back rather than cleared on the way out, so a sign-out cannot leave one room's participants
  // on screen while the rest of the list has already become a signed-out visitor's.
  return key ? people : EMPTY_PEOPLE;
}

/** The uids this account follows, which is what the Friends filter is built from. */
function useFriendIds(userId: string | undefined) {
  const [friendIds, setFriendIds] = useState<Set<string>>(EMPTY_FRIENDS);

  useEffect(() => {
    // No account means no follow list. The empty value comes from the return below instead of a
    // setState here.
    if (!userId) {
      return undefined;
    }

    let cancelled = false;

    // A follow list is not watched, so this runs once per sign-in rather than per snapshot. The read
    // itself lives in the follow module, because the profile screen asks the same question and a
    // second copy of it would answer differently after a press.
    void loadFollowIds(userId).then((ids) => {
      if (!cancelled) {
        setFriendIds(ids);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  return userId ? friendIds : EMPTY_FRIENDS;
}

/**
 * The list a filter leaves behind.
 *
 * Every filter except All and the two room tabs is about a *person*, so groups drop out of them: a
 * group is nobody's friend and nobody is waiting on a group to answer. Online and Offline used to be
 * filters here too, and are gone for good rather than waiting to be missed back: they were two ways
 * of asking the same question -- whether somebody is connected right now is a dot on the row, not a
 * place for the conversation to be, and a tab that empties every time somebody's phone sleeps is not
 * somewhere anybody keeps anything. Message requests take their place, which is a question about the
 * room rather than about the network.
 */
function filterItems(items: ChatListItem[], filter: FilterKey) {
  if (filter === 'All') {
    return items;
  }

  // Groups and channels are separate tabs, so they do not also share one: a channel listed under
  // Group chats would put the same room in front of somebody on two tabs, and the one thing that
  // tells them apart is who is allowed to post.
  if (filter === 'Group chats') {
    return items.filter((item) => item.isGroup && !item.isChannel);
  }

  if (filter === 'Channel') {
    return items.filter((item) => item.isChannel);
  }

  if (filter === 'Message requests') {
    return items.filter((item) => item.isRequest);
  }

  return items.filter((item) => !item.isGroup && item.isFriend);
}

/** What an emptied list says, so a tap does not look like a dead screen. */
const EMPTY_MESSAGE: Record<FilterKey, string> = {
  All: 'No conversations yet.',
  Friends: 'No chats with friends yet.',
  'Group chats': 'You have not joined any group chats.',
  Channel: 'You have not joined any channels.',
  'Message requests': 'No messages waiting for you.',
};

/**
 * How many conversations the inbox watches for typing signals.
 *
 * Comfortably more rows than any phone shows at once, so every row the reader can actually see is covered,
 * while the number of live listeners and expiry callbacks stays bounded whatever the account's history is.
 */
const TYPING_WINDOW = 40;

/**
 * Who is typing in which room, from the typing signals.
 *
 * One subscription per conversation, because that is the granularity the signals are stored at: the room
 * rules grant a read on `chats/{chatId}/typing` and not on the collection of them, so there is no one
 * subscription that covers the inbox.
 *
 * Scoped to the rooms actually on screen rather than the whole account, which is the part that matters. An
 * account with 200 conversations was opening 200 listeners the moment this tab mounted, and each one
 * registered its own expiry callback in the shared 2.5s sweep in typing.ts -- so the app ran 200 sweep
 * callbacks every 2.5 seconds for the entire time the inbox was open, to find out about rooms that were
 * scrolled off the top. The list is bounded here and re-subscribed when the filter changes, which is the same
 * set of rooms the reader can see a typing indicator against anyway.
 */
function useTypingRooms(roomIds: string[], selfUid: string | undefined) {
  const [typingByRoom, setTypingByRoom] = useState<Record<string, string[]>>({});

  // The ids as one string, so the subscription is not rebuilt on every snapshot of the room list.
  const key = roomIds.join(',');

  // Dropping signals for rooms that have left the list, rather than leaving them in the map. A row scrolled
  // out of view has no key, so it falls back to its message preview.
  const visibleKey = useMemo(() => new Set(key ? key.split(',') : []), [key]);

  useEffect(() => {
    // Presence of a visitor's own typing signal is never published, and there is nothing to read
    // without an account, so the state simply stays empty.
    if (!selfUid) {
      return undefined;
    }

    const unsubscribes = (key ? key.split(',') : []).map((chatId) => subscribeToTyping(
      chatId,
      selfUid,
      (typingUserIds) => {
        setTypingByRoom((current) => {
          const next = { ...current };

          // Removed rather than set to an empty array, so a room with nobody typing has no key at all
          // and the row falls back to its message preview.
          if (typingUserIds.length > 0) {
            next[chatId] = typingUserIds;
          } else {
            delete next[chatId];
          }

          return next;
        });
      },
    ));

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());

      // Whatever is left describes rooms that are no longer visible, so it is not state worth keeping.
      setTypingByRoom((current) => {
        const next: Record<string, string[]> = {};

        Object.entries(current).forEach(([room, ids]) => {
          if (visibleKey.has(room)) {
            next[room] = ids;
          }
        });

        return Object.keys(next).length === Object.keys(current).length ? current : next;
      });
    };
  }, [key, selfUid, visibleKey]);

  return typingByRoom;
}

/**
 * The mock rooms shown before sign-in, so the screen still has something to open.
 *
 * These ids are not Firestore documents, and `chat/[id].tsx` looks them up by id before it reaches
 * for Firestore, which is what tells a mock row and a real one apart.
 *
 * Nobody is ever online on a mock row: presence is only readable by a signed-in account, so there is
 * no honest way to put a dot on a placeholder, and the Online tab saying nobody is online is a
 * truer answer than inventing one.
 */
function toMockItems(): ChatListItem[] {
  return MOCK_CHATS.map((chat: MockChat) => ({
    avatar: chat.avatar,
    chatId: chat.id,
    id: chat.id,
    // A placeholder has no follow list behind it, so it claims nobody is followed rather than taking
    // the mock data's word for a relationship that cannot exist before sign-in.
    isFriend: false,
    // And it is nobody's message request either: nothing has been written in it.
    isRequest: false,
    // No mock room is a channel: the placeholder rows predate the kind, and a megaphone on a row that
    // can be posted to would be a claim about a room nobody can check.
    isChannel: false,
    isGroup: chat.kind === 'group',
    isOnline: false,
    // Nothing to check a lock against on a placeholder row, so no placeholder claims to be private.
    isPrivate: false,
    lastMessage: truncate(chat.snippet),
    name: chat.name,
    otherUserId: '',
    time: chat.time,
    unread: chat.unread,
  }));
}

/**
 * What the row says while somebody is typing in it, or '' to show the message preview as usual.
 *
 * Named only for a one-to-one room, where there is exactly one person the name can refer to. A group
 * is reported by count, because any of several people could be the one typing.
 */
function toTypingLabel(item: ChatListItem, typingUserIds: string[] | undefined) {
  if (!typingUserIds || typingUserIds.length === 0) {
    return '';
  }

  if (item.isGroup) {
    return typingUserIds.length > 1 ? `${typingUserIds.length} people are typing...` : 'Someone is typing...';
  }

  return `${item.name.split(' ')[0]} is typing...`;
}

function ChatRow({
  item,
  onPress,
  typingLabel,
}: {
  item: ChatListItem;
  onPress: (item: ChatListItem) => void;
  typingLabel?: string;
}) {
  return (
    <Pressable
      accessibilityLabel={`Chat with ${item.name}${item.isOnline ? ', online' : ''}${item.unread > 0 ? `, ${item.unread} unread` : ''}`}
      accessibilityRole="button"
      onPress={() => onPress(item)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.avatarWrap}>
        {/* One component for the picture and its light, so the chat list, the people list and a room's
            member list cannot drift apart about when the light is on. */}
        <PersonAvatar
          isOnline={!item.isGroup && item.isOnline}
          name={item.name}
          photoUrl={item.avatar}
        />

        {item.unread > 0 ? (
          <View style={styles.unreadBadge}>
            <Text style={styles.unreadBadgeText}>{item.unread > 99 ? '99+' : item.unread}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.middle}>
        <View style={styles.nameLine}>
          {item.isGroup ? (
            <View style={styles.groupGlyph}>
              {/* A channel gets a megaphone rather than the group glyph, because the two differ in
                  something a reader needs to see before opening them: a channel is one way. */}
              <Ionicons color="#656A73" name={item.isChannel ? 'megaphone' : 'people'} size={11} />
            </View>
          ) : null}

          <Text numberOfLines={1} style={styles.name}>{item.name}</Text>

          {/* After the name rather than before it, because the glyph on the left already says what kind of
              room this is and the lock is a qualifier on that rather than a second identity. Nothing at all
              on a public room: an open one is the ordinary case and a padlock on every row would be noise. */}
          {item.isPrivate ? (
            <Ionicons color="#A2A7B0" name="lock-closed" size={12} style={styles.privateGlyph} />
          ) : null}
        </View>

        <Text numberOfLines={1} style={[styles.snippet, Boolean(typingLabel) && styles.snippetTyping]}>
          {typingLabel || item.lastMessage}
        </Text>
      </View>

      <Text style={styles.time}>{item.time}</Text>
    </Pressable>
  );
}

export default function ChatListScreen() {
  const [filter, setFilter] = useState<FilterKey>('All');
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [loadError, setLoadError] = useState('');
  const [presence, setPresence] = useState<PresenceMap>({});
  const [isNotificationsVisible, setIsNotificationsVisible] = useState(false);
  const [isMarkingRead, setIsMarkingRead] = useState(false);
  // The search box and its text are separate because the box closing has to clear the text: leaving
  // a query behind would silently keep hiding rows after the field is gone.
  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    let unsubscribe = () => {};

    try {
      unsubscribe = onAuthStateChanged(getFirebaseAuth(), setCurrentUser);
    } catch (error) {
      // Firebase is not configured, or auth could not initialise. currentUser stays null and the
      // screen shows the mock rooms rather than an error.
      console.error('Firebase auth is unavailable:', error);
    }

    return unsubscribe;
  }, []);

  const userId = currentUser?.uid;

  // Rooms are only ever read while signed in. Cleared here rather than in the listener's effect, so
  // signing out does not leave the previous account's conversations behind for a frame.
  const activeRooms = userId ? rooms : EMPTY_ROOMS;

  // The live listener. Started once the uid is known, because the participants filter is the uid.
  useEffect(() => {
    // No account means no listener. The empty value comes from the render below.
    if (!userId) {
      return undefined;
    }

    // Ordered by the room's own last message time so the newest conversation is first, rather than
    // by document id, which is meaningless to a reader. The participants filter is not optional:
    // the security rules scope `list` to the caller's own rooms by checking membership per document,
    // and a query that does not filter on the same field cannot be validated and is refused.
    const roomsQuery = query(
      collection(getFirebaseDb(), 'chats'),
      where('participants', 'array-contains', userId),
      orderBy('lastMessageTime', 'desc'),
    );

    return onSnapshot(
      roomsQuery,
      (snapshot) => {
        const next: ChatRoom[] = snapshot.docs.map((document_) => {
          const data = document_.data() as Record<string, unknown>;

          return {
            id: document_.id,
            lastMessage: typeof data.lastMessage === 'string' ? data.lastMessage : undefined,
            lastMessageSenderId:
              typeof data.lastMessageSenderId === 'string' ? data.lastMessageSenderId : undefined,
            lastMessageTime: data.lastMessageTime instanceof Timestamp ? data.lastMessageTime : null,
            name: typeof data.name === 'string' && data.name ? data.name : undefined,
            participants: toParticipantIds(data.participants),
            unreadCount: toCount(data.unreadCount),
            // Narrowed to numbers here rather than cast through, so a malformed count on the
            // document becomes 0 instead of reaching the badge as whatever was stored.
            unreadCounts:
              data.unreadCounts && typeof data.unreadCounts === 'object'
                ? Object.fromEntries(
                    Object.entries(data.unreadCounts as Record<string, unknown>).map(([participant, value]) => [
                      participant,
                      toCount(value),
                    ]),
                  )
                : undefined,
          };
        });

        setRooms(next);
        setLoadError('');
      },
      (error) => {
        console.error('Failed to load chat rooms:', error);
        setLoadError(
          error.code === 'failed-precondition'
            ? 'The chat list needs a Firestore index. Deploy it with: firebase deploy --only firestore:indexes'
            : 'Could not load your conversations.',
        );
      },
    );
  }, [userId]);

  // The uids the list needs to know about: everyone in a room except this account.
  const otherUserIds = useMemo(() => {
    const ids = new Set<string>();

    activeRooms.forEach((room) => {
      room.participants.forEach((participant) => {
        if (participant !== userId) {
          ids.add(participant);
        }
      });
    });

    return [...ids].sort();
  }, [activeRooms, userId]);

  // The same set of ids, as one string.
  //
  // The subscription below is keyed on this rather than on the array, because the array is rebuilt
  // by the memo above whenever any room changes. Presence would then be torn down and rebuilt on
  // every message that arrives anywhere in the list, re-opening one listener per row each time, and
  // the map handed back while the new listeners were attaching would leave the dots missing.
  const presenceKey = otherUserIds.join(',');

  const people = usePeople(userId ? otherUserIds : []);
  const friendIds = useFriendIds(userId);

  // One presence subscription for the whole list, re-made only when the set of people changes.
  //
  // Only while signed in, because `status` is readable by signed-in accounts alone and a read from a
  // visitor is refused. Mock rows are therefore always offline before sign-in, which is honest: the
  // rows are placeholders, and there is nothing behind them to have a presence. Signing out stops
  // the listeners rather than leaving them failing on every reconnect.
  useEffect(() => subscribeToPresence(userId ? presenceKey.split(',').filter(Boolean) : [], setPresence), [presenceKey, userId]);

  const items = useMemo<ChatListItem[]>(() => {
    if (!userId) {
      return toMockItems();
    }

    return activeRooms.map((room) => {
      // A two person room has one other participant. A group has several, and no single person to
      // show, so the row stands for the room itself. The kind comes off the document when it is there,
      // so a channel is recognised as such rather than inferred to be a group by its size, and a room
      // written before kinds existed still reads correctly from its participant count.
      const others = room.participants.filter((participant) => participant !== userId);
      const kind = readRoomKind({ kind: room.kind, participants: room.participants });
      const isGroup = kind !== 'direct';
      const otherUserId = isGroup ? '' : others[0] ?? '';
      const person = otherUserId ? people[otherUserId] : undefined;

      return {
        avatar: person?.avatar ?? '',
        chatId: room.id,
        id: room.id,
        isFriend: Boolean(otherUserId) && friendIds.has(otherUserId),
        isChannel: kind === 'channel',
        isGroup,
        // Somebody else's one-to-one that they wrote last in. Theirs by who started it and by who has
        // the last word: a conversation this account opened is not a request, and one it has already
        // answered is not waiting on anything.
        isRequest: !isGroup
          && Boolean(otherUserId)
          && room.ownerId !== userId
          && room.lastMessageSenderId === otherUserId,
        // Only a room with several people can be private at all: a conversation's whole audience is
        // the two people in it, and marking it locked would claim there was somebody to keep out.
        isPrivate: isGroup && readRoomPrivacy({ kind: room.kind, participants: room.participants, privacy: room.privacy }) === 'private',
        // Presence stays false rather than guessed while the database is unavailable, which is what
        // keeps an "Offline" tab honest instead of claiming everyone is offline.
        isOnline: Boolean(otherUserId) && presence[otherUserId] === true,
        lastMessage: room.lastMessage ? truncate(room.lastMessage) : 'No messages yet',
        name: isGroup ? room.name ?? (kind === 'channel' ? 'Channel' : 'Group chat') : person?.name ?? 'Someone',
        otherUserId,
        time: toRelativeTime(room.lastMessageTime),
        unread: room.unreadCounts?.[userId] !== undefined ? toCount(room.unreadCounts[userId]) : toCount(room.unreadCount),
      };
    });
  }, [activeRooms, friendIds, people, presence, userId]);

  const visibleItems = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();

    // Matched against the name and the preview together, so "how are" finds a conversation by what
    // was said in it and not only by who it is with. The filters are applied first, so a search
    // cannot drag a room out of the tab it was filtered into.
    const filtered = filterItems(items, filter);

    if (!needle) {
      return filtered;
    }

    return filtered.filter((item) => (
      item.name.toLowerCase().includes(needle) || item.lastMessage.toLowerCase().includes(needle)
    ));
  }, [filter, items, searchQuery]);

  /**
   * Which kind of room the current tab is for, or '' when it is not a tab that makes one.
   *
   * Read off the tab rather than asked for, so the tab and the add on it cannot disagree about what
   * pressing it would make: Group chats can only make a group and Channel can only make a channel.
   */
  const createKind = filter === 'Group chats' ? 'group' : filter === 'Channel' ? 'channel' : '';

  // Typing per room, so a row says who is typing the way the conversation does.
  //
  // Bounded to a window rather than every room in the account. This is the same filtered list the tab is
  // showing -- so switching tabs does not re-subscribe -- but a list can be far longer than a screen, and an
  // unbounded fan-out meant one live listener and one expiry callback per conversation the account had ever
  // been in, all of them running for as long as this tab was open.
  //
  // The tradeoff, stated plainly: a room below the window shows its last message instead of a typing
  // indicator until it scrolls into range. That is a deliberate choice over the alternative, which was an
  // account with a few hundred conversations burning a listener and a 2.5s sweep callback for every one of
  // them to decorate rows nobody was looking at. Inside a conversation the indicator is still live, because
  // that screen subscribes to its own room directly.
  const typingRoomIds = useMemo(
    () => items.map((item) => item.chatId).sort().slice(0, TYPING_WINDOW),
    [items],
  );
  const typingByRoom = useTypingRooms(typingRoomIds, userId);

  const openChat = useCallback((item: ChatListItem) => {
    // The row's name travels with it so a group has a title. A one-to-one room is titled by the
    // profile the detail screen reads itself, which is fresher than this, and only falls back here
    // if that read fails.
    router.push({
      params: { id: item.chatId, name: item.name, otherUserId: item.otherUserId },
      pathname: '/chat/[id]',
    } as never);
  }, []);

  // What has not been read, from the whole list rather than from the filtered part: a notification that
  // a filter could hide would be a notification about a conversation that is not there to find.
  const unreadItems = useMemo(() => (
    items
      .filter((item) => item.unread > 0)
      .sort((first, second) => second.unread - first.unread)
  ), [items]);
  const unreadTotal = useMemo(() => (
    unreadItems.reduce((total, item) => total + item.unread, 0)
  ), [unreadItems]);

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Three equal slots rather than space-between: the title has to sit in the middle of the
          bar, and the left label is much wider than the icon on the right. */}
      <View style={styles.header}>
        <View style={styles.headerSide}>
          <Pressable
            accessibilityLabel="Find people near you"
            accessibilityRole="button"
            // The people-nearby screen, which is where conversations get started. This used to push
            // /find-friends, a mock screen with an age slider, no people, and a refresh button that
            // did nothing, so the one control in the header for finding somebody to talk to led
            // nowhere. Named for what it does rather than for the relationship it starts, because
            // somebody you have not met is not yet anybody you follow.
            onPress={() => router.push('/(tabs)/friends' as never)}
            style={({ pressed }) => [styles.findFriendsHit, pressed && styles.rowPressed]}
          >
            <Text style={styles.findFriends}>Find People</Text>
          </Pressable>
        </View>

        <Text style={styles.headerTitle}>Messages</Text>

        <View style={[styles.headerSide, styles.headerSideEnd, styles.headerActions]}>
          {/* What is waiting for you, where the add used to sit. The badge is the count of unread
              messages rather than a dot, because a dot cannot be compared against anything and a
              number can. */}
          <Pressable
            accessibilityLabel={unreadTotal > 0 ? `Notifications, ${unreadTotal} unread` : 'Notifications'}
            accessibilityRole="button"
            onPress={() => setIsNotificationsVisible(true)}
            style={({ pressed }) => [styles.menuHit, pressed && styles.rowPressed]}
          >
            <Ionicons color="#20232A" name="notifications-outline" size={22} />

            {unreadTotal > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unreadTotal > 99 ? '99+' : unreadTotal}</Text>
              </View>
            ) : null}
          </Pressable>

          {/* Search, rather than a menu of options that do not exist yet. A list that can grow past
              a screenful needs a way to reach one conversation out of it, and this button had no
              onPress at all. Making a room is not here any more: it belongs to the tab that lists
              the kind of room being made, so the add sits in Group chats and in Channel. */}
          <Pressable
            accessibilityLabel={isSearching ? 'Close search' : 'Search conversations'}
            accessibilityRole="button"
            onPress={() => {
              setSearchQuery('');

              if (isSearching) {
                setIsSearching(false);
              }
            }}
            style={({ pressed }) => [styles.menuHit, pressed && styles.rowPressed]}
          >
            <Ionicons color="#20232A" name={isSearching ? 'close' : 'search'} size={22} />
          </Pressable>
        </View>
      </View>

      {/* Above the filter tabs so it is the first thing under the title when it is open, and
          dismissed by the same button that revealed it. */}
      {isSearching ? (
        <View style={styles.searchBar}>
          <Ionicons color="#8D929C" name="search" size={17} />
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setSearchQuery}
            placeholder="Search conversations"
            placeholderTextColor="#8D929C"
            returnKeyType="search"
            style={styles.searchInput}
            value={searchQuery}
          />
          {searchQuery ? (
            <Pressable
              accessibilityLabel="Clear search"
              accessibilityRole="button"
              onPress={() => setSearchQuery('')}
              style={({ pressed }) => [styles.searchClear, pressed && styles.rowPressed]}
            >
              <Ionicons color="#8D929C" name="close-circle" size={17} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* Five tabs do not fit a phone width, so the row scrolls sideways instead of squeezing the
          labels until they truncate. A horizontal ScrollView needs the content to grow on one
          axis, hence the inner row. */}
      <ScrollView
        contentContainerStyle={styles.filterBarContent}
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
        style={styles.filterBar}
      >
        {FILTERS.map((option) => {
          const isActive = option === filter;

          return (
            <Pressable
              key={option}
              accessibilityLabel={`${option} chats`}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
              onPress={() => setFilter(option)}
              style={[styles.filterTab, isActive && styles.filterTabActive]}
            >
              <Text style={[styles.filterText, isActive && styles.filterTextActive]}>{option}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <FlatList
        contentContainerStyle={styles.list}
        data={visibleItems}
        initialNumToRender={8}
        keyExtractor={(item) => item.id}
        // The add that used to stand at the end of the tab row now sits inside the two tabs it
        // applies to, so it is offered on the tab you are already looking at rather than as a
        // separate control beside it.
        ListHeaderComponent={createKind ? (
          <Pressable
            accessibilityLabel={createKind === 'channel' ? 'Create a channel' : 'Create a group'}
            accessibilityRole="button"
            onPress={() => router.push({
              params: { kind: createKind },
              pathname: '/chat/new',
            } as never)}
            style={({ pressed }) => [styles.createRow, pressed && styles.rowPressed]}
          >
            <View style={styles.createGlyph}>
              <Ionicons color="#2FBF71" name="add" size={20} />
            </View>
            <View style={styles.createCopy}>
              <Text style={styles.createTitle}>
                {createKind === 'channel' ? 'New channel' : 'New group'}
              </Text>
              <Text style={styles.createHint}>
                {createKind === 'channel'
                  ? 'You post, everybody you add reads'
                  : 'Everyone you add can post and reply'}
              </Text>
            </View>
          </Pressable>
        ) : null}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons
              color="#A2A7B0"
              name={loadError ? 'alert-circle-outline' : searchQuery.trim() ? 'search-outline' : 'chatbubbles-outline'}
              size={26}
            />
            <Text style={styles.emptyText}>
              {loadError || (searchQuery.trim() ? `No conversations match "${searchQuery.trim()}".` : EMPTY_MESSAGE[filter])}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <ChatRow
            item={item}
            onPress={openChat}
            typingLabel={toTypingLabel(item, typingByRoom[item.chatId])}
          />
        )}
        showsVerticalScrollIndicator={false}
      />

      {/* What is waiting to be read, as a sheet over the list rather than a screen, because it is a
          glance at the list you are already looking at: every row is a conversation you can go to from
          here, and nothing here can be read on its own. */}
      <Modal
        animationType="fade"
        onRequestClose={() => setIsNotificationsVisible(false)}
        transparent
        visible={isNotificationsVisible}
      >
        <Pressable
          accessibilityLabel="Close notifications"
          accessibilityRole="button"
          onPress={() => setIsNotificationsVisible(false)}
          style={styles.scrim}
        >
          {/* Wrapped so a tap on a row does not reach the scrim and close the sheet on the way to opening
              the conversation. */}
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Notifications</Text>

              {unreadItems.length > 0 ? (
                <Pressable
                  accessibilityLabel="Mark everything as read"
                  accessibilityRole="button"
                  onPress={() => {
                    // Nothing to clear without an account, which is the same reason the unread list is
                    // empty in that case: the counter it would be clearing is the account's own.
                    if (!userId) {
                      return;
                    }

                    setIsMarkingRead(true);
                    void markRoomsRead(unreadItems.map((item) => item.chatId), userId).finally(() => {
                      setIsMarkingRead(false);
                    });
                  }}
                  style={({ pressed }) => [styles.sheetHeaderAction, pressed && styles.rowPressed]}
                >
                  {isMarkingRead ? (
                    <ActivityIndicator color="#2FBF71" size="small" />
                  ) : (
                    <Text style={styles.sheetHeaderActionText}>Mark all read</Text>
                  )}
                </Pressable>
              ) : null}
            </View>

            {unreadItems.length === 0 ? (
              <View style={styles.sheetEmpty}>
                <Ionicons color="#A2A7B0" name="notifications-off-outline" size={24} />
                <Text style={styles.sheetEmptyText}>Nothing new. You are all caught up.</Text>
              </View>
            ) : (
              unreadItems.map((item) => (
                <Pressable
                  accessibilityLabel={`Open the conversation with ${item.name}`}
                  accessibilityRole="button"
                  key={item.id}
                  onPress={() => {
                    setIsNotificationsVisible(false);
                    openChat(item);
                  }}
                  style={({ pressed }) => [styles.sheetRow, pressed && styles.rowPressed]}
                >
                  <View style={styles.sheetIcon}>
                    <Ionicons color="#2FBF71" name="chatbubble-ellipses" size={19} />
                  </View>

                  <View style={styles.sheetCopy}>
                    <Text numberOfLines={1} style={styles.sheetRowTitle}>{item.name}</Text>
                    <Text numberOfLines={1} style={styles.sheetRowHint}>{item.lastMessage}</Text>
                  </View>

                  <Text style={styles.sheetRowCount}>{item.unread}</Text>
                </Pressable>
              ))
            )}
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  headerSide: {
    flex: 1,
    justifyContent: 'center',
  },
  headerSideEnd: {
    alignItems: 'flex-end',
  },
  // Two buttons share the right side of the header, so this wrapper is a row while the other header
  // sides stay a column.
  headerActions: {
    flexDirection: 'row',
    gap: 14,
  },
  scrim: {
    backgroundColor: 'rgba(32, 35, 42, 0.45)',
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#F7F4EF',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingBottom: 34,
    paddingHorizontal: 16,
    paddingTop: 18,
  },
  sheetTitle: {
    color: '#8D929C',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    marginBottom: 10,
    textTransform: 'uppercase',
  },
  sheetRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 13,
    paddingVertical: 12,
  },
  sheetIcon: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  sheetCopy: {
    flex: 1,
    minWidth: 0,
  },
  sheetRowTitle: {
    color: '#20232A',
    fontSize: 16,
    fontWeight: '700',
  },
  sheetRowHint: {
    color: '#8D929C',
    fontSize: 12,
    marginTop: 2,
  },
  // The notifications sheet has a title and an action on the same line, which the create sheet's title
  // does not, so the title becomes a row rather than keeping the margin it had.
  sheetHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  sheetHeaderAction: {
    paddingVertical: 4,
  },
  sheetHeaderActionText: {
    color: '#2FBF71',
    fontSize: 12,
    fontWeight: '700',
  },
  sheetEmpty: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 26,
  },
  sheetEmptyText: {
    color: '#8D929C',
    fontSize: 13,
  },
  // The unread count, drawn where a row's trailing edge is free because nothing else is there.
  sheetRowCount: {
    color: '#2FBF71',
    fontSize: 13,
    fontWeight: '700',
  },
  // The badge sits on the bell rather than beside it, so the icon stays where every other icon in
  // this bar is and the number reads as belonging to it.
  badge: {
    alignItems: 'center',
    backgroundColor: '#E56B4C',
    borderColor: '#F7F4EF',
    borderRadius: 8,
    borderWidth: 1.5,
    height: 16,
    justifyContent: 'center',
    minWidth: 16,
    paddingHorizontal: 3,
    position: 'absolute',
    right: -5,
    top: -5,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '800',
  },
  // The add that stands inside the Group chats and Channel tabs rather than at the end of the tab
  // row: a full row with the kind's name and rule on it, because a bare plus in a bar of tabs says
  // nothing about which of the two rooms it is about to make.
  createRow: {
    alignItems: 'center',
    borderBottomColor: '#E7E2DA',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  createGlyph: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E3DED5',
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  createCopy: {
    flex: 1,
    minWidth: 0,
  },
  createTitle: {
    color: '#20232A',
    fontSize: 15,
    fontWeight: '800',
  },
  createHint: {
    color: '#8D929C',
    fontSize: 12,
    marginTop: 2,
  },
  findFriendsHit: {
    paddingVertical: 4,
  },
  findFriends: {
    color: '#8D929C',
    fontSize: 13,
    fontWeight: '600',
  },
  headerTitle: {
    color: '#20232A',
    fontSize: 19,
    fontWeight: '800',
  },
  menuHit: {
    padding: 4,
  },
  searchBar: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 10,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  searchInput: {
    color: '#20232A',
    flex: 1,
    fontSize: 15,
    padding: 0,
  },
  searchClear: {
    padding: 2,
  },
  filterBar: {
    borderBottomColor: '#E3DED5',
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginTop: 12,
  },
  filterBarContent: {
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  filterTab: {
    borderRadius: 999,
    marginBottom: 10,
    marginRight: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  filterTabActive: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E3DED5',
    borderWidth: StyleSheet.hairlineWidth,
  },
  filterText: {
    color: '#8D929C',
    fontSize: 13,
    fontWeight: '600',
  },
  filterTextActive: {
    color: '#20232A',
    fontWeight: '800',
  },
  list: {
    // Clears the custom tab bar, which floats over the bottom of the screen.
    paddingBottom: 120,
  },
  row: {
    // Top aligned so the timestamp sits on the first line with the name rather than centred
    // against a two-line block.
    alignItems: 'flex-start',
    borderBottomColor: '#E7E2DA',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  rowPressed: {
    opacity: 0.7,
  },
  avatarWrap: {
    height: 54,
    marginRight: 12,
    width: 54,
  },
  unreadBadge: {
    alignItems: 'center',
    backgroundColor: '#FE2C55',
    borderColor: '#F7F4EF',
    borderRadius: 10,
    borderWidth: 2,
    height: 20,
    justifyContent: 'center',
    minWidth: 20,
    paddingHorizontal: 4,
    // Pulled onto the corner of the circle, which is why the wrapper is not overflow hidden.
    position: 'absolute',
    right: -6,
    top: -4,
  },
  unreadBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
  },
  middle: {
    flex: 1,
    justifyContent: 'center',
    minWidth: 0,
  },
  nameLine: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
    marginBottom: 4,
  },
  groupGlyph: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    color: '#20232A',
    flexShrink: 1,
    fontSize: 15,
    fontWeight: '800',
  },
  privateGlyph: {
    marginLeft: 5,
  },
  snippet: {
    color: '#656A73',
    flexShrink: 1,
    fontSize: 13,
  },
  // The same accent the typing label uses inside a conversation, so "is typing..." reads as the same
  // signal in both places.
  snippetTyping: {
    color: '#2FBF71',
    fontWeight: '700',
  },
  time: {
    color: '#A2A7B0',
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 8,
  },
  empty: {
    alignItems: 'center',
    gap: 10,
    paddingBottom: 140,
    paddingHorizontal: 32,
    paddingTop: 56,
  },
  emptyText: {
    color: '#8D929C',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
});