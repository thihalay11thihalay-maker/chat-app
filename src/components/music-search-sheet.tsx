import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Image } from 'expo-image';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MusicTrack, resolveStreamUrl, searchTracks } from '@/lib/music';

interface MusicSearchSheetProps {
  onClose: () => void;
  onSelect: (track: MusicTrack) => void;
  selectedId?: string;
  visible: boolean;
}

// Kept dim under the post's own audio, the same level the feed plays an attached song at.
const PREVIEW_VOLUME = 0.4;

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '';
  }

  return `${Math.floor(seconds / 60)}:${`${seconds % 60}`.padStart(2, '0')}`;
}

export function MusicSearchSheet({ onClose, onSelect, selectedId, visible }: MusicSearchSheetProps) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [previewId, setPreviewId] = useState('');
  const [resolvingId, setResolvingId] = useState('');
  // One player for the whole list, swapped with replace, instead of a player per row.
  const player = useAudioPlayer(null);
  const playerStatus = useAudioPlayerStatus(player);
  const requestRef = useRef<AbortController | null>(null);

  // A preview sits under the post's own audio, the same level the feed plays an attached song
  // at, so auditioning a track sounds like it will once it is on the post.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability -- the player is an imperative native object, not render data.
    player.volume = PREVIEW_VOLUME;
  }, [player]);

  // A preview must not keep playing behind the create post form once the sheet is closed.
  useEffect(() => {
    if (!visible) {
      player.pause();
      requestRef.current?.abort();
    }
  }, [player, visible]);

  useEffect(() => {
    return () => {
      requestRef.current?.abort();
    };
  }, []);

  const runSearch = useCallback(async () => {
    const trimmed = query.trim();

    // An empty box is refused before the request, since Audius answers it with tracks that
    // have nothing to do with what was typed.
    if (!trimmed) {
      setTracks([]);
      setHasSearched(false);
      setErrorMessage('Type a song or an artist to search for.');
      return;
    }

    // A search that is still running is abandoned: a slow earlier response landing last would
    // replace the newer results.
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;

    setIsSearching(true);
    setErrorMessage('');

    try {
      const found = await searchTracks(trimmed, controller.signal);
      setTracks(found);
      setHasSearched(true);
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      console.error('Could not search Audius:', error);
      setTracks([]);
      setHasSearched(true);
      setErrorMessage(
        error instanceof Error ? error.message : 'Could not reach Audius. Check your connection.',
      );
    } finally {
      if (!controller.signal.aborted) {
        setIsSearching(false);
      }
    }
  }, [query]);

  const togglePreview = useCallback(async (track: MusicTrack) => {
    if (!track.isStreamable || resolvingId) {
      return;
    }

    if (previewId === track.id) {
      if (playerStatus.playing) {
        player.pause();
      } else {
        player.play();
      }

      return;
    }

    setResolvingId(track.id);

    try {
      // The search result carries no audio URL, so one is fetched before anything can play.
      const streamUrl = await resolveStreamUrl(track.id);

      player.replace({ uri: streamUrl });
      setPreviewId(track.id);
      player.play();
    } catch (error) {
      console.error('Could not preview the track:', error);
      setErrorMessage(error instanceof Error ? error.message : 'Could not play that track.');
    } finally {
      setResolvingId('');
    }
  }, [player, playerStatus.playing, previewId, resolvingId]);

  const close = useCallback(() => {
    player.pause();
    onClose();
  }, [onClose, player]);

  const renderTrack = useCallback(({ item }: { item: MusicTrack }) => {
    const isResolving = resolvingId === item.id;
    const isPreviewing = previewId === item.id && playerStatus.playing;
    const isSelected = selectedId === item.id;

    return (
      <View style={styles.row}>
        <Pressable
          accessibilityLabel={isPreviewing ? `Pause ${item.title}` : `Play ${item.title}`}
          accessibilityRole="button"
          disabled={!item.isStreamable || Boolean(resolvingId)}
          onPress={() => void togglePreview(item)}
          style={styles.cover}
        >
          {item.imageUrl ? (
            <Image contentFit="cover" source={{ uri: item.imageUrl }} style={styles.coverImage} />
          ) : (
            <Ionicons color="#9CA3AF" name="musical-notes" size={20} />
          )}

          <View pointerEvents="none" style={styles.coverBadge}>
            {isResolving ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Ionicons
                color="#FFFFFF"
                name={isPreviewing ? 'pause' : 'play'}
                size={14}
              />
            )}
          </View>
        </Pressable>

        <Pressable
          accessibilityLabel={`Use ${item.title} by ${item.artist}`}
          accessibilityRole="button"
          style={styles.rowBody}
          onPress={() => onSelect(item)}
        >
          <Text numberOfLines={1} style={styles.trackTitle}>{item.title}</Text>
          <Text numberOfLines={1} style={styles.trackArtist}>
            {item.isStreamable
              ? [item.artist, formatDuration(item.duration)].filter(Boolean).join(' · ')
              : `${item.artist} · not streamable`}
          </Text>
        </Pressable>

        <Pressable
          accessibilityLabel={isSelected ? `${item.title} selected` : `Select ${item.title}`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => onSelect(item)}
        >
          <Ionicons
            color={isSelected ? '#3B82F6' : '#6B7280'}
            name={isSelected ? 'checkmark-circle' : 'add-circle-outline'}
            size={24}
          />
        </Pressable>
      </View>
    );
  }, [onSelect, playerStatus.playing, previewId, resolvingId, selectedId, togglePreview]);

  return (
    <Modal
      animationType="slide"
      onRequestClose={close}
      transparent
      visible={visible}
    >
      <View style={styles.root}>
        <Pressable accessibilityLabel="Close songs" onPress={close} style={styles.backdrop} />

        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.handle} />
            <View style={styles.headerRow}>
              <Text style={styles.title}>Select a sound</Text>
              <Pressable
                accessibilityLabel="Close songs"
                accessibilityRole="button"
                onPress={close}
                style={styles.closeButton}
              >
                <Ionicons color="#FFFFFF" name="close" size={22} />
              </Pressable>
            </View>
          </View>

          <View style={styles.searchRow}>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isSearching}
              onChangeText={setQuery}
              onSubmitEditing={() => void runSearch()}
              placeholder="Search songs or artists"
              placeholderTextColor="#6B7280"
              returnKeyType="search"
              style={styles.searchInput}
              value={query}
            />

            <Pressable
              accessibilityLabel="Search"
              accessibilityRole="button"
              disabled={isSearching}
              onPress={() => void runSearch()}
              style={({ pressed }) => [styles.searchButton, pressed && styles.searchButtonPressed]}
            >
              {isSearching ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={styles.searchButtonText}>Search</Text>
              )}
            </Pressable>
          </View>

          {errorMessage ? (
            <View style={styles.notice}>
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          ) : isSearching ? (
            <View style={styles.notice}>
              <ActivityIndicator color="#FFFFFF" />
            </View>
          ) : hasSearched && tracks.length === 0 ? (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>No songs found. Try another search.</Text>
            </View>
          ) : tracks.length === 0 ? (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>Search Audius for a song to add to your post.</Text>
            </View>
          ) : (
            <FlatList
              contentContainerStyle={styles.listContent}
              data={tracks}
              keyboardShouldPersistTaps="handled"
              keyExtractor={(item) => item.id}
              renderItem={renderTrack}
            />
          )}

          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
            <Text style={styles.footerNote}>
              {`Music from Audius · ${tracks.length > 0 ? `${tracks.length} results` : 'the artist is credited on your post'}`}
            </Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { backgroundColor: 'rgba(0, 0, 0, 0.35)', flex: 1 },
  // The same dark fill as the comment sheet, so the two overlays belong to the same surface.
  sheet: {
    backgroundColor: '#111827',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    maxHeight: '78%',
    minHeight: '45%',
    overflow: 'hidden',
  },
  header: { paddingHorizontal: 16, paddingTop: 8 },
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
  searchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 12,
  },
  searchInput: {
    backgroundColor: '#1F2937',
    borderRadius: 12,
    color: '#FFFFFF',
    flex: 1,
    fontSize: 15,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  searchButton: {
    alignItems: 'center',
    backgroundColor: '#2563EB',
    borderRadius: 12,
    height: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  searchButtonPressed: { opacity: 0.72 },
  searchButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  listContent: { paddingBottom: 8, paddingHorizontal: 8, paddingTop: 10 },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 8,
    paddingVertical: 9,
  },
  cover: {
    alignItems: 'center',
    backgroundColor: '#1F2937',
    borderRadius: 10,
    height: 48,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 48,
  },
  coverImage: { height: '100%', width: '100%' },
  coverBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 11,
    height: 22,
    justifyContent: 'center',
    position: 'absolute',
    width: 22,
  },
  rowBody: { flex: 1, minWidth: 0, paddingVertical: 2 },
  trackTitle: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  trackArtist: { color: '#9CA3AF', fontSize: 12, marginTop: 2 },
  notice: { alignItems: 'center', paddingHorizontal: 20, paddingVertical: 28 },
  noticeText: { color: '#9CA3AF', fontSize: 13, textAlign: 'center' },
  errorText: { color: '#F87171', fontSize: 13, textAlign: 'center' },
  footer: {
    borderTopColor: '#1F2937',
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  footerNote: { color: '#6B7280', fontSize: 11, lineHeight: 16 },
});