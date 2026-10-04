import { Ionicons } from '@expo/vector-icons';
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

import { findGifs, GifResult } from '@/lib/gif-search';

/**
 * Searching for a GIF to send.
 *
 * A sheet rather than a screen, for the same reason the attachment sheet is one: this is a detour on the
 * way to sending something, and the conversation behind it is worth being able to see.
 *
 * The grid animates. That is the whole argument for a GIF picker over a list of file names -- a reader
 * choosing between six clips for a reaction is choosing by motion, and a row of still thumbnails turns
 * that decision into six guesses. The service sends a small animation for exactly this purpose and this
 * is what it is for.
 *
 * Searching is on a delay rather than on every keystroke, because this is a search on somebody else's
 * server: one request while somebody is still typing "congrats" is one request, six is six.
 */

/**
 * How long the reader has to stop typing before the search goes out.
 *
 * Long enough that a normal sentence is one search, short enough that it feels like the app is keeping up
 * with them rather than waiting to be asked again.
 */
const SEARCH_DELAY_MS = 350;

type GifPickerProps = {
  /** Called with the chosen GIF. The sheet closes itself first. */
  onSelect: (gif: GifResult) => void;
  /** Sending a GIF that is already on this phone, through the system gallery rather than this search. */
  onSendFromDevice: () => void;
  onClose: () => void;
  visible: boolean;
};

/**
 * Everything the grid draws, plus which search produced it.
 *
 * `term` is the load-bearing field and it is here rather than in a second piece of state so that the
 * grid, the spinner and the error can never disagree about what they are showing. The effect that
 * fetches a first page does not set anything while it runs; it writes here only once the service has
 * answered, and the spinner is derived from `term` not matching what was searched for.
 */
type ResultsState = {
  error: string;
  gifs: GifResult[];
  /** How many pages the grid holds, so the next request is the one after them. */
  page: number;
  /** The search these results came from, or null while none has landed yet. */
  term: string | null;
};

/** Nothing has been fetched: which also means the grid is still loading its first page. */
const NO_RESULTS: ResultsState = { error: '', gifs: [], page: 0, term: null };

export function GifPicker({ onClose, onSelect, onSendFromDevice, visible }: GifPickerProps) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  // What has been typed, once the delay has passed. The box and the search are therefore allowed to
  // disagree for a moment, which is what makes typing feel immediate while the network does not.
  const [searched, setSearched] = useState('');
  const [results, setResults] = useState<ResultsState>(NO_RESULTS);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // Bumped by the retry button. It is a dependency of the fetching effect rather than an argument to
  // it, so retrying takes the same path as searching rather than a second near-identical one.
  const [reloadCount, setReloadCount] = useState(0);

  // Which request was asked for last, so a slow answer for "cat" cannot land on a grid that has already
  // moved on to "cat meme".
  const requestId = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setSearched(query.trim()), SEARCH_DELAY_MS);

    return () => clearTimeout(timer);
  }, [query]);

  // The first page, for the current search and whenever the sheet is opened.
  //
  // Nothing here is written while the request is in flight. The results land in the callbacks, and the
  // spinner comes from comparing `term` against what was searched for, so opening the sheet does not
  // cost an extra render before the request has even gone out.
  useEffect(() => {
    if (!visible) {
      return undefined;
    }

    const id = (requestId.current += 1);
    let cancelled = false;

    void findGifs(searched, 1)
      .then((found) => {
        if (cancelled || id !== requestId.current) {
          return;
        }

        setResults({ error: '', gifs: found, page: 1, term: searched });
      })
      .catch((caught: unknown) => {
        if (cancelled || id !== requestId.current) {
          return;
        }

        // A failed first page replaces the grid with the reason, because an empty grid beside an empty
        // search box reads as a broken screen rather than as a failed search.
        setResults({
          error: caught instanceof Error ? caught.message : 'The GIF search failed.',
          gifs: [],
          page: 0,
          term: searched,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [reloadCount, searched, visible]);

  /**
   * The next page.
   *
   * Kept off the effect because paging is something the reader asks for by scrolling, which is an
   * event rather than something to be derived: the sheet writes the pending flag here, where a press
   * already costs a render.
   */
  const loadMore = useCallback(() => {
    // A later page while the first is still out, or while another page is already out, would ask for
    // the same page twice and land two copies of it in the grid.
    if (isLoadingMore || results.term !== searched || results.gifs.length === 0) {
      return;
    }

    const nextPage = results.page + 1;
    const id = (requestId.current += 1);

    setIsLoadingMore(true);

    void findGifs(searched, nextPage)
      .then((found) => {
        if (id !== requestId.current) {
          return;
        }

        setResults((current) => (current.term === searched && current.page === nextPage - 1
          ? { ...current, gifs: [...current.gifs, ...found], page: nextPage }
          : current));
      })
      .catch(() => {
        // Nothing, on purpose. A failed later page leaves what is already there, because losing twelve
        // GIFs somebody was already looking at to show an error would be the worse of the two.
      })
      .finally(() => {
        if (id === requestId.current) {
          setIsLoadingMore(false);
        }
      });
  }, [isLoadingMore, results, searched]);

  /**
   * Whether the grid on screen belongs to what has been searched for.
   *
   * The one place the two are compared, so the spinner cannot appear over results from a search the
   * reader has already moved on from.
   */
  const isSettled = results.term === searched;
  const isLoading = visible && !isSettled;
  const error = isSettled ? results.error : '';

  const retry = useCallback(() => {
    // Clearing first means the spinner replaces the error on this press rather than on the answer, and
    // the effect below goes out again from a term that no longer matches.
    setResults(NO_RESULTS);
    setReloadCount((current) => current + 1);
  }, []);

  // The grid reads its GIFs straight off the results. Each cell draws the small animation when there is
  // one and the still otherwise, and the still is also what a cell falls back to while the animation is
  // still arriving, which is why both are handed to the image below.
  const cells = results.gifs;

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <Pressable onPress={onClose} style={styles.backdrop}>
        <Pressable onPress={(event) => event.stopPropagation()} style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Gifs</Text>

            <Pressable
              accessibilityLabel="Close"
              accessibilityRole="button"
              hitSlop={10}
              onPress={onClose}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            >
              <Ionicons color="#20232A" name="close" size={20} />
            </Pressable>
          </View>

          <View style={styles.searchBar}>
            <Ionicons color="#8D929C" name="search" size={16} />
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setQuery}
              placeholder="Search gifs"
              placeholderTextColor="#8D929C"
              returnKeyType="search"
              style={styles.searchInput}
              value={query}
            />
          </View>

          {isLoading ? (
            <View style={styles.stateBox}>
              <ActivityIndicator color="#2FBF71" />
              <Text style={styles.stateText}>
                {searched === '' ? 'Loading trending gifs...' : `Searching for "${searched}"...`}
              </Text>
            </View>
          ) : error !== '' ? (
            <View style={styles.stateBox}>
              <Ionicons color="#C0392B" name="cloud-offline-outline" size={22} />
              <Text style={styles.stateText}>{error}</Text>
              <Pressable
                accessibilityLabel="Try again"
                accessibilityRole="button"
                onPress={retry}
                style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
              >
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </View>
          ) : (
            <FlatList
              contentContainerStyle={styles.grid}
              data={cells}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={(
                <View style={styles.stateBox}>
                  <Text style={styles.stateText}>Nothing came back for that.</Text>
                </View>
              )}
              numColumns={3}
              // A picker is for one picture, not a library: a fixed screen of results with the next page
              // a scroll away is enough to find something, and stops a reader from falling into an
              // endless grid on a metered connection.
              onEndReached={loadMore}
              onEndReachedThreshold={0.6}
              renderItem={({ item }) => (
                <Pressable
                  accessibilityLabel={item.title}
                  accessibilityRole="button"
                  onPress={() => {
                    // Closed before the send, because the send closes this and a sheet on top of a sheet
                    // is two things to dismiss for one choice.
                    onClose();
                    onSelect(item);
                  }}
                  style={({ pressed }) => [styles.cell, pressed && styles.cellPressed]}
                >
                  {/* The still underneath and the animation on top of it: the cell is never empty while
                      the animation is still arriving, and never blank if it never does. */}
                  <Image
                    contentFit="cover"
                    recyclingKey={item.id}
                    source={{ uri: item.previewUrl }}
                    style={StyleSheet.absoluteFill}
                    transition={100}
                  />

                  {item.animatedPreviewUrl ? (
                    <Image
                      autoplay
                      contentFit="cover"
                      recyclingKey={`${item.id}-animated`}
                      source={{ uri: item.animatedPreviewUrl }}
                      style={StyleSheet.absoluteFill}
                      transition={100}
                    />
                  ) : null}
                </Pressable>
              )}
            />
          )}

          {/* Sending something already on this phone, which was the old way in and is still a way in:
              somebody's favourite reaction is usually already in their gallery. */}
          <Pressable
            accessibilityLabel="Send a gif from your device"
            accessibilityRole="button"
            onPress={() => {
              onClose();
              onSendFromDevice();
            }}
            style={({ pressed }) => [
              styles.deviceRow,
              { paddingBottom: 12 + insets.bottom },
              pressed && styles.pressed,
            ]}
          >
            <Ionicons color="#2FBF71" name="phone-portrait-outline" size={18} />
            <Text style={styles.deviceText}>From your device</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: 'rgba(32, 35, 42, 0.45)',
    flex: 1,
    justifyContent: 'flex-end',
  },
  // Tall rather than half the screen: a GIF is chosen by looking at it, and a sheet that shows three rows
  // makes the reader page for every single choice.
  sheet: {
    backgroundColor: '#FFFDFC',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    height: '86%',
    paddingHorizontal: 14,
    paddingTop: 12,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  title: {
    color: '#20232A',
    fontSize: 17,
    fontWeight: '800',
  },
  closeButton: {
    alignItems: 'center',
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  searchBar: {
    alignItems: 'center',
    backgroundColor: '#F2EEE8',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    paddingHorizontal: 12,
  },
  searchInput: {
    color: '#20232A',
    flex: 1,
    fontSize: 15,
    paddingVertical: 10,
  },
  grid: {
    gap: 6,
    paddingBottom: 8,
  },
  // A square cell whatever the GIF's own proportions, so a grid of them is a grid. The still is cropped
  // rather than letterboxed because a strip of letterbox bars between two GIFs is noise.
  cell: {
    aspectRatio: 1,
    backgroundColor: '#E7E2DA',
    borderRadius: 10,
    flex: 1,
    overflow: 'hidden',
  },
  cellPressed: {
    opacity: 0.7,
  },
  stateBox: {
    alignItems: 'center',
    gap: 10,
    paddingVertical: 28,
  },
  stateText: {
    color: '#8D929C',
    fontSize: 13,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: '#2FBF71',
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  deviceRow: {
    alignItems: 'center',
    borderTopColor: '#E7E2DA',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 9,
    paddingHorizontal: 6,
    paddingTop: 12,
  },
  deviceText: {
    color: '#2FBF71',
    fontSize: 14,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.7,
  },
});