import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MockChat, MOCK_CHATS } from '@/lib/mock-chats';

type FilterKey = 'All' | 'Friends' | 'Group Chats';

const FILTERS: FilterKey[] = ['All', 'Friends', 'Group Chats'];

function filterChats(chats: MockChat[], filter: FilterKey) {
  if (filter === 'Friends') {
    return chats.filter((chat) => chat.kind === 'direct' && chat.online);
  }

  if (filter === 'Group Chats') {
    return chats.filter((chat) => chat.kind === 'group');
  }

  return chats;
}

function ChatRow({ chat }: { chat: MockChat }) {
  const genderIcon = chat.gender === 'female' ? 'female' : 'male';
  const genderColor = chat.gender === 'female' ? '#F06292' : '#4FA3E3';

  return (
    <Pressable
      accessibilityLabel={`Chat with ${chat.name}${chat.unread > 0 ? `, ${chat.unread} unread` : ''}`}
      accessibilityRole="button"
      // This is the conversation, not discovery. The id is the row's own, so it lands on the
      // thread for the person whose name is on screen.
      onPress={() => router.push(`/chat/${chat.id}` as never)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.avatarWrap}>
        <Image source={{ uri: chat.avatar }} style={styles.avatar} />

        {chat.unread > 0 ? (
          <View style={styles.unreadBadge}>
            <Text style={styles.unreadBadgeText}>{chat.unread > 99 ? '99+' : chat.unread}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.middle}>
        <View style={styles.nameLine}>
          <Text numberOfLines={1} style={styles.name}>{chat.name}</Text>

          {chat.gender ? (
            <View style={styles.metaChip}>
              <Ionicons color={genderColor} name={genderIcon} size={11} />
              {chat.age ? <Text style={styles.metaText}>{chat.age}</Text> : null}
            </View>
          ) : null}

          {chat.distance ? <Text style={styles.distanceText}>{chat.distance}</Text> : null}
        </View>

        <View style={styles.snippetLine}>
          {chat.online ? <View style={styles.onlineDot} /> : null}
          <Text numberOfLines={1} style={styles.snippet}>{chat.snippet}</Text>
        </View>
      </View>

      <Text style={styles.time}>{chat.time}</Text>
    </Pressable>
  );
}

export default function ChatListScreen() {
  const [filter, setFilter] = useState<FilterKey>('All');

  const visibleChats = useMemo(() => filterChats(MOCK_CHATS, filter), [filter]);

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Three equal slots rather than space-between: the title has to sit in the middle of the
          bar, and the left label is much wider than the icon on the right. */}
      <View style={styles.header}>
        <View style={styles.headerSide}>
          <Pressable
            accessibilityLabel="Find friends"
            accessibilityRole="button"
            onPress={() => router.push('/find-friends' as never)}
            style={({ pressed }) => [styles.findFriendsHit, pressed && styles.rowPressed]}
          >
            <Text style={styles.findFriends}>Find Friends</Text>
          </Pressable>
        </View>

        <Text style={styles.headerTitle}>Messages</Text>

        <View style={[styles.headerSide, styles.headerSideEnd]}>
          <Pressable
            accessibilityLabel="Menu"
            accessibilityRole="button"
            style={({ pressed }) => [styles.menuHit, pressed && styles.rowPressed]}
          >
            <Ionicons color="#20232A" name="menu-outline" size={24} />
          </Pressable>
        </View>
      </View>

      <View style={styles.filterBar}>
        {FILTERS.map((option) => {
          const isActive = option === filter;

          return (
            <Pressable
              key={option}
              accessibilityLabel={`${option} chats`}
              accessibilityRole="button"
              onPress={() => setFilter(option)}
              style={[styles.filterTab, isActive && styles.filterTabActive]}
            >
              <Text style={[styles.filterText, isActive && styles.filterTextActive]}>{option}</Text>
            </Pressable>
          );
        })}
      </View>

      <FlatList
        contentContainerStyle={styles.list}
        data={visibleChats}
        initialNumToRender={8}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <ChatRow chat={item} />}
        showsVerticalScrollIndicator={false}
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
  filterBar: {
    borderBottomColor: '#E3DED5',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    marginTop: 12,
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
  avatar: {
    backgroundColor: '#E7E2DA',
    borderRadius: 27,
    height: 54,
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
    gap: 6,
    marginBottom: 4,
  },
  name: {
    color: '#20232A',
    flexShrink: 1,
    fontSize: 15,
    fontWeight: '800',
  },
  metaChip: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 2,
  },
  metaText: {
    color: '#656A73',
    fontSize: 11,
    fontWeight: '700',
  },
  distanceText: {
    color: '#A2A7B0',
    fontSize: 11,
    fontWeight: '600',
  },
  snippetLine: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  onlineDot: {
    backgroundColor: '#2FBF71',
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  snippet: {
    color: '#656A73',
    flexShrink: 1,
    fontSize: 13,
  },
  time: {
    color: '#A2A7B0',
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 8,
  },
});