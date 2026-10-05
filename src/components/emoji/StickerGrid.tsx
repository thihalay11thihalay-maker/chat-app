import { View, ScrollView, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { STICKERS } from '../../lib/constants';

export const StickerGrid = ({ onSelect }: { onSelect: (stickerName: string) => void }) => {
  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {STICKERS.map((sticker) => (
          <TouchableOpacity
            key={sticker.id}
            style={styles.stickerButton}
            onPress={() => onSelect(sticker.name)}
          >
            <Image
              source={{ uri: sticker.url }}
              style={styles.sticker}
              resizeMode="contain"
            />
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#E4E7EB',
  },
  scrollContent: {
    paddingHorizontal: 8,
  },
  stickerButton: {
    padding: 4,
    marginHorizontal: 4,
  },
  sticker: {
    width: 80,
    height: 80,
  },
});