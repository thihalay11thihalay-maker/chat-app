import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  isGroupRoom,
  readParticipantIds,
  readPerson,
  readRoomAvatarUrl,
  readRoomKind,
  readRoomName,
} from '@/lib/chat-rooms';
import { AlbumItem, ChatMessageType, forwardMessage, summarizeMessage } from '@/lib/chat-messages';
import { loadChatSettings } from '@/lib/chat-settings';
import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';

type Choice = {
  id: string;
  kind: string;
  name: string;
  photoUrl: string;
};

/**
 * The message being forwarded, read straight off its document.
 *
 * The `type` is the shared union rather than a copy of it: this shape used to spell out the types itself,
 * which meant a message kind added anywhere else arrived here as something the compiler had never heard of
 * and was silently cast over. The fields are the ones this screen reads -- the rest of the document comes
 * through with them.
 */
type Message = {
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

/**
 * Sends one message into a different conversation.
 *
 * The words travel and the room they came from travels with them, but nothing that could be followed
 * back: somebody who is not in the room a message came from must not be able to reach into it from a
 * copy they were sent. So the copy is a new message written by this account, with the original's room
 * named in it and no reference that would let the reader fetch anything from there.
 */
export default function ForwardMessageScreen() {
  const { id, messageId } = useLocalSearchParams<{ id: string; messageId: string }>();
  const chatId = Array.isArray(id) ? id[0] : id || '';
  const targetMessageId = Array.isArray(messageId) ? messageId[0] : messageId || '';

  const [choices, setChoices] = useState<Choice[]>([]);
  const [message, setMessage] = useState<Message | null>(null);
  const [origin, setOrigin] = useState('');
  const [searchText, setSearchText] = useState('');
  const [sendingTo, setSendingTo] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const loadChoices = useCallback(async () => {
    const currentUser = getFirebaseAuth().currentUser;

    if (!currentUser) {
      return;
    }

    try {
      // The same query the inbox runs, and the reason it is scoped to this account's own rooms: a
      // message may only be forwarded into a conversation the sender is in, which is also what the
      // rules will check when the copy is written.
      const rooms = await getDocs(query(
        collection(getFirebaseDb(), 'chats'),
        where('participants', 'array-contains', currentUser.uid),
        orderBy('lastMessageTime', 'desc'),
        // Enough rooms to choose from without reading a whole inbox. Bounded on purpose: a list of
        // somewhere to forward something is not worth paying for a read per conversation, and the
        // order puts the ones somebody is actually in at the top.
        limit(40),
      ));

      const rows = await Promise.all(rooms.docs.map(async (roomDocument) => {
        const data = roomDocument.data();
        const kind = readRoomKind(data);
        const others = readParticipantIds(data).filter((uid) => uid !== currentUser.uid);
        let name = readRoomName(data, '');
        let photoUrl = readRoomAvatarUrl(data);

        // A one-to-one has no room name: it is called after the other person, whose profile is read here
        // for the row rather than carried in as text, so the row is right if a name has changed since.
        if (!isGroupRoom(kind) && others.length > 0) {
          try {
            const snapshot = await getDoc(doc(getFirebaseDb(), 'users', others[0]));
            const person = snapshot.exists() ? readPerson(snapshot.data(), '') : { name: '', photoUrl: '' };

            name = person.name || name || 'Conversation';
            photoUrl = photoUrl || person.photoUrl;
          } catch {
            // A profile that cannot be read leaves the row titled by whatever the document said.
          }
        }

        return {
          id: roomDocument.id,
          kind,
          name: name || 'Conversation',
          photoUrl,
        };
      }));

      setChoices(rows);
    } catch (error) {
      console.error('Could not load the rooms to forward into:', error);
      setError('Could not load your conversations.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Focus rather than mount, so coming back to this screen re-reads the room and the rooms rather than
// showing a message somebody has since deleted or a conversation that has since been left.
useFocusEffect(
    useCallback(() => {
      if (!chatId || !targetMessageId) {
        setIsLoading(false);
        return;
      }

      let isCancelled = false;

      void (async () => {
        try {
          // The message and the room's own name are read together. The room read is allowed because this
          // account is in it, which is the same reason the forward will be accepted.
          const [messageSnapshot, roomSnapshot] = await Promise.all([
            getDoc(doc(getFirebaseDb(), 'chats', chatId, 'messages', targetMessageId)),
            getDoc(doc(getFirebaseDb(), 'chats', chatId)),
          ]);

          if (isCancelled) {
            return;
          }

          if (!messageSnapshot.exists()) {
            setError('That message is no longer there.');
            return;
          }

          setMessage(messageSnapshot.data() as Message);
          setOrigin(readRoomName(roomSnapshot.exists() ? roomSnapshot.data() : {}, '') || 'this conversation');
        } catch (error) {
          console.error('Could not read the message to forward:', error);
          if (!isCancelled) {
            setError('Could not open that message.');
          }
        }
      })();

      return () => {
        isCancelled = true;
      };
    }, [chatId, targetMessageId]),
  );

  useFocusEffect(
    useCallback(() => {
      void loadChoices();

      return undefined;
    }, [loadChoices]),
  );

  const forward = useCallback(async (choice: Choice) => {
    const currentUser = getFirebaseAuth().currentUser;

    if (!currentUser || !message || sendingTo !== '') {
      return;
    }

    // The room it is being sent into cannot be the room it came from: that would be a second copy in the
    // conversation the people involved already have, which is a mistake rather than a forward.
    if (choice.id === chatId) {
      setError('It is already in this conversation.');
      return;
    }

    setSendingTo(choice.id);

    try {
      const settings = await loadChatSettings(choice.id, currentUser.uid);

      await forwardMessage({
        // The target room's own timer, not this one's: the message is being sent into that room, and the
        // person receiving it has agreed to a timer there and not here.
        expiresInSeconds: settings.disappearingAfterSeconds,
        message,
        origin: { roomId: chatId, roomName: origin },
        targetChatId: choice.id,
      });

      router.back();
    } catch (error) {
      console.error('Could not forward the message:', error);
      setError('Could not forward that message. Please try again.');
      setSendingTo('');
    }
  }, [chatId, message, origin, sendingTo]);

  const needle = searchText.trim().toLowerCase();
  const visibleChoices = needle
    ? choices.filter((choice) => choice.name.toLowerCase().includes(needle))
    : choices;

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="Back" accessibilityRole="button" onPress={() => router.back()}>
          <Text style={styles.back}>?</Text>
        </Pressable>
        <Text style={styles.title}>Forward to</Text>
      </View>

      {message ? (
        <View style={styles.preview}>
          <Ionicons color="#8D929C" name="return-down-forward" size={15} />
          <Text numberOfLines={1} style={styles.previewText}>{summarizeMessage(message)}</Text>
        </View>
      ) : null}

      <View style={styles.search}>
        <Ionicons color="#8D929C" name="search" size={16} />
        <TextInput
          onChangeText={setSearchText}
          placeholder="Search your conversations"
          placeholderTextColor="#8D929C"
          style={styles.searchInput}
          value={searchText}
        />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {isLoading ? (
        <ActivityIndicator color="#2FBF71" style={styles.loading} />
      ) : (
        <FlatList
          contentContainerStyle={styles.list}
          data={visibleChoices}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={(
            <Text style={styles.empty}>
              {needle ? 'No conversations match that.' : 'You are not in any conversations yet.'}
            </Text>
          )}
          renderItem={({ item }) => (
            <Pressable
              accessibilityLabel={`Forward to ${item.name}`}
              accessibilityRole="button"
              disabled={sendingTo !== ''}
              onPress={() => void forward(item)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              {item.photoUrl ? (
                <Image contentFit="cover" source={{ uri: item.photoUrl }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback]}>
                  <Ionicons
                    color="#8D929C"
                    name={item.kind === 'channel' ? 'megaphone' : item.kind === 'group' ? 'people' : 'person'}
                    size={18}
                  />
                </View>
              )}
              <View style={styles.rowCopy}>
                <Text numberOfLines={1} style={styles.rowName}>{item.name}</Text>
                <Text style={styles.rowKind}>
                  {item.kind === 'channel' ? 'Channel' : item.kind === 'group' ? 'Group' : 'Direct'}
                </Text>
              </View>
              {sendingTo === item.id ? <ActivityIndicator color="#2FBF71" size="small" /> : null}
            </Pressable>
          )}
        />
      )}
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
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  back: {
    color: '#363A42',
    fontSize: 22,
  },
  title: {
    color: '#20232A',
    fontSize: 19,
    fontWeight: '800',
  },
  preview: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
    marginHorizontal: 16,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  previewText: {
    color: '#363A42',
    flex: 1,
    fontSize: 13,
  },
  search: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
    marginHorizontal: 16,
    paddingHorizontal: 12,
  },
  searchInput: {
    color: '#20232A',
    flex: 1,
    fontSize: 15,
    paddingVertical: 10,
  },
  error: {
    color: '#C0392B',
    fontSize: 13,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  loading: {
    marginTop: 30,
  },
  list: {
    paddingBottom: 24,
    paddingHorizontal: 16,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 10,
  },
  rowPressed: {
    opacity: 0.6,
  },
  avatar: {
    borderRadius: 22,
    height: 44,
    width: 44,
  },
  avatarFallback: {
    alignItems: 'center',
    backgroundColor: '#E7E2DA',
    justifyContent: 'center',
  },
  rowCopy: {
    flex: 1,
    minWidth: 0,
  },
  rowName: {
    color: '#20232A',
    fontSize: 15,
    fontWeight: '700',
  },
  rowKind: {
    color: '#8D929C',
    fontSize: 12,
    marginTop: 1,
  },
  empty: {
    color: '#8D929C',
    fontSize: 14,
    paddingTop: 30,
    textAlign: 'center',
  },
});