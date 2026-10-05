import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Room } from '../../types';
import { Avatar } from '../common/Avatar';
import { COLORS, formatTime } from '../../lib/constants';

type ChatListItemProps = {
  room: Room;
  otherUserName?: string;
  otherUserAvatar?: string;
  onPress: () => void;
};

export const ChatListItem = ({
  room,
  otherUserName,
  otherUserAvatar,
  onPress,
}: ChatListItemProps) => {
  const isGroup = room.kind === 'group';
  const displayName = isGroup
    ? room.name ?? 'Group chat'
    : otherUserName ?? 'Unknown';
  const avatarUrl = isGroup ? room.avatarUrl : otherUserAvatar;

  return (
    <TouchableOpacity
      style={styles.container}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Avatar
        name={displayName}
        photoUrl={avatarUrl}
        size={48}
      />

      <View style={styles.info}>
        <View style={styles.headerRow}>
          <Text style={styles.name} numberOfLines={1}>
            {displayName}
          </Text>
          {room.lastMessageTime && (
            <Text style={styles.time}>
              {formatTime(room.lastMessageTime)}
            </Text>
          )}
        </View>

        <View style={styles.previewRow}>
          <Text
            style={styles.preview}
            numberOfLines={1}
          >
            {room.lastMessage ?? 'No messages yet'}
          </Text>
          {room.unreadCount ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{room.unreadCount}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.divider,
  },
  info: {
    flex: 1,
    marginLeft: 12,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
    flex: 1,
    marginRight: 8,
  },
  time: {
    fontSize: 12,
    color: COLORS.placeholder,
  },
  previewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  preview: {
    fontSize: 14,
    color: COLORS.textSecondary,
    flex: 1,
    marginRight: 8,
  },
  badge: {
    backgroundColor: COLORS.primary,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  badgeText: {
    color: 'white',
    fontSize: 11,
    fontWeight: '700',
  },
});

export default ChatListItem;