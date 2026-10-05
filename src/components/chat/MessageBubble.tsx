import { View, Text, StyleSheet, Image } from 'react-native';
import { Message } from '../../types';
import { COLORS, formatMessageTime, STICKERS } from '../../lib/constants';
import { VoicePlayer } from '../voice/VoicePlayer';

type MessageBubbleProps = {
  message: Message;
  isMine: boolean;
};

export const MessageBubble = ({ message, isMine }: MessageBubbleProps) => {
  const renderContent = () => {
    switch (message.type) {
      case 'text':
        return <Text style={styles.text}>{message.text}</Text>;

      case 'voice':
        return (
          <VoicePlayer
            uri={message.mediaUrl ?? ''}
            durationSeconds={message.durationSeconds}
          />
        );

      case 'sticker':
        const sticker = STICKERS.find((s) => s.name === message.stickerName);
        if (sticker) {
          return (
            <Image
              source={{ uri: sticker.url }}
              style={styles.sticker}
              resizeMode="contain"
            />
          );
        }
        return <Text style={styles.text}>Sticker: {message.stickerName}</Text>;

      case 'image':
        return (
          <Image
            source={{ uri: message.mediaUrl }}
            style={styles.image}
            resizeMode="cover"
          />
        );

      default:
        return <Text style={styles.text}>Unsupported message</Text>;
    }
  };

  return (
    <View
      style={[
        styles.container,
        isMine ? styles.mine : styles.other,
      ]}
    >
      {!isMine && <Text style={styles.senderName}>{message.senderName}</Text>}
      {renderContent()}
      <Text style={styles.time}>
        {formatMessageTime(message.createdAt)}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    maxWidth: '75%',
    padding: 10,
    borderRadius: 16,
    marginBottom: 8,
  },
  mine: {
    alignSelf: 'flex-end',
    backgroundColor: COLORS.messageMine,
    borderBottomRightRadius: 4,
  },
  other: {
    alignSelf: 'flex-start',
    backgroundColor: COLORS.messageOther,
    borderBottomLeftRadius: 4,
  },
  senderName: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginBottom: 4,
    fontWeight: '500',
  },
  text: {
    fontSize: 15,
    color: COLORS.text,
    lineHeight: 20,
  },
  time: {
    fontSize: 10,
    marginTop: 4,
    alignSelf: 'flex-end',
    color: COLORS.textSecondary,
  },
  sticker: {
    width: 120,
    height: 120,
  },
  image: {
    width: 200,
    height: 200,
    borderRadius: 12,
  },
});

export default MessageBubble;