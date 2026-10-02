import { Ionicons } from '@expo/vector-icons';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CAMERA_FILTERS, CameraFilter } from '@/lib/filters';

import { FilterSwatch } from './filter-swatch';

interface FilterSheetProps {
  onClose: () => void;
  onSelect: (filter: CameraFilter) => void;
  selectedId: string;
  visible: boolean;
}

/**
 * The filter picker for the capture screen: a sheet over the camera with the looks in a
 * horizontal row, the selected one ringed.
 *
 * A sheet rather than a separate screen, because the frame behind it is the point: the user is
 * choosing a look against the picture they are about to take, so it must not stop being visible.
 * No blur: the sheet sits on a solid dark fill and the camera keeps running behind it.
 */
export function FilterSheet({ onClose, onSelect, selectedId, visible }: FilterSheetProps) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      transparent
      visible={visible}
    >
      <View style={styles.root}>
        {/* Tapping the camera behind dismisses without picking a look. */}
        <Pressable accessibilityLabel="Close filters" onPress={onClose} style={styles.backdrop} />

        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={styles.header}>
            <View style={styles.handle} />

            <View style={styles.headerRow}>
              <Text style={styles.title}>Filters</Text>
              <Pressable
                accessibilityLabel="Close filters"
                accessibilityRole="button"
                onPress={onClose}
                style={styles.closeButton}
              >
                <Ionicons color="#FFFFFF" name="close" size={22} />
              </Pressable>
            </View>
          </View>

          {/* The row scrolls sideways because the looks do not all fit a narrow phone, and the
              selected one is scrolled back into view so the sheet never opens on the wrong one. */}
          <FlatList
            contentContainerStyle={styles.listContent}
            data={CAMERA_FILTERS}
            horizontal
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => {
              const isSelected = item.id === selectedId;

              return (
                <Pressable
                  accessibilityLabel={`Use the ${item.label} filter`}
                  accessibilityRole="button"
                  onPress={() => onSelect(item)}
                  style={styles.cell}
                >
                  <View style={[styles.swatch, isSelected && styles.swatchSelected]}>
                    {/* The swatch runs the filter's own matrix, so it previews the real thing
                        rather than a flat block with the viewfinder tints stacked on it. */}
                    <FilterSwatch filter={item} style={styles.swatchFill} />

                    {isSelected ? (
                      <View pointerEvents="none" style={styles.swatchCheck}>
                        <Ionicons color="#FFFFFF" name="checkmark" size={14} />
                      </View>
                    ) : null}
                  </View>

                  <Text
                    numberOfLines={1}
                    style={[styles.cellLabel, isSelected && styles.cellLabelSelected]}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              );
            }}
            showsHorizontalScrollIndicator={false}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { backgroundColor: 'rgba(0, 0, 0, 0.35)', flex: 1 },
  // The same dark fill as the music sheet, so the two overlays belong to one surface.
  sheet: {
    backgroundColor: '#111827',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    overflow: 'hidden',
    paddingTop: 8,
  },
  header: { paddingHorizontal: 16 },
  handle: {
    alignSelf: 'center',
    backgroundColor: '#4B5563',
    borderRadius: 2,
    height: 4,
    marginBottom: 10,
    width: 40,
  },
  headerRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  title: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  closeButton: { padding: 4 },
  listContent: { gap: 14, paddingHorizontal: 16, paddingVertical: 14 },
  cell: { alignItems: 'center', gap: 7, width: 66 },
  // The ring is drawn by the parent rather than as a border on the swatch, so the colour inside
  // it is not tinted by the selection.
  swatch: {
    borderColor: 'rgba(255, 255, 255, 0.25)',
    borderRadius: 12,
    borderWidth: 2,
    height: 62,
    overflow: 'hidden',
    width: 62,
  },
  swatchSelected: {
    borderColor: '#FFFFFF',
    borderWidth: 3,
  },
  swatchFill: {
    flex: 1,
    width: '100%',
  },
  swatchCheck: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 11,
    height: 22,
    justifyContent: 'center',
    position: 'absolute',
    right: 4,
    top: 4,
    width: 22,
  },
  cellLabel: {
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 11,
    fontWeight: '700',
  },
  cellLabelSelected: {
    color: '#FFFFFF',
  },
});