import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { ChatHeader } from '../../components/chat/ChatHeader';
import { Composer } from '../../components/chat/Composer';
import { MessageBubble } from '../../components/chat/MessageBubble';
import { EmojiPicker } from '../../components/emoji/EmojiPicker';
import { StickerGrid } from '../../components/emoji/StickerGrid';
import { VoiceRecorder } from '../../components/voice/VoiceRecorder';
import { useCurrentUser } from '../../hooks/useCurrentUser';
import { useMessages } from '../../hooks/useMessages';
import { COLORS } from '../../lib/constants';

const AI_API_URL = 'http://192.168.1.12:3000/api/chat';

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user: currentUser } = useCurrentUser();
  const { messages, loading, sendMessage, markAsRead } = useMessages(id);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showStickers, setShowStickers] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [isBotReplying, setIsBotReplying] = useState(false);
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
    if (!text.trim()) return;

    // 1. User sends message
    await sendMessage('text', { text });
    setShowEmoji(false);
    setShowStickers(false);

    // 2. Call AI Server
    setIsBotReplying(true);
    try {
      const response = await fetch(AI_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });

      if (!response.ok) {
        throw new Error(`AI Server error: ${response.status}`);
      }

      const data = await response.json();

      if (!data.reply || typeof data.reply !== 'string') {
        await sendMessage('text', {
          text: data.error || 'AI did not return a valid response.',
          isBot: true,
        });
        return;
      }

      // 3. Send AI response as bot message
      await sendMessage('text', {
        text: data.reply,
        isBot: true,
      });
    } catch (error) {
      console.error('AI Error:', error);
      Alert.alert('AI Error', 'Could not get AI response. Check server connection.');
    } finally {
      setIsBotReplying(false);
    }
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

  return (
    <View style={styles.container}>
      <ChatHeader
        title="Chat"
        onBack={() => router.back()}
      />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        {loading ? (
          <View style={styles.loadingContainer}>
            <Text style={styles.loadingText}>Loading messages...</Text>
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

        {isBotReplying && (
          <View style={styles.botTyping}>
            <Text style={styles.botTypingText}>Bot is typing...</Text>
          </View>
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
          disabled={isBotReplying}
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
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: COLORS.textSecondary,
    fontSize: 14,
  },
  messagesContainer: {
    padding: 12,
    paddingBottom: 8,
  },
  botTyping: {
    padding: 8,
    alignItems: 'center',
  },
  botTypingText: {
    fontSize: 13,
    color: COLORS.textSecondary,
    fontStyle: 'italic',
  },
});
