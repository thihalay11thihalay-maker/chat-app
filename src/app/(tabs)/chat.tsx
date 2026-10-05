import { View, FlatList, StyleSheet, Text } from 'react-native';
import { useRoomList } from '../../hooks/useRoomList';
import { useCurrentUser } from '../../hooks/useCurrentUser';
import { ChatListItem } from '../../components/chat/ChatListItem';
import { EmptyState } from '../../components/common/EmptyState';
import { Loading } from '../../components/common/Loading';
import { COLORS } from '../../lib/constants';
import { router } from 'expo-router';

export default function ChatListScreen() {
  const { user: currentUser } = useCurrentUser();
  const { rooms, participants, loading } = useRoomList(currentUser?.uid ?? '');

  if (loading) {
    return <Loading />;
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Chats</Text>
      </View>

      {rooms.length === 0 ? (
        <EmptyState
          title="No chats yet"
          subtitle="Start a conversation from the Friends tab"
        />
      ) : (
        <FlatList
          data={rooms}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const otherUid = item.participants.find((uid) => uid !== currentUser?.uid);
            const otherUser = otherUid ? participants[otherUid] : undefined;

            return (
              <ChatListItem
                room={item}
                otherUserName={otherUser?.name}
                otherUserAvatar={otherUser?.avatarUrl}
                onPress={() => router.push(`/chat/${item.id}`)}
              />
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.text,
  },
});
