import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useCallback, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Modal,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    useWindowDimensions,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AlbumItem } from '@/lib/chat-messages';
import { formatDuration } from '@/lib/format-duration';
import { albumItemMedia, saveMediaToPhone } from '@/lib/media-cache';

/**
 * A whole album, one page at a time, full screen.
 *
 * The app's own modal rather than handing the address to the browser, which is what tapping a photograph
 * used to do. That answered "can I see this picture" and nothing else: there was no way to reach the other
 * nine, no way back, and a reader who opened a photograph from a conversation ended up on a web page with
 * no sign that a conversation existed.
 *
 * `messageId` comes in with the items rather than being derived from them, because the cache names a file
 * after the thing that points at it: without it, the ten files of one album would overwrite each other and
 * saving the third would save the seventh.
 */

type MediaViewerProps = {
    items: AlbumItem[];
    messageId: string;
    onClose: () => void;
    /** Which of the items it was opened on. A single photograph opens at zero. */
    startIndex?: number;
};

type SaveState = 'idle' | 'saving' | 'saved';

export function MediaViewer({ items, messageId, onClose, startIndex = 0 }: MediaViewerProps) {
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const [index, setIndex] = useState(startIndex);
    // One state per page rather than one for the album, because "3 of 10 saved" and "all ten saved" are
    // different states and a single flag can only ever say one of them. Left as a record rather than a
    // count so that swiping back and forth does not reset what has already been saved.
    const [saveStates, setSaveStates] = useState<Record<number, SaveState>>({});
    const [, requestSavePermission] = MediaLibrary.usePermissions({
        writeOnly: true,
        granularPermissions: ['photo', 'video'],
    });

    const current = items[index];
    const saveState = saveStates[index] ?? 'idle';

    const save = useCallback(() => {
        if (!current || saveState !== 'idle') {
            return;
        }

        setSaveStates((existing) => ({ ...existing, [index]: 'saving' }));

        void (async () => {
            try {
                const permission = await requestSavePermission();
                let granted = permission?.granted ?? false;

                // Android asks for nothing in order to write into the gallery -- any app may add its own
                // files there -- so a refusal is not an answer on that platform and the save is attempted
                // anyway. iOS asks properly and the refusal is final.
                if (!granted && Platform.OS === 'android') {
                    granted = true;
                }

                if (!granted) {
                    throw new Error('Convo needs permission to save to your gallery.');
                }

                // Downloaded to a local file first, because `Asset.create` takes a path on this device and
                // not an address on somebody else's server. The same cache the pictures on screen came from,
                // so a file the reader has already looked at does not get fetched a second time to be saved.
                await saveMediaToPhone(albumItemMedia(messageId, index, current));
                setSaveStates((existing) => ({ ...existing, [index]: 'saved' }));
            } catch (error) {
                setSaveStates((existing) => {
                    const next = { ...existing };
                    delete next[index];

                    return next;
                });

                // Said rather than only logged: a button that does nothing visible when pressed is a button
                // that looks broken, and the reader cannot tell a refused permission from a failed download
                // unless they are told which it was.
                Alert.alert(
                    'Not saved',
                    error instanceof Error ? error.message : 'Your device would not accept the file.',
                );
            }
        })();
    }, [current, index, messageId, requestSavePermission, saveState]);

    return (
        <Modal animationType="fade" onRequestClose={onClose} transparent visible>
            <View style={styles.screen}>
                {/*
                  A flat list rather than a hand-rolled pager, so that swiping between photographs is the
                  platform's own paging and feels like every other photo the phone has ever shown. Windowed
                  hard -- one page rendered, one batched, three pages of window -- because the alternative is
                  decoding ten images at once, which on a low-memory Android kills the app rather than
                  showing a photograph.
                */}
                <FlatList
                    data={items}
                    // The video on a page has to be told which page is current, and a FlatList only
                    // re-renders a cell when its data changes. Without this, swiping to a clip leaves the
                    // cell exactly as it was and there is nothing to press play on.
                    extraData={index}
                    getItemLayout={(_, itemIndex) => ({
                        index: itemIndex,
                        length: width,
                        offset: width * itemIndex,
                    })}
                    horizontal
                    initialNumToRender={1}
                    initialScrollIndex={startIndex}
                    keyExtractor={(item, itemIndex) => `${item.mediaUrl}-${itemIndex}`}
                    maxToRenderPerBatch={1}
                    onMomentumScrollEnd={(event) => {
                        const next = Math.round(event.nativeEvent.contentOffset.x / width);

                        if (next !== index && next >= 0 && next < items.length) {
                            setIndex(next);
                        }
                    }}
                    renderItem={({ item, index: itemIndex }) => (
                        <View style={[styles.page, { width }]}>
                            {item.type === 'video' && itemIndex === index ? (
                                <AlbumVideo uri={item.mediaUrl} />
                            ) : (
                                <Image
                                    cachePolicy="memory-disk"
                                    // `contain` rather than `cover`. This is the one place a photograph is
                                    // looked at rather than recognised, and a photo cropped to fill a screen
                                    // is a different photograph from the one that was sent.
                                    contentFit="contain"
                                    source={{ uri: item.mediaUrl }}
                                    style={styles.photo}
                                    transition={120}
                                />
                            )}
                        </View>
                    )}
                    windowSize={3}
                />

                {/*
                  Over the picture rather than behind the gesture. A close control the reader has to find is
                  not a way out, and swiping to the end of the album is not a dismissal anybody discovers.
                */}
                <View style={[styles.topBar, { top: insets.top + 8 }]}>
                    <Pressable
                        accessibilityLabel="Close"
                        accessibilityRole="button"
                        onPress={onClose}
                        style={({ pressed }) => [styles.topBarButton, pressed && styles.pressed]}
                    >
                        <Ionicons color="#FFFFFF" name="close" size={24} />
                    </Pressable>

                    {/* Only when there is more than one thing to page through: a photograph sent on its own
                        has nothing to count, and "1 / 1" reads as though something is missing. */}
                    {items.length > 1 ? (
                        <View style={styles.counter}>
                            <Text style={styles.counterText}>{`${index + 1} / ${items.length}`}</Text>
                        </View>
                    ) : (
                        <View />
                    )}

                    <Pressable
                        accessibilityLabel={saveState === 'saved' ? 'Saved to your gallery' : 'Save to your gallery'}
                        accessibilityRole="button"
                        disabled={saveState !== 'idle'}
                        onPress={save}
                        style={({ pressed }) => [styles.topBarButton, pressed && styles.pressed]}
                    >
                        {saveState === 'saving' ? (
                            <ActivityIndicator color="#FFFFFF" size="small" />
                        ) : (
                            <Ionicons
                                color="#FFFFFF"
                                name={saveState === 'saved' ? 'checkmark' : 'download-outline'}
                                size={22}
                            />
                        )}
                    </Pressable>
                </View>

                {current?.durationSeconds ? (
                    <View pointerEvents="none" style={[styles.duration, { bottom: insets.bottom + 16 }]}>
                        <Text style={styles.durationText}>{formatDuration(current.durationSeconds)}</Text>
                    </View>
                ) : null}
            </View>
        </Modal>
    );
}

/**
 * A clip, playing on the one page it is on.
 *
 * Mounted only for the page currently being looked at, so an album with three clips holds one decoder
 * rather than three: the cells either side of this one draw a still, and this one releases its player when
 * the reader swipes away from it. `loop` is off so a clip stops on its own rather than starting over under
 * a reader who has already seen it.
 */
function AlbumVideo({ uri }: { uri: string }) {
    const { height, width } = useWindowDimensions();
    const player = useVideoPlayer({ uri }, (instance) => {
        instance.loop = false;
        instance.muted = true;
    });

    return (
        // Native controls rather than this app's own: this is the one place a reader expects the platform's
        // video chrome, because they came here from a photograph and expect the phone's idea of a video.
        <VideoView contentFit="contain" nativeControls player={player} style={{ height, width }} />
    );
}

const styles = StyleSheet.create({
    screen: {
        backgroundColor: '#000000',
        flex: 1,
    },
    page: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    photo: {
        height: '100%',
        width: '100%',
    },
    topBar: {
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'space-between',
        left: 12,
        position: 'absolute',
        right: 12,
    },
    topBarButton: {
        alignItems: 'center',
        backgroundColor: 'rgba(20, 22, 28, 0.55)',
        borderRadius: 20,
        height: 40,
        justifyContent: 'center',
        width: 40,
    },
    pressed: {
        opacity: 0.7,
    },
    counter: {
        backgroundColor: 'rgba(20, 22, 28, 0.55)',
        borderRadius: 12,
        paddingHorizontal: 10,
        paddingVertical: 4,
    },
    counterText: {
        color: '#FFFFFF',
        fontSize: 13,
        fontWeight: '700',
    },
    duration: {
        alignSelf: 'center',
        backgroundColor: 'rgba(20, 22, 28, 0.55)',
        borderRadius: 4,
        paddingHorizontal: 6,
        paddingVertical: 2,
        position: 'absolute',
    },
    durationText: {
        color: '#FFFFFF',
        fontSize: 11,
        fontWeight: '700',
    },
});
