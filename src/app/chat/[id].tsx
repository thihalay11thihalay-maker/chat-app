import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  addDoc,
  collection,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from 'firebase/firestore';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ChatMessage, MessageBubble } from '@/components/chat-message-bubble';
import { useChatMedia } from '@/hooks/use-chat-media';

import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';

export default function ChatDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chatId = Array.isArray(id) ? id[0] : id || 'chat';
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageText, setMessageText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [loadError, setLoadError] = useState('');
  const flatListRef = useRef<FlatList<ChatMessage>>(null);
  const {
    cancelAudioRecording,
    handleAttachmentPress,
    isAttachmentMenuVisible,
    isRecording,
    isUploading,
    pickMedia,
    recorderDurationSeconds,
    setIsAttachmentMenuVisible,
    startAudioRecording,
    stopAndSendAudio,
  } = useChatMedia(chatId, currentUser);
  const isBusy = isSending || isUploading;

  const openCall = () => {
    router.push(`/call/${encodeURIComponent(chatId)}` as never);
  };

  useEffect(() => {
    const messagesQuery = query(
      collection(getFirebaseDb(), 'chats', chatId, 'messages'),
      orderBy('createdAt', 'asc'),
    );

    return onSnapshot(messagesQuery, (snapshot) => {
      setMessages(snapshot.docs.map((messageDocument) => ({
        ...messageDocument.data(),
        id: messageDocument.id,
      }) as ChatMessage));
      setLoadError('');
    }, (error) => {
      console.error('Failed to load chat messages:', error);
      setLoadError('Could not load messages.');
    });
  }, [chatId]);

  useEffect(() => {
    let unsubscribe = () => {};

    try {
      unsubscribe = onAuthStateChanged(getFirebaseAuth(), setCurrentUser);
    } catch (error) {
      // Firebase is not configured or auth could not initialise. currentUser is
      // already null, so the screen simply behaves as a signed-out visitor.
      console.error('Firebase auth is unavailable:', error);
    }

    return unsubscribe;
  }, []);

  const sendTextMessage = async () => {
    const text = messageText.trim();
    if (!text || !currentUser || isBusy) {
      return;
    }

    setIsSending(true);
    try {
      await addDoc(collection(getFirebaseDb(), 'chats', chatId, 'messages'), {
        createdAt: serverTimestamp(),
        senderId: currentUser.uid,
        text,
        type: 'text',
      });
      setMessageText('');
    } catch (error) {
      console.error('Failed to send message:', error);
      Alert.alert('Message not sent', 'Please try again.');
    } finally {
      setIsSending(false);
    }
  };

  const renderMessage = ({ item }: { item: ChatMessage }) => (
    <MessageBubble isMine={item.senderId === currentUser?.uid} message={item} />
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.backButton}>
            <Text style={styles.backText}>{'<-'}</Text>
          </Pressable>
          {/* flex: 1 takes the space between the back button and the call buttons and hands
              the rest back to them. Without it a long name on Android pushes the buttons off
              screen, and numberOfLines has nothing to shrink into. */}
          <View style={styles.headerTitle}>
            <Text ellipsizeMode="tail" numberOfLines={1} style={styles.eyebrow}>CONVERSATION</Text>
            <Text ellipsizeMode="tail" numberOfLines={1} style={styles.title}>{`Chat ${chatId}`}</Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityLabel="Start phone call"
              accessibilityRole="button"
              onPress={openCall}
              style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
            >
              {/* Ionicons rather than SymbolView: expo-symbols renders through the Material
                  Symbols font, which does not come up on Android here, so those two glyphs
                  were drawing nothing and left the buttons blank. */}
              <Ionicons color="#FFFFFF" name="call-outline" size={19} />
            </Pressable>
            <Pressable
              accessibilityLabel="Start video call"
              accessibilityRole="button"
              onPress={openCall}
              style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
            >
              <Ionicons color="#FFFFFF" name="videocam-outline" size={20} />
            </Pressable>
          </View>
        </View>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={12}
          style={styles.conversation}
        >
          {loadError ? <Text style={styles.loadError}>{loadError}</Text> : null}
          <FlatList
            ref={flatListRef}
            contentContainerStyle={messages.length ? styles.messageList : styles.emptyList}
            data={messages}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={(
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>Start a conversation</Text>
                <Text style={styles.emptySubtitle}>Send a message to start the conversation.</Text>
              </View>
            )}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
            renderItem={renderMessage}
          />

          {isRecording ? (
            <View style={styles.recordingBar}>
              <View style={styles.recordingIndicator} />
              <Text style={styles.recordingText}>
                Recording {recorderDurationSeconds}s
              </Text>
              <Pressable
                accessibilityLabel="Cancel recording"
                onPress={() => void cancelAudioRecording()}
                style={styles.cancelRecordingButton}
              >
                <Text style={styles.cancelRecordingText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityLabel="Stop and send audio"
                onPress={() => void stopAndSendAudio()}
                style={styles.sendAudioButton}
              >
                <SymbolView name={{ ios: 'arrow.up', android: 'send', web: 'send' }} size={18} tintColor="#FFFFFF" />
              </Pressable>
            </View>
          ) : (
            <View style={styles.composer}>
              <Pressable
                accessibilityLabel="Attach media"
                accessibilityRole="button"
                disabled={isBusy}
                onPress={handleAttachmentPress}
                style={({ pressed }) => [styles.attachmentButton, pressed && styles.pressed]}
              >
                <SymbolView name={{ ios: 'plus', android: 'add', web: 'add' }} size={24} tintColor="#363A42" />
              </Pressable>
              <TextInput
                editable={!isBusy}
                onChangeText={setMessageText}
                onSubmitEditing={() => void sendTextMessage()}
                placeholder="Write a message..."
                placeholderTextColor="#8D929C"
                returnKeyType="send"
                style={styles.messageInput}
                value={messageText}
              />
              <Pressable
                accessibilityLabel="Send message"
                accessibilityRole="button"
                disabled={isBusy || !messageText.trim()}
                onPress={() => void sendTextMessage()}
                style={({ pressed }) => [styles.sendButton, pressed && styles.pressed, (!messageText.trim() || isBusy) && styles.sendButtonDisabled]}
              >
                {isBusy ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <SymbolView name={{ ios: 'arrow.up', android: 'send', web: 'send' }} size={18} tintColor="#FFFFFF" />
                )}
              </Pressable>
            </View>
          )}
        </KeyboardAvoidingView>

        <Modal
          animationType="fade"
          onRequestClose={() => setIsAttachmentMenuVisible(false)}
          transparent
          visible={isAttachmentMenuVisible}
        >
          <Pressable onPress={() => setIsAttachmentMenuVisible(false)} style={styles.modalBackdrop}>
            <Pressable onPress={(event) => event.stopPropagation()} style={styles.attachmentSheet}>
              <View style={styles.sheetHandle} />
              <Text style={styles.sheetTitle}>Share something</Text>
              <View style={styles.attachmentOptions}>
                <Pressable onPress={() => void pickMedia('image')} style={styles.attachmentOption}>
                  <View style={[styles.optionIcon, styles.imageOptionIcon]}>
                    <SymbolView name={{ ios: 'photo.fill', android: 'image', web: 'image' }} size={22} tintColor="#FFFFFF" />
                  </View>
                  <Text style={styles.optionLabel}>Image</Text>
                </Pressable>
                <Pressable onPress={() => void pickMedia('video')} style={styles.attachmentOption}>
                  <View style={[styles.optionIcon, styles.videoOptionIcon]}>
                    <SymbolView name={{ ios: 'video.fill', android: 'videocam', web: 'videocam' }} size={22} tintColor="#FFFFFF" />
                  </View>
                  <Text style={styles.optionLabel}>Video</Text>
                </Pressable>
                <Pressable onPress={() => void startAudioRecording()} style={styles.attachmentOption}>
                  <View style={[styles.optionIcon, styles.audioOptionIcon]}>
                    <SymbolView name={{ ios: 'waveform', android: 'mic', web: 'mic' }} size={22} tintColor="#FFFFFF" />
                  </View>
                  <Text style={styles.optionLabel}>Audio</Text>
                </Pressable>
                <Pressable onPress={() => void pickMedia('gif')} style={styles.attachmentOption}>
                  <View style={[styles.optionIcon, styles.gifOptionIcon]}>
                    <Text style={styles.gifIconText}>GIF</Text>
                  </View>
                  <Text style={styles.optionLabel}>GIF</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>

      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  container: {
    flex: 1,
    padding: 28,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
  },
  // The only part of the header allowed to shrink, so a long name truncates with an ellipsis
  // instead of shoving the call buttons off the edge. minWidth 0 lets it shrink below the
  // width of the text itself, which Android needs before the ellipsis appears.
  headerTitle: { flex: 1, minWidth: 0 },
  headerActions: {
    alignItems: 'center',
    flexDirection: 'row',
    // Space between the two icons, and away from the edge of the screen on top of the
    // container padding, so neither is clipped by a rounded corner or a gesture bar.
    gap: 9,
    marginLeft: 'auto',
    marginRight: 15,
  },
  // Dark so a white icon reads on it. The white circle the phone button used to have made a
  // white glyph invisible on the same white fill.
  headerAction: {
    alignItems: 'center',
    backgroundColor: '#20232A',
    borderColor: '#20232A',
    borderRadius: 21,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  backButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 22,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  backText: {
    color: '#20232A',
    fontSize: 18,
    fontWeight: '800',
  },
  eyebrow: {
    color: '#E56B4C',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.6,
    marginBottom: 4,
  },
  title: {
    color: '#20232A',
    // A shade under the size it used to be: the header has a back button and two call buttons
    // to fit alongside, and a long chat id needs the extra room to stay readable.
    fontSize: 22,
    fontWeight: '800',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
  },
  emptyTitle: {
    color: '#20232A',
    fontSize: 30,
    fontWeight: '800',
    marginBottom: 10,
  },
  emptySubtitle: {
    color: '#656A73',
    fontSize: 16,
    lineHeight: 24,
  },
  conversation: {
    flex: 1,
    marginTop: 20,
  },
  messageList: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    paddingBottom: 16,
  },
  emptyList: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  composer: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
    padding: 7,
  },
  attachmentButton: {
    alignItems: 'center',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  messageInput: {
    color: '#20232A',
    flex: 1,
    fontSize: 15,
    maxHeight: 100,
    minHeight: 40,
    paddingHorizontal: 5,
  },
  sendButton: {
    alignItems: 'center',
    backgroundColor: '#E56B4C',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  sendButtonDisabled: {
    opacity: 0.45,
  },
  recordingBar: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginBottom: 8,
    padding: 8,
  },
  recordingIndicator: {
    backgroundColor: '#B84141',
    borderRadius: 5,
    height: 10,
    width: 10,
  },
  recordingText: {
    color: '#363A42',
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
  },
  cancelRecordingButton: {
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  cancelRecordingText: {
    color: '#656A73',
    fontSize: 12,
    fontWeight: '700',
  },
  sendAudioButton: {
    alignItems: 'center',
    backgroundColor: '#E56B4C',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  loadError: {
    color: '#B84141',
    fontSize: 13,
    marginBottom: 8,
  },
  modalBackdrop: {
    backgroundColor: 'rgba(32, 35, 42, 0.35)',
    flex: 1,
    justifyContent: 'flex-end',
  },
  attachmentSheet: {
    backgroundColor: '#FFFDFC',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 32,
    paddingHorizontal: 22,
    paddingTop: 12,
  },
  sheetHandle: {
    alignSelf: 'center',
    backgroundColor: '#D3D1CD',
    borderRadius: 2,
    height: 4,
    marginBottom: 18,
    width: 38,
  },
  sheetTitle: {
    color: '#20232A',
    fontSize: 17,
    fontWeight: '800',
    marginBottom: 20,
  },
  attachmentOptions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  attachmentOption: {
    alignItems: 'center',
    gap: 8,
    width: 66,
  },
  optionIcon: {
    alignItems: 'center',
    borderRadius: 23,
    height: 46,
    justifyContent: 'center',
    width: 46,
  },
  imageOptionIcon: {
    backgroundColor: '#3D765B',
  },
  videoOptionIcon: {
    backgroundColor: '#E56B4C',
  },
  audioOptionIcon: {
    backgroundColor: '#20232A',
  },
  gifOptionIcon: {
    backgroundColor: '#D5A32E',
  },
  gifIconText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
  },
  optionLabel: {
    color: '#363A42',
    fontSize: 12,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.72,
  },
});
