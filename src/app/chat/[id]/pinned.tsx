import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MessageBubble } from '@/components/chat-message-bubble';
import { LoadedMessage, loadPinnedMessages, setMessagePinned } from '@/lib/chat-messages';

/**
 * Everything somebody thought was worth keeping at the top of the room.
 *
 * Read from the room's own messages rather than from a list of ids on the room document, so a pin is one
 * field on one message instead of a second document that has to be kept in step with the first and can
 * end up naming a message that has been deleted.
 */
export default function PinnedMessagesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chatId = Array.isArray(id) ? id[0] : id || '';

  const [rows, setRows] = useState<LoadedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Focus rather than mount: a pin made in the conversation underneath has to be here when this screen
// comes back, not only the first time it was opened.
useFocusEffect(
    useCallback(() => {
      if (!chatId) {
        return undefined;
      }

      let isCancelled = false;

      void (async () => {
        try {
          // Only the pinned messages, rather than the room's newest 500 filtered on the client. This screen
          // is opened from a focus effect because a pin made underneath has to appear here, so a
          // full-history read was being paid on every visit.
          const messages = await loadPinnedMessages(chatId);

          if (!isCancelled) {
            setRows(messages);
            setIsLoading(false);
          }
        } catch (error) {
          console.error('Could not load the pinned messages:', error);
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

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="Back" accessibilityRole="button" onPress={() => router.back()}>
          <Text style={styles.back}>←</Text>
        </Pressable>
        <Text style={styles.title}>Pinned messages</Text>
      </View>

      {isLoading ? (
        <ActivityIndicator color="#2FBF71" style={styles.loading} />
      ) : (
        <FlatList
          contentContainerStyle={styles.list}
          data={rows}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={(
            <View style={styles.empty}>
              <Ionicons color="#A2A7B0" name="bookmark-outline" size={26} />
              <Text style={styles.emptyTitle}>Nothing pinned</Text>
              <Text style={styles.emptySubtitle}>
                Long press a message and choose Pin to keep it here.
              </Text>
            </View>
          )}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <MessageBubble compact isMine={false} message={item} />
              <Pressable
                accessibilityLabel="Unpin this message"
                accessibilityRole="button"
                onPress={() => {
                  void setMessagePinned(chatId, item.id, false).then(() => {
                    setRows((current) => current.filter((row) => row.id !== item.id));
                  }).catch(() => {
                    // Left pinned on failure, which is what the document still says.
                  });
                }}
                style={styles.unpin}
              >
                <Ionicons color="#8D929C" name="bookmark" size={15} />
                <Text style={styles.unpinText}>Unpin</Text>
              </Pressable>
            </View>
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
  loading: {
    marginTop: 30,
  },
  list: {
    paddingBottom: 24,
    paddingHorizontal: 16,
  },
  row: {
    marginBottom: 8,
  },
  unpin: {
    alignItems: 'center',
    alignSelf: 'flex-end',
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  unpinText: {
    color: '#8D929C',
    fontSize: 12,
    fontWeight: '600',
  },
  empty: {
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyTitle: {
    color: '#20232A',
    fontSize: 16,
    fontWeight: '800',
    marginTop: 10,
  },
  emptySubtitle: {
    color: '#8D929C',
    fontSize: 13,
    marginTop: 4,
    textAlign: 'center',
  },
});