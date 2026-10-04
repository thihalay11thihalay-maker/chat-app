import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
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

import { ChatMessage, MessageBubble } from '@/components/chat-message-bubble';
import { LoadedMessage, loadRoomMessages, summarizeMessage } from '@/lib/chat-messages';

/**
 * Messages already read for a room, held across visits to this screen.
 *
 * Module scope rather than component state because the cost being avoided is the read itself, and a value
 * in state dies with the screen that fetched it -- which is exactly the visit being made cheap. One room's
 * worth, keyed by room, so switching conversations does not mix them up.
 *
 * Never grows without bound in practice: one entry per room this account has searched, holding at most the
 * 500 messages `loadRoomMessages` returns.
 */
const searchCache = new Map<string, LoadedMessage[]>();

/**
 * Finds something that was said in this room.
 *
 * The filter runs over the messages this client has already loaded rather than asking Firestore to match
 * text, because Firestore cannot match a string by "contains" at all: the closest it offers is a range
 * query, which finds only messages that begin with what was typed. So a search box that claimed to find
 * a word in the middle of a message would be lying for most of what people search for.
 *
 * What it does cover is everything currently loaded, which is the whole conversation on a fresh open and
 * as far back as the listener has been asked to go. It says so on screen rather than implying otherwise.
 */
export default function RoomSearchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chatId = Array.isArray(id) ? id[0] : id || '';

  const [searchText, setSearchText] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Re-read on arrival, but not from scratch every time.
  //
  // Firestore cannot match a string by substring, so searching a conversation genuinely does mean reading
  // its messages and filtering on the device. What it does not mean is paying that again on every visit: this
  // screen used to re-read the room's newest 500 documents each time it gained focus, so backing in and out
  // of it while looking for one word cost 500 reads a time.
  //
  // So the loaded messages are cached per room in the module rather than in this component's state, and a
  // return visit is served from it. The cache is deliberately not invalidated on a timer: a message arriving
  // while this screen is closed is picked up the next time the conversation screen itself is opened, which
  // has a live listener and re-fetches anyway, and search re-entering the cache would otherwise have to
  // guess when a room last changed -- which is the 500-read problem again.
  useFocusEffect(
    useCallback(() => {
      if (!chatId) {
        return undefined;
      }

      const cached = searchCache.get(chatId);

      if (cached) {
        setMessages(cached);
        setIsLoading(false);

        return undefined;
      }

      let isCancelled = false;

      void (async () => {
        try {
          const loaded = await loadRoomMessages(chatId);

          if (isCancelled) {
            return;
          }

          searchCache.set(chatId, loaded);
          setMessages(loaded);
          setIsLoading(false);
        } catch (error) {
          console.error('Could not load the messages to search:', error);
          if (!isCancelled) {
            setIsLoading(false);
          }
        }
      })();

      return () => {
        isCancelled = true;
      };
    }, [chatId]),
  );

  const needle = searchText.trim().toLowerCase();
  const matches = useMemo(() => {
    if (needle === '') {
      return [];
    }

    return messages.filter((message) => summarizeMessage(message).toLowerCase().includes(needle));
  }, [messages, needle]);

  const openResult = useCallback((message: ChatMessage) => {
    router.replace({ params: { id: chatId, focus: message.id }, pathname: '/chat/[id]' } as never);
  }, [chatId]);

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="Back" accessibilityRole="button" onPress={() => router.back()}>
          <Text style={styles.back}>←</Text>
        </Pressable>
        <Text style={styles.title}>Search this chat</Text>
      </View>

      <View style={styles.search}>
        <Ionicons color="#8D929C" name="search" size={16} />
        <TextInput
          autoFocus
          onChangeText={setSearchText}
          placeholder="Search messages"
          placeholderTextColor="#8D929C"
          style={styles.searchInput}
          value={searchText}
        />
        {isLoading ? <ActivityIndicator color="#8D929C" size="small" /> : null}
      </View>

      {needle !== '' ? (
        <Text style={styles.count}>
          {matches.length === 0
            ? 'Nothing here says that.'
            : `${matches.length} message${matches.length === 1 ? '' : 's'}`}
        </Text>
      ) : (
        <Text style={styles.hint}>Searches the messages loaded on this device.</Text>
      )}

      <FlatList
        contentContainerStyle={styles.list}
        data={matches}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={needle === '' ? null : (
          <Text style={styles.empty}>
            Firestore cannot match text in the middle of a message, so this looks through what is loaded.
          </Text>
        )}
        renderItem={({ item }) => (
          <Pressable onPress={() => openResult(item)}>
            <MessageBubble compact isMine={false} message={item} />
          </Pressable>
        )}
      />
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
  search: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 8,
    marginHorizontal: 16,
    paddingHorizontal: 12,
  },
  searchInput: {
    color: '#20232A',
    flex: 1,
    fontSize: 15,
    paddingVertical: 10,
  },
  count: {
    color: '#6C7079',
    fontSize: 12,
    marginHorizontal: 16,
    marginTop: 10,
  },
  hint: {
    color: '#8D929C',
    fontSize: 12,
    marginHorizontal: 16,
    marginTop: 10,
  },
  list: {
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  empty: {
    color: '#8D929C',
    fontSize: 13,
    lineHeight: 19,
    paddingTop: 10,
  },
});