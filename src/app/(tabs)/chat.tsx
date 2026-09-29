import { router } from 'expo-router';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';

type UnknownRecord = Record<string, unknown>;

type ChatPreview = {
  id: string;
  displayName: string;
  photoUrl: string;
  lastMessage: string;
  updatedAt: Date | null;
};

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (value && typeof value === 'object') {
    const timestamp = value as { toDate?: () => Date; seconds?: number };
    if (typeof timestamp.toDate === 'function') {
      return timestamp.toDate();
    }
    if (typeof timestamp.seconds === 'number') {
      return new Date(timestamp.seconds * 1000);
    }
  }
  return null;
}

function formatTime(date: Date | null) {
  if (!date) {
    return '';
  }

  const elapsedMs = Date.now() - date.getTime();
  if (elapsedMs < 60_000) {
    return 'now';
  }
  if (elapsedMs < 60 * 60_000) {
    return `${Math.floor(elapsedMs / 60_000)}m`;
  }
  if (elapsedMs < 24 * 60 * 60_000) {
    return `${Math.floor(elapsedMs / (60 * 60_000))}h`;
  }
  if (elapsedMs < 7 * 24 * 60 * 60_000) {
    return `${Math.floor(elapsedMs / (24 * 60 * 60_000))}d`;
  }

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function getOtherParticipantId(participants: unknown, currentUserId: string) {
  if (!Array.isArray(participants)) {
    return null;
  }

  const otherParticipant = participants.find((participant) => {
    if (typeof participant === 'string') {
      return participant !== currentUserId;
    }
    if (participant && typeof participant === 'object' && 'uid' in participant) {
      return participant.uid !== currentUserId;
    }
    return false;
  });

  if (typeof otherParticipant === 'string') {
    return otherParticipant;
  }
  if (otherParticipant && typeof otherParticipant === 'object' && 'uid' in otherParticipant) {
    const { uid } = otherParticipant as { uid: unknown };
    return typeof uid === 'string' ? uid : null;
  }
  return null;
}

function getMessageText(value: unknown) {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  if (value && typeof value === 'object') {
    const message = value as UnknownRecord;
    for (const key of ['text', 'content', 'message']) {
      if (typeof message[key] === 'string' && message[key].trim()) {
        return message[key];
      }
    }
  }
  return 'Say hello';
}

function getProfileText(profile: UnknownRecord, keys: string[], fallback: string) {
  for (const key of keys) {
    if (typeof profile[key] === 'string' && profile[key].trim()) {
      return profile[key];
    }
  }
  return fallback;
}

function ChatRow({
  chat,
  hasPhotoError,
  onPress,
  onPhotoError,
}: {
  chat: ChatPreview;
  hasPhotoError: boolean;
  onPress: () => void;
  onPhotoError: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={`Chat with ${chat.displayName}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.chatRow, pressed && styles.chatRowPressed]}
    >
      <View style={styles.avatarWrap}>
        {chat.photoUrl && !hasPhotoError ? (
          <Image onError={onPhotoError} source={{ uri: chat.photoUrl }} style={styles.avatarImage} />
        ) : (
          <View style={styles.avatarFallback}>
            <Text style={styles.avatarFallbackText}>{chat.displayName.charAt(0).toUpperCase()}</Text>
          </View>
        )}
      </View>

      <View style={styles.chatCopy}>
        <View style={styles.nameLine}>
          <Text numberOfLines={1} style={styles.chatName}>{chat.displayName}</Text>
          <Text style={styles.timeText}>{formatTime(chat.updatedAt)}</Text>
        </View>
        <Text numberOfLines={1} style={styles.messageText}>{chat.lastMessage}</Text>
      </View>
    </Pressable>
  );
}

function EmptyChats() {
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyMark}>
        <Text style={styles.emptyMarkText}>...</Text>
      </View>
      <Text style={styles.emptyTitle}>No chats yet</Text>
      <Text style={styles.emptyText}>No chats yet. Find friends to start chatting!</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push('/friends' as never)}
        style={({ pressed }) => [styles.emptyButton, pressed && styles.pressed]}
      >
        <Text style={styles.emptyButtonText}>Find friends</Text>
      </Pressable>
    </View>
  );
}

export default function ChatListScreen() {
  const currentUser = getFirebaseAuth().currentUser;
  const [chats, setChats] = useState<ChatPreview[]>([]);
  const [isLoading, setIsLoading] = useState(Boolean(currentUser));
  const [errorMessage, setErrorMessage] = useState(currentUser ? '' : 'Please log in to see your chats.');
  const [photoErrors, setPhotoErrors] = useState<string[]>([]);

  useEffect(() => {
    let isActive = true;
    let updateNumber = 0;

    if (!currentUser) {
      return () => {
        isActive = false;
      };
    }

    const chatsQuery = query(
      collection(getFirebaseDb(), 'chats'),
      where('participants', 'array-contains', currentUser.uid),
    );

    const unsubscribe = onSnapshot(chatsQuery, (snapshot) => {
      const thisUpdate = ++updateNumber;

      // The other participant is fetched per chat, so the snapshots are only applied
      // once the newest one has resolved. Otherwise a slow profile read can overwrite
      // fresher data.
      const loadChatPreviews = async () => {
        const nextChats = await Promise.all(snapshot.docs.map(async (chatDocument) => {
          const chatData = chatDocument.data() as UnknownRecord;
          const otherUid = getOtherParticipantId(chatData.participants, currentUser.uid);
          const embeddedProfiles = chatData.participantProfiles as UnknownRecord | undefined;
          const embeddedProfile = embeddedProfiles && otherUid
            ? embeddedProfiles[otherUid] as UnknownRecord | undefined
            : undefined;
          let profile = embeddedProfile ?? {};

          if (otherUid) {
            try {
              const profileSnapshot = await getDoc(doc(getFirebaseDb(), 'users', otherUid));
              if (profileSnapshot.exists()) {
                profile = { ...profile, ...profileSnapshot.data() };
              }
            } catch (error) {
              console.warn(`Could not load chat profile ${otherUid}:`, error);
            }
          }

          const lastMessage = chatData.lastMessage;
          const lastMessageData = lastMessage && typeof lastMessage === 'object'
            ? lastMessage as UnknownRecord
            : undefined;
          const updatedAt = toDate(chatData.lastMessageAt)
            ?? toDate(lastMessageData?.createdAt)
            ?? toDate(lastMessageData?.timestamp)
            ?? toDate(chatData.updatedAt)
            ?? toDate(chatData.createdAt);

          return {
            displayName: getProfileText(profile, ['displayName', 'name', 'username'], 'New friend'),
            id: chatDocument.id,
            lastMessage: lastMessage
              ? getMessageText(lastMessage)
              : getMessageText(chatData.lastMessageText),
            photoUrl: getProfileText(profile, ['profilePictureUrl', 'photoURL', 'photoUrl', 'avatarUrl'], ''),
            updatedAt,
          } satisfies ChatPreview;
        }));

        if (isActive && thisUpdate === updateNumber) {
          nextChats.sort((first, second) => (second.updatedAt?.getTime() ?? 0) - (first.updatedAt?.getTime() ?? 0));
          setChats(nextChats);
          setPhotoErrors([]);
          setErrorMessage('');
          setIsLoading(false);
        }
      };

      void loadChatPreviews().catch((error: unknown) => {
        console.error('Could not load chat previews:', error);
        if (isActive && thisUpdate === updateNumber) {
          setErrorMessage('Could not load your chats. Please try again.');
          setIsLoading(false);
        }
      });
    }, (error) => {
      console.error('Chat listener failed:', error);
      if (isActive) {
        setErrorMessage('Could not load your chats. Check your connection and try again.');
        setIsLoading(false);
      }
    });

    return () => {
      isActive = false;
      unsubscribe();
    };
  }, [currentUser]);

  const openChat = (chatId: string) => {
    router.push(`/chat/${chatId}` as never);
  };

  const markPhotoFailed = (chatId: string) => {
    setPhotoErrors((current) => (current.includes(chatId) ? current : [...current, chatId]));
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.screen}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>CONVO</Text>
            <Text style={styles.title}>Messages</Text>
          </View>
          <View style={styles.headerAvatar}>
            <Text style={styles.headerAvatarText}>
              {currentUser?.displayName?.trim().charAt(0).toUpperCase() || 'C'}
            </Text>
          </View>
        </View>

        {isLoading ? (
          <View style={styles.stateContainer}>
            <ActivityIndicator color="#E56B4C" size="large" />
            <Text style={styles.stateText}>Loading your chats...</Text>
          </View>
        ) : errorMessage ? (
          <View style={styles.stateContainer}>
            <Text style={styles.stateTitle}>Chats unavailable</Text>
            <Text style={styles.stateText}>{errorMessage}</Text>
          </View>
        ) : (
          <FlatList
            contentContainerStyle={styles.chatList}
            data={chats}
            initialNumToRender={10}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={EmptyChats}
            ListHeaderComponent={chats.length > 0 ? (
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Recent chats</Text>
                <Text style={styles.chatCount}>{chats.length}</Text>
              </View>
            ) : null}
            renderItem={({ item }) => (
              <ChatRow
                chat={item}
                hasPhotoError={photoErrors.includes(item.id)}
                onPhotoError={() => markPhotoFailed(item.id)}
                onPress={() => openChat(item.id)}
              />
            )}
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>
    </SafeAreaView>
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
    marginBottom: 24,
  },
  eyebrow: {
    color: '#E56B4C',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.8,
    marginBottom: 5,
  },
  title: {
    color: '#20232A',
    fontSize: 32,
    fontWeight: '800',
  },
  headerAvatar: {
    alignItems: 'center',
    backgroundColor: '#D7E6DF',
    borderRadius: 23,
    height: 46,
    justifyContent: 'center',
    width: 46,
  },
  headerAvatarText: {
    color: '#315A49',
    fontSize: 17,
    fontWeight: '800',
  },
  sectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
    marginBottom: 12,
  },
  sectionTitle: {
    color: '#363A42',
    fontSize: 15,
    fontWeight: '800',
  },
  chatCount: {
    backgroundColor: '#E7E2DA',
    borderRadius: 10,
    color: '#656A73',
    fontSize: 11,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  chatList: {
    flexGrow: 1,
    paddingBottom: 120,
  },
  chatRow: {
    alignItems: 'center',
    borderBottomColor: '#E7E2DA',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    minHeight: 82,
    paddingVertical: 13,
  },
  chatRowPressed: {
    opacity: 0.72,
  },
  avatarWrap: {
    height: 54,
    marginRight: 14,
    width: 54,
  },
  avatarImage: {
    backgroundColor: '#E7E2DA',
    borderRadius: 27,
    height: 54,
    width: 54,
  },
  avatarFallback: {
    alignItems: 'center',
    backgroundColor: '#F2C6B8',
    borderRadius: 27,
    flex: 1,
    justifyContent: 'center',
  },
  avatarFallbackText: {
    color: '#6E3D31',
    fontSize: 19,
    fontWeight: '800',
  },
  chatCopy: {
    flex: 1,
    minWidth: 0,
  },
  nameLine: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 7,
  },
  chatName: {
    color: '#20232A',
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
    marginRight: 10,
  },
  timeText: {
    color: '#8D929C',
    fontSize: 11,
    fontWeight: '600',
  },
  messageText: {
    color: '#656A73',
    fontSize: 13,
    lineHeight: 19,
  },
  stateContainer: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 30,
  },
  stateTitle: {
    color: '#20232A',
    fontSize: 19,
    fontWeight: '800',
    marginBottom: 5,
  },
  stateText: {
    color: '#777C84',
    fontSize: 14,
    lineHeight: 21,
    marginTop: 12,
    textAlign: 'center',
  },
  emptyState: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingBottom: 60,
    paddingHorizontal: 24,
  },
  emptyMark: {
    alignItems: 'center',
    backgroundColor: '#F1DDD5',
    borderRadius: 34,
    height: 68,
    justifyContent: 'center',
    marginBottom: 20,
    width: 68,
  },
  emptyMarkText: {
    color: '#E56B4C',
    fontSize: 22,
    fontWeight: '800',
  },
  emptyTitle: {
    color: '#20232A',
    fontSize: 21,
    fontWeight: '800',
    marginBottom: 7,
  },
  emptyText: {
    color: '#777C84',
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  emptyButton: {
    backgroundColor: '#20232A',
    borderRadius: 10,
    marginTop: 20,
    paddingHorizontal: 19,
    paddingVertical: 12,
  },
  emptyButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.78,
  },
});
