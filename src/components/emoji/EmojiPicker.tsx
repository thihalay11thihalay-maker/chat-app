import { View, ScrollView, TouchableOpacity, StyleSheet, Text } from 'react-native';
import { EMOJIS } from '../../lib/constants';

type EmojiPickerProps = {
  onSelect: (emoji: string) => void;
};

export const EmojiPicker = ({ onSelect }: EmojiPickerProps) => {
  const filteredEmojis = EMOJIS.filter(emoji => emoji.category === 'smileys');
  
  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollViewContent}
      >
        {filteredEmojis.map(emoji => (
          <TouchableOpacity 
            key={emoji.char} 
            style={styles.emojiButton}
            onPress={() => onSelect(emoji.char)}
          >
            <Text style={styles.emojiText}>{emoji.char}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    padding: 8,
    borderRadius: 12,
    marginBottom: 12,
  },
  scrollView: {
    flex: 1,
  },
  scrollViewContent: {
    padding: 4,
  },
  emojiButton: {
    padding: 8,
    margin: 2,
    borderRadius: 12,
    backgroundColor: '#F2F4F7',
  },
  emojiText: {
    fontSize: 24,
  },
});