import { View, Text, FlatList, StyleSheet, KeyboardAvoidingView, Platform, TouchableOpacity } from 'react-native';
import { useEffect, useState, useRef } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useMessages } from '../../hooks/useMessages';
import { useCurrentUser } from '../../hooks/useCurrentUser';
import { useRoom } from '../../hooks/useRoomList';
import { MessageBubble } from '../../components/chat/MessageBubble';
import { ChatHeader } from '../../components/chat/ChatHeader';
import { Composer } from '../../components/chat/Composer';
import { EmojiPicker } from '../../components/emoji/EmojiPicker';
import { StickerGrid } from '../../components/emoji/StickerGrid';
import { VoiceRecorder } from '../../components/voice/VoiceRecorder';
import { Loading } from '../../components/common/Loading';
import { COLORS } from '../../lib/constants';

export default function GroupChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user: currentUser } = useCurrentUser();
  const { room, loading: roomLoading } = useRoom(id);
  const { messages, loading, sendMessage, markAsRead } = useMessages(id);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showStickers, setShowStickers] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.senderId !== currentUser?.uid) {
        markAsRead(lastMessage.id);
      }
    }
  }, [messages, currentUser?.uid, markAsRead]);

  const handleSendText = async (text: string) => {
    await sendMessage('text', { text });
    setShowEmoji(false);
    setShowStickers(false);
  };

  const handleEmojiSelect = (emoji: string) => {
    sendMessage('text', { text: emoji });
    setShowEmoji(false);
  };

  const handleStickerSelect = (stickerName: string) => {
    sendMessage('sticker', { stickerName });
    setShowStickers(false);
  };

  const handleVoiceRecorded = async (uri: string, durationMs: number) => {
    await sendMessage('voice', {
      mediaUrl: uri,
      durationSeconds: Math.round(durationMs / 1000),
    });
    setShowVoice(false);
  };

  if (roomLoading || loading) {
    return <Loading />;
  }

  return (
    <View style={styles.container}>
      <ChatHeader
        title={room?.name ?? 'Group Chat'}
        onBack={() => router.back()}
      />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        {messages.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Ionicons name="chatbubbles-outline" size={64} color={COLORS.placeholder} />
            <Text style={styles.emptyText}>No messages yet</Text>
            <Text style={styles.emptySubtext}>Say hello to the group!</Text>
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <MessageBubble
                message={item}
                isMine={item.senderId === currentUser?.uid}
              />
            )}
            contentContainerStyle={styles.messagesContainer}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
          />
        )}

        {showEmoji && <EmojiPicker onSelect={handleEmojiSelect} />}
        {showStickers && <StickerGrid onSelect={handleStickerSelect} />}
        {showVoice && (
          <VoiceRecorder
            onRecordingComplete={handleVoiceRecorded}
            onCancel={() => setShowVoice(false)}
          />
        )}

        <Composer
          onSendText={handleSendText}
          onSendVoice={handleVoiceRecorded}
          onOpenEmoji={() => {
            setShowEmoji(!showEmoji);
            setShowStickers(false);
            setShowVoice(false);
          }}
          onOpenStickers={() => {
            setShowStickers(!showStickers);
            setShowEmoji(false);
            setShowVoice(false);
          }}
          onOpenVoice={() => {
            setShowVoice(!showVoice);
            setShowEmoji(false);
            setShowStickers(false);
          }}
          showEmoji={showEmoji}
          showStickers={showStickers}
          showVoice={showVoice}
        />
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  flex: {
    flex: 1,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginTop: 16,
  },
  emptySubtext: {
    fontSize: 14,
    color: COLORS.placeholder,
    marginTop: 4,
  },
  messagesContainer: {
    padding: 12,
    paddingBottom: 8,
  },
});