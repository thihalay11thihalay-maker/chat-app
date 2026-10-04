import { Ionicons } from '@expo/vector-icons';
import { collection, doc, getCountFromServer, getDoc, query } from 'firebase/firestore';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { readParticipantIds, readRoomName } from '@/lib/chat-rooms';
import { getFirebaseDb } from '@/lib/firebase';

/**
 * How much this room has been used.
 *
 * Three numbers, and each one is counted differently on purpose. Members come off the room document, which
 * is the only place the list is kept. Active members come off `lastActive`, a map each member writes as
 * they send, so "active" means somebody who actually said something rather than somebody who had the app
 * open. Messages are counted by the server over the room's messages, so the number is right for a room
 * with more history than anybody would page through.
 *
 * There is no message-per-day chart. It would need an aggregate this client cannot run without reading
 * every message it is counting, which is the one thing a stats screen must not do to a room with history.
 */
export default function RoomStatsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chatId = Array.isArray(id) ? id[0] : id || '';

  const [stats, setStats] = useState<{
    activeMemberCount: number;
    lastActive: Record<string, number>;
    memberCount: number;
    messageCount: number;
    name: string;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useFocusEffect(
    useCallback(() => {
      let isCancelled = false;

void (async () => {
        try {
          const roomSnapshot = await getDoc(doc(getFirebaseDb(), 'chats', chatId));

          if (!roomSnapshot.exists()) {
            if (!isCancelled) {
              setError('This group is no longer available.');
            }
            return;
          }

          const data = roomSnapshot.data();
          const participants = readParticipantIds(data);
          // Counted by the server rather than by paging the messages, because the count is the cheap
          // query and reading every message to add them up is the expensive one.
          const counted = await getCountFromServer(
            query(collection(getFirebaseDb(), 'chats', chatId, 'messages')),
          );

          if (isCancelled) {
            return;
          }

          const lastActive: Record<string, number> = {};
          const rawLastActive = data.lastActive;

          if (rawLastActive && typeof rawLastActive === 'object') {
            for (const [uid, value] of Object.entries(rawLastActive as Record<string, unknown>)) {
              const stamp = (value as { toMillis?: () => number } | undefined)?.toMillis?.()
                ?? (typeof value === 'number' ? value : null);

              if (stamp !== null) {
                lastActive[uid] = stamp;
              }
            }
          }

          const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

          setStats({
            activeMemberCount: participants.filter((uid) => (lastActive[uid] ?? 0) >= dayAgo).length,
            lastActive,
            memberCount: participants.length,
            messageCount: counted.data().count,
            name: readRoomName(data, ''),
          });
        } catch (readError) {
          console.error('Could not read the room stats:', readError);
          if (!isCancelled) {
            setError('Could not read this room.');
          }
        } finally {
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
        <Text style={styles.title}>Group information</Text>
      </View>

      {isLoading ? (
        <ActivityIndicator color="#2FBF71" style={styles.loading} />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : stats ? (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.name}>{stats.name || 'This group'}</Text>

          <View style={styles.card}>
            <Stat icon="people" label="Members" value={stats.memberCount.toLocaleString()} />
            <Stat icon="chatbubbles" label="Messages" value={stats.messageCount.toLocaleString()} />
            <Stat
              icon="pulse"
              label="Active in the last day"
              value={stats.activeMemberCount.toLocaleString()}
            />
          </View>

          <Text style={styles.note}>
            Active counts the people who sent a message in the last 24 hours. Somebody who has only read
            the group is not counted, because the app does not report reads.
          </Text>

          <Text style={styles.section}>Last seen</Text>
          <View style={styles.card}>
            {Object.entries(stats.lastActive)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 12)
              .map(([uid, when]) => (
                <View key={uid} style={styles.seenRow}>
                  <Text numberOfLines={1} style={styles.seenId}>{uid.slice(0, 12)}</Text>
                  <Text style={styles.seenWhen}>{new Date(when).toLocaleString()}</Text>
                </View>
              ))}
            {Object.keys(stats.lastActive).length === 0 ? (
              <Text style={styles.seenWhen}>Nobody has sent anything yet.</Text>
            ) : null}
          </View>
          <Text style={styles.note}>
            Shown by account id because the profile behind each one is not read for a list.
          </Text>
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.statRow}>
      <Ionicons color="#2FBF71" name={icon} size={18} />
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  loading: {
    marginTop: 60,
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
  content: {
    paddingBottom: 32,
  },
  name: {
    color: '#6C7079',
    fontSize: 14,
    marginBottom: 12,
    marginHorizontal: 16,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    marginHorizontal: 16,
    overflow: 'hidden',
    paddingVertical: 4,
  },
  statRow: {
    alignItems: 'center',
    borderBottomColor: '#F0EDE7',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  statLabel: {
    color: '#20232A',
    flex: 1,
    fontSize: 15,
  },
  statValue: {
    color: '#20232A',
    fontSize: 16,
    fontWeight: '800',
  },
  note: {
    color: '#8D929C',
    fontSize: 12,
    lineHeight: 18,
    marginHorizontal: 16,
    marginTop: 8,
  },
  section: {
    color: '#8D929C',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    marginBottom: 8,
    marginLeft: 22,
    marginTop: 18,
    textTransform: 'uppercase',
  },
  seenRow: {
    borderBottomColor: '#F0EDE7',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  seenId: {
    color: '#6C7079',
    flex: 1,
    fontSize: 13,
  },
  seenWhen: {
    color: '#8D929C',
    fontSize: 12,
  },
  error: {
    color: '#C0392B',
    fontSize: 14,
    marginHorizontal: 16,
    marginTop: 20,
  },
});