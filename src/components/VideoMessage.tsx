import { Ionicons } from '@expo/vector-icons';
import { useEvent } from 'expo';
import { Image } from 'expo-image';
import { VideoThumbnail, VideoView, createVideoPlayer, useVideoPlayer } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatDuration } from '@/lib/format-duration';

/**
 * A video message: a still frame with a play button, and a player that takes the screen when it is tapped.
 *
 * The player exists from the first render, because a hook cannot be called conditionally, but it is
 * paused and nothing is mounted onto it until the reader asks: no `VideoView` means no surface attached
 * and no decoder running, so a conversation of twenty videos holds twenty idle players rather than
 * twenty playing ones. What does cost a decoder per video is the poster frame, and that one is taken with
 * a throwaway player that is released again as soon as it has given up its frame.
 *
 * Fullscreen is this app's own modal rather than the player's native fullscreen mode. Android pauses the
 * JavaScript runtime while a VideoView is in native fullscreen, which means a close button drawn by the
 * app would have nothing to respond to it, and the way out of a video is not something to leave to a
 * gesture nobody can see.
 */
export default function VideoMessage({
  durationSeconds,
  onLongPress,
  videoUrl,
}: {
  durationSeconds?: number;
  /**
   * Held on the poster rather than only on the bubble behind it, because a pressable inside another
   * pressable keeps the touch to itself: without this, holding a video message would open the player
   * and never reach the conversation's own menu.
   */
  onLongPress?: () => void;
  videoUrl: string;
}) {
  const insets = useSafeAreaInsets();
  const [isPlaying, setIsPlaying] = useState(false);
  // Paused and unmounted until the reader taps, which is what keeps a conversation of videos from holding
  // a decoder open per message.
  const player = useVideoPlayer({ uri: videoUrl }, (instance) => {
    instance.loop = false;
  });
  const { isPlaying: playingNow } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const hasStarted = useRef(false);

  const open = useCallback(() => {
    setIsPlaying(true);

    if (!hasStarted.current) {
      hasStarted.current = true;
      player.play();
    }
  }, [player]);

  const close = useCallback(() => {
    // Paused before the modal goes away, not after: a player left running behind a closed modal keeps
    // talking over whatever the reader has moved on to, which for a voice app is their next conversation.
    player.pause();
    setIsPlaying(false);
  }, [player]);

  const toggle = useCallback(() => {
    if (playingNow) {
      player.pause();
      return;
    }

    // Reached the end and pressed play again: without this the reader presses play and nothing happens,
    // because a finished clip has nowhere left to go.
    if (player.duration > 0 && player.currentTime >= player.duration - 0.25) {
      player.replay();
    }

    player.play();
  }, [player, playingNow]);

  return (
    <>
      <Pressable
        accessibilityLabel="Play video"
        accessibilityRole="button"
        onLongPress={onLongPress}
        onPress={open}
        style={({ pressed }) => [styles.poster, pressed && styles.pressed]}
      >
        {/*
          The poster is the video's own first frame rather than a grey box with a triangle on it. It is
          fetched by asking the player for a thumbnail, which is a frame of the actual clip: the reader can
          see they are about to open the right thing without a tap, and a conversation of videos reads as
          pictures instead of as a wall of identical placeholders.
        */}
        <VideoPoster durationSeconds={durationSeconds} videoUrl={videoUrl} />

        <View pointerEvents="none" style={styles.playBadge}>
          <Ionicons color="#FFFFFF" name="play" size={22} />
        </View>
      </Pressable>

      <Modal animationType="fade" onRequestClose={close} transparent visible={isPlaying}>
        <View style={styles.player}>
          {/*
            The surface is left at the default and Picture-in-Picture is not asked for. PiP needs the
            config plugin turned on, which needs a rebuild, so asking for it in a build that has not had
            one would be a prop that silently does nothing; the default surface is also the faster of the
            two on Android.
          */}
          <VideoView contentFit="contain" nativeControls player={player} style={styles.video} />

          {/* Kept out of the video's own way: the native controls own the bottom of the frame, so these sit
              at the top where a thumb never covers the picture. The play and pause button is this app's
              own because the native controls are the platform's, and on some builds of Android they are
              not drawn until the video is touched. */}
          <View style={[styles.topBar, { top: insets.top + 8 }]}>
            <Pressable
              accessibilityLabel={playingNow ? 'Pause' : 'Play'}
              accessibilityRole="button"
              onPress={toggle}
              style={({ pressed }) => [styles.topBarButton, pressed && styles.pressed]}
            >
              <Ionicons color="#FFFFFF" name={playingNow ? 'pause' : 'play'} size={22} />
            </Pressable>

            <Pressable
              accessibilityLabel="Close video"
              accessibilityRole="button"
              onPress={close}
              style={({ pressed }) => [styles.topBarButton, pressed && styles.pressed]}
            >
              <Ionicons color="#FFFFFF" name="close" size={22} />
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

/**
 * The still frame for a video that is not playing.
 *
 * Asked of the clip itself through `generateThumbnailsAsync`, which returns a native image reference that
 * `expo-image` can draw. Taken with a second, short-lived player rather than the one this message already
 * has, because that one has no view attached to prepare it, and released immediately afterwards.
 */
function VideoPoster({
  durationSeconds,
  videoUrl,
}: {
  durationSeconds?: number;
  videoUrl: string;
}) {
  const [poster, setPoster] = useState<VideoThumbnail | null>(null);

  useEffect(() => {
    // Latched rather than cancelled: the grabber is released by `takeThumbnail` itself, and all that is
    // left to do here is not hand a picture to a component that has since been given a different clip.
    let isCurrent = true;

    void takeThumbnail(
      videoUrl,
      (thumbnail) => {
        if (isCurrent) {
          setPoster(thumbnail);
        }
      },
    );

    return () => {
      isCurrent = false;
    };
  }, [videoUrl]);

  return (
    <View style={styles.posterFrame}>
      {/* The thumbnail object itself rather than its uri: it is a reference to a native image, and the
          only thing that can read one is an expo-image source. */}
      {poster ? (
        <Image contentFit="cover" source={poster} style={StyleSheet.absoluteFill} transition={120} />
      ) : null}

      {durationSeconds ? (
        <View pointerEvents="none" style={styles.duration}>
          <Text style={styles.durationText}>{formatDuration(durationSeconds)}</Text>
        </View>
      ) : null}
    </View>
  );
}

async function takeThumbnail(videoUrl: string, onReady: (thumbnail: VideoThumbnail) => void) {
  const grabber = createVideoPlayer({ uri: videoUrl });

  try {
    const [thumbnail] = await grabber.generateThumbnailsAsync([0], { maxWidth: 480 });

    if (thumbnail) {
      onReady(thumbnail);
    }
  } catch (error) {
    // Not worth an alert: the poster is a convenience, and the video itself is what the reader came for.
    console.warn('Could not take a thumbnail for a video message:', error);
  } finally {
    // Released either way. A grabber left alive holds its decoder for as long as the screen exists, and
    // this one has already given up its only reason for existing.
    grabber.release();
  }
}


const styles = StyleSheet.create({
  poster: {
    height: 210,
    width: 220,
  },
  pressed: {
    opacity: 0.85,
  },
  posterFrame: {
    alignItems: 'center',
    backgroundColor: '#2A2E37',
    borderRadius: 9,
    height: '100%',
    justifyContent: 'center',
    overflow: 'hidden',
    width: '100%',
  },
  playBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(20, 22, 28, 0.6)',
    borderRadius: 27,
    height: 54,
    justifyContent: 'center',
    left: '50%',
    marginLeft: -27,
    marginTop: -27,
    position: 'absolute',
    top: '50%',
    width: 54,
  },
  duration: {
    backgroundColor: 'rgba(20, 22, 28, 0.6)',
    borderRadius: 4,
    bottom: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
    position: 'absolute',
    right: 6,
  },
  durationText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  player: {
    backgroundColor: '#000000',
    flex: 1,
  },
  video: {
    flex: 1,
  },
  close: {
    alignItems: 'center',
    backgroundColor: 'rgba(20, 22, 28, 0.55)',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    left: 12,
    position: 'absolute',
    width: 40,
  },
  topBar: {
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
});