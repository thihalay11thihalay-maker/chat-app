import { Ionicons } from '@expo/vector-icons';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GestureResponderEvent, LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatDuration } from '@/lib/format-duration';

/**
 * The one voice message allowed to be audible.
 *
 * Every message owns its own player: a player cannot be created inside a tap, and one shared player
 * would have to be pointed at whichever bubble was pressed, which means holding a native player for
 * the whole conversation instead of for the row being read. The cost of a player per row is that two
 * voice notes talk over each other the moment a second one is pressed, so the audio goes to whoever
 * asked for it last and the player that had it is paused.
 *
 * Held as a pause callback rather than as the player itself, because a row can be unmounted by the
 * list at any moment and a claim is only ever left behind by a row that is still on screen: the
 * cleanup below drops it, so nothing here can end up asking a released player to stop.
 */
let currentPlayer: { id: string; pause: () => void } | null = null;

function claimAudio(id: string, pause: () => void) {
    if (currentPlayer && currentPlayer.id !== id) {
        currentPlayer.pause();
    }

    currentPlayer = { id, pause };
}

/**
 * A voice message: a play button, a progress bar to scrub along, and how far through it the reader is.
 *
 * Played here rather than handed to the browser. Opening the file in a browser meant a voice note
 * arrived as a download with a file name on it, or as a page that cannot play audio at all, and the
 * reader had to leave the conversation to hear what was said in it. A player drawn in the bubble
 * keeps the reply, the room and the recording in the same place.
 *
 * Nothing is fetched until the reader asks for it. The player is created empty and given its source
 * on the first tap, because a row that loaded its file on mount would pull down every voice note in
 * a conversation to show a play button, which on a long chat is a lot of mobile data spent on
 * audio nobody has chosen to hear.
 */
export default function AudioMessage({
    audioUrl,
    durationSeconds,
    isMine,
    messageId,
    onLongPress,
}: {
    audioUrl: string;
    /**
     * How long the recording ran, in seconds, as the sender's device counted it. Shown until the
     * player has read the length out of the file itself, and kept afterwards only as the floor: a
     * recorder that was stopped a second early would otherwise report a message as longer than it is.
     */
    durationSeconds?: number;
    /** Colours, because a bubble is dark for the account that sent it and light for the reader. */
    isMine: boolean;
    messageId: string;
    /**
     * Held on this row rather than only on the bubble around it. The play button and the progress bar
     * are pressables of their own, and a pressable inside a pressable takes the touch for itself: without
     * this, holding a voice message would never reach the conversation's own menu, and reacting to one
     * would be the one thing you could not do with it.
     */
    onLongPress?: () => void;
}) {
    // Created with no source on purpose: see the note above. A quarter second between updates is
    // what a progress bar needs to look like it is moving rather than jumping.
    const player = useAudioPlayer(null, { updateInterval: 250 });
    const status = useAudioPlayerStatus(player);
    const [trackWidth, setTrackWidth] = useState(0);
    const loadedUrl = useRef<string | null>(null);
    // Whether the reader asked for sound, as opposed to what the player is doing right now. They are
    // not the same thing while a file is still downloading, and this is what says the answer is still
    // yes.
    const wantsPlayback = useRef(false);
    // Set when a recording runs out rather than worked out from the position, because a player that has
    // finished does not always report a position exactly at the end of itself.
    const hasRunOut = useRef(false);

    useEffect(() => () => {
        if (currentPlayer?.id === messageId) {
            currentPlayer = null;
        }
    }, [messageId]);

    // Reached the end: the reader asked for a run through, got all of it, and the player stops there.
    // The bar stays at the end rather than jumping back to the start, because rewinding on its own
    // reads as a message that is somehow still going. Starting it again is what rewinds it, below.
    useEffect(() => {
        if (status.didJustFinish) {
            wantsPlayback.current = false;
            hasRunOut.current = true;
        }
    }, [status.didJustFinish]);

    // The sender's own count is used until the player knows, and only when it is longer than what the
    // player reports, because that is the reading that cannot leave the reader waiting past the end.
    const totalSeconds = Math.max(status.duration, durationSeconds ?? 0);
    const playedSeconds = totalSeconds > 0 ? Math.min(status.currentTime, totalSeconds) : 0;
    const progress = totalSeconds > 0 ? playedSeconds / totalSeconds : 0;
    // Guarded on a known length on purpose: with nothing loaded yet both sides are zero, and an
    // unguarded comparison would call a message that has never been played finished.
    const hasReachedEnd = totalSeconds > 0 && playedSeconds >= totalSeconds - 0.1;

    const load = useCallback(() => {
        if (loadedUrl.current === audioUrl) {
            return;
        }

        loadedUrl.current = audioUrl;
        player.replace(audioUrl);
    }, [audioUrl, player]);

    // Asked again once the file is there, because a play pressed during the download is a request
    // about the audio rather than about the moment it was made.
    useEffect(() => {
        if (wantsPlayback.current && status.isLoaded) {
            player.play();
        }
    }, [status.isLoaded, player]);

    const pause = useCallback(() => {
        wantsPlayback.current = false;
        player.pause();
    }, [player]);

    const play = useCallback(() => {
        wantsPlayback.current = true;

        // Already heard to the end: pressing play means hear it again, and there is nothing past the end
        // for the player to carry on into, so it goes back to the start first. Both answers to "is this
        // finished" are used: a player that has run out does not always report a position exactly at the
        // end, and one that was seeked to the very end gets no finishing event at all until it plays.
        if (hasRunOut.current || hasReachedEnd) {
            hasRunOut.current = false;
            void player.seekTo(0);
        }

        load();
        claimAudio(messageId, pause);

        // Best effort, and deliberately not awaited before the sound starts: a device that will not
        // hand over an audio session should still play the message rather than refuse to. This is the
        // same setting the recorder uses, so a voice note is audible with the ringer switched to
        // silent, which is what a message is for.
        void setAudioModeAsync({ playsInSilentMode: true }).catch((error) => {
            console.warn('Could not set the audio mode for playback:', error);
        });

        player.play();
    }, [hasReachedEnd, load, messageId, pause, player]);

    const toggle = useCallback(() => {
        if (status.playing) {
            pause();
            return;
        }

        play();
    }, [pause, play, status.playing]);

    const seekTo = useCallback((x: number) => {
        if (trackWidth <= 0 || totalSeconds <= 0) {
            return;
        }

        // Clamped rather than trusted: a tap that lands a pixel outside the track would otherwise
        // ask the player for a time past the end of the recording.
        const fraction = Math.min(1, Math.max(0, x / trackWidth));
        hasRunOut.current = false;
        void player.seekTo(fraction * totalSeconds);
    }, [player, totalSeconds, trackWidth]);

    const onTrackLayout = useCallback((event: LayoutChangeEvent) => {
        setTrackWidth(event.nativeEvent.layout.width);
    }, []);

    const onTrackPress = useCallback((event: GestureResponderEvent) => {
        seekTo(event.nativeEvent.locationX);
    }, [seekTo]);

    const label = status.playing ? 'Pause voice message' : 'Play voice message';

    return (
        <View style={styles.row}>
            <Pressable
                accessibilityLabel={label}
                accessibilityRole="button"
                onLongPress={onLongPress}
                onPress={toggle}
                style={({ pressed }) => [
                    styles.playButton,
                    isMine ? styles.ownPlayButton : styles.otherPlayButton,
                    pressed && styles.pressed,
                ]}
            >
                <Ionicons
                    color={isMine ? '#FFFFFF' : '#1F9D5B'}
                    name={status.playing ? 'pause' : 'play'}
                    size={17}
                />
            </Pressable>

            <View style={styles.detail}>
                <Pressable
                    accessibilityLabel="Seek voice message"
                    accessibilityRole="adjustable"
                    onLayout={onTrackLayout}
                    onLongPress={onLongPress}
                    onPress={onTrackPress}
                    style={styles.trackTouch}
                >
                    <View style={[styles.track, isMine ? styles.ownTrack : styles.otherTrack]}>
                        <View
                            style={[
                                styles.trackFill,
                                { width: `${Math.round(progress * 100)}%` },
                            ]}
                        />
                    </View>
                </Pressable>

                <View style={styles.times}>
                    <Text style={[styles.time, isMine && styles.ownTime]}>{formatDuration(playedSeconds)}</Text>
                    <Text style={[styles.time, isMine && styles.ownTime]}>
                        {totalSeconds > 0 ? formatDuration(totalSeconds) : '--:--'}
                    </Text>
                </View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    row: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 10,
        minHeight: 40,
        width: 214,
    },
    pressed: {
        opacity: 0.75,
    },
    playButton: {
        alignItems: 'center',
        borderRadius: 19,
        height: 38,
        justifyContent: 'center',
        width: 38,
    },
    otherPlayButton: {
        backgroundColor: '#E8F7EE',
    },
    ownPlayButton: {
        backgroundColor: '#2FBF71',
    },
    detail: {
        flex: 1,
        gap: 5,
    },
    // Taller than the bar it holds, because a four pixel line is a thing to look at rather than a
    // thing to press.
    trackTouch: {
        height: 18,
        justifyContent: 'center',
    },
    track: {
        borderRadius: 2,
        height: 4,
        overflow: 'hidden',
        width: '100%',
    },
    otherTrack: {
        backgroundColor: '#E7E2DA',
    },
    ownTrack: {
        backgroundColor: '#3A3F49',
    },
    trackFill: {
        backgroundColor: '#2FBF71',
        height: '100%',
    },
    times: {
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    time: {
        color: '#8D929C',
        fontSize: 10,
        fontVariant: ['tabular-nums'],
    },
    ownTime: {
        color: '#B9BBC0',
    },
});
