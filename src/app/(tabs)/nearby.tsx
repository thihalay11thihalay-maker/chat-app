import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert } from 'react-native';
import { useNearbyFriends } from '../../hooks/useNearbyFriends';
import { useCurrentUser } from '../../hooks/useCurrentUser';
import { Avatar } from '../../components/common/Avatar';
import { Loading } from '../../components/common/Loading';
import { EmptyState } from '../../components/common/EmptyState';
import { COLORS, distanceBetweenMeters } from '../../lib/constants';
import { router } from 'expo-router';
import { getOrCreateDirectRoom } from '../../lib/rooms';

export default function NearbyScreen() {
  const { user: currentUser } = useCurrentUser();
  const { friends, loading, error, myLocation, refresh } = useNearbyFriends();

  const handleChat = async (friendUid: string) => {
    try {
      const room = await getOrCreateDirectRoom(friendUid);
      router.push(`/chat/${room.id}`);
    } catch (err) {
      Alert.alert('Error', 'Failed to start chat.');
    }
  };

  if (loading) {
    return <Loading />;
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Nearby Friends</Text>
        <TouchableOpacity style={styles.refreshButton} onPress={refresh}>
          <Text style={styles.refreshText}>Refresh</Text>
        </TouchableOpacity>
      </View>

      {error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {friends.length === 0 ? (
        <EmptyState
          title="No nearby friends"
          subtitle="Friends who have location sharing enabled will appear here"
        />
      ) : (
        <FlatList
          data={friends}
          keyExtractor={(item) => item.uid}
          renderItem={({ item }) => {
            const distance = myLocation && item.latitude && item.longitude
              ? distanceBetweenMeters(
                  [myLocation.latitude, myLocation.longitude],
                  [item.latitude, item.longitude],
                )
              : null;

            return (
              <TouchableOpacity
                style={styles.friendRow}
                onPress={() => handleChat(item.uid)}
                activeOpacity={0.7}
              >
                <Avatar name={item.name} photoUrl={item.avatarUrl} size={48} />
                <View style={styles.friendInfo}>
                  <Text style={styles.friendName}>{item.name}</Text>
                  {distance !== null && (
                    <Text style={styles.friendDistance}>
                      {distance < 1000
                        ? `${Math.round(distance)} m`
                        : `${(distance / 1000).toFixed(1)} km`}
                    </Text>
                  )}
                </View>
                <TouchableOpacity
                  style={styles.chatButton}
                  onPress={() => handleChat(item.uid)}
                >
                  <Text style={styles.chatButtonText}>Chat</Text>
                </TouchableOpacity>
              </TouchableOpacity>
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
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
  refreshButton: {
    backgroundColor: COLORS.primaryLight,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  refreshText: {
    color: COLORS.primary,
    fontSize: 13,
    fontWeight: '600',
  },
  errorContainer: {
    backgroundColor: '#FDE8E8',
    padding: 12,
    margin: 16,
    borderRadius: 8,
  },
  errorText: {
    color: COLORS.error,
    fontSize: 14,
  },
  friendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.divider,
  },
  friendInfo: {
    flex: 1,
    marginLeft: 12,
  },
  friendName: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
  },
  friendDistance: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  chatButton: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
  },
  chatButtonText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '600',
  },
});
