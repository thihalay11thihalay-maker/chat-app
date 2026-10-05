import { View, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { useState, useRef } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../../lib/constants';

type ComposerProps = {
  onSendText: (text: string) => void;
  onSendVoice: (uri: string, durationMs: number) => void;
  onOpenEmoji: () => void;
  onOpenStickers: () => void;
  onOpenVoice: () => void;
  showEmoji: boolean;
  showStickers: boolean;
  showVoice: boolean;
};

export const Composer = ({
  onSendText,
  onSendVoice,
  onOpenEmoji,
  onOpenStickers,
  onOpenVoice,
  showEmoji,
  showStickers,
  showVoice,
}: ComposerProps) => {
  const [messageText, setMessageText] = useState('');
  const inputRef = useRef<TextInput>(null);

  const handleSend = () => {
    if (!messageText.trim()) return;
    onSendText(messageText.trim());
    setMessageText('');
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.iconButton}
        onPress={onOpenEmoji}
      >
        <Ionicons
          name="happy-outline"
          size={24}
          color={showEmoji ? COLORS.primary : COLORS.textSecondary}
        />
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.iconButton}
        onPress={onOpenStickers}
      >
        <Ionicons
          name="image-outline"
          size={24}
          color={showStickers ? COLORS.primary : COLORS.textSecondary}
        />
      </TouchableOpacity>

      <TextInput
        ref={inputRef}
        style={styles.input}
        placeholder="Type a message..."
        placeholderTextColor={COLORS.placeholder}
        value={messageText}
        onChangeText={setMessageText}
        onSubmitEditing={handleSend}
        returnKeyType="send"
      />

      <TouchableOpacity
        style={styles.iconButton}
        onPress={onOpenVoice}
      >
        <Ionicons
          name="mic-outline"
          size={24}
          color={showVoice ? COLORS.primary : COLORS.textSecondary}
        />
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.iconButton, styles.sendButton]}
        onPress={handleSend}
        disabled={!messageText.trim()}
      >
        <Ionicons name="send" size={20} color="white" />
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    backgroundColor: COLORS.surface,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  iconButton: {
    padding: 8,
    marginHorizontal: 2,
  },
  input: {
    flex: 1,
    height: 40,
    backgroundColor: COLORS.background,
    borderRadius: 20,
    paddingHorizontal: 16,
    fontSize: 15,
    color: COLORS.text,
    marginHorizontal: 4,
  },
  sendButton: {
    backgroundColor: COLORS.primary,
    borderRadius: 20,
    padding: 10,
  },
});

export default Composer;