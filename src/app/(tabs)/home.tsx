import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { router, useIsFocused } from 'expo-router';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { onAuthStateChanged } from 'firebase/auth';
import { collection, deleteDoc, doc, getDoc, limit, onSnapshot, orderBy, query, runTransaction, serverTimestamp, setDoc, Timestamp, where, type DocumentData, type Query } from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  LayoutChangeEvent,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CommentSheet } from '@/components/comment-sheet';
import { TAB_BAR_HEIGHT } from '@/components/curved-tab-bar';
import { ExploreContent } from '@/components/explore-content';
import { getFirebaseAuth, getFirebaseDb, isFirestorePermissionError } from '@/lib/firebase';
import { PostSound, resolveStreamUrl, toPostSoundValue } from '@/lib/music';
import { removePostMedia, storagePathFromUrl } from '@/lib/supabase';

interface Post {
  id: string;
  /** Flat colour standing in for the media on a text post. */
  backgroundColor?: string;
  displayName?: string;
  mediaType?: 'image' | 'video';
  mediaUrl?: string;
  /**
   * Every photo on the post. `mediaUrl` stays the cover the feed draws, so this is the full set
   * behind it. A post written before the editor existed has no array, so it reads as the cover
   * alone rather than as an empty post.
   */
  mediaUrls?: string[];
  /** Who the post is published to. Public when absent, which is how every post behaved before. */
  visibility?: string;
  caption?: string;
  /** Longer form text from the post details screen, shown under the title. */
  description?: string;
  title?: string;
  createdAt?: Timestamp | Date | null;
  commentsCount: number;
  lovesCount: number;
  likesCount: number;
  sharesCount: number;
  sound?: PostSound;
  userId: string;
}

// The feed is muted while it moves, and unmuted this long after the last scroll event.
const SCROLL_SETTLE_MS = 140;

// How long the play or pause glyph stays on screen after a tap.
const INDICATOR_MS = 600;

// Holding the video plays it at this rate, like TikTok.
const FAST_FORWARD_RATE = 2;
const FAST_FORWARD_DELAY_MS = 350;

// A drag has to be clearly horizontal before it becomes a seek instead of a scroll.
const SEEK_TRIGGER_DISTANCE = 8;
const SEEK_DIRECTION_RATIO = 1.2;

// How often the player reports its position while a post plays.
const TIME_UPDATE_INTERVAL = 0.5;

function formatTime(seconds: number) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const minutes = `${Math.floor(total / 60)}`.padStart(2, '0');
  const secondsPart = `${total % 60}`.padStart(2, '0');

  return `${minutes}:${secondsPart}`;
}

// FlatList keeps a reference to this object, so it has to live outside of the component.
const viewabilityConfig = { itemVisiblePercentThreshold: 60 };

function toCount(data: Record<string, unknown>, key: string) {
  const value = data[key];
  const parsed = typeof value === 'number' ? value : Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * The photo a post row draws, from whichever field carries it.
 *
 * `mediaUrl` is the cover and the array is the full set. The array is consulted as well because
 * documents written before the create path saved `mediaUrl` have only that, and reading the cover
 * alone left those posts with no photo at all.
 */
function coverFrom(data: Record<string, unknown>): string | undefined {
  if (typeof data.mediaUrl === 'string' && data.mediaUrl) {
    return data.mediaUrl;
  }

  if (Array.isArray(data.mediaUrls)) {
    const first = data.mediaUrls.find(
      (item): item is string => typeof item === 'string' && /^https?:\/\//i.test(item),
    );

    if (first) {
      return first;
    }
  }

  return undefined;
}

function toPost(id: string, data: Record<string, unknown>): Post {
  const createdAt = data.createdAt;
  const mediaType = data.mediaType;

  const post: Post = {
    id,
    // Only a hex colour is trusted: this string goes straight onto a view's background, so a
    // hand-edited document cannot smuggle anything else into the feed's styling.
    backgroundColor:
      typeof data.backgroundColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(data.backgroundColor)
        ? data.backgroundColor
        : undefined,
    caption: typeof data.caption === 'string' ? data.caption : undefined,
    commentsCount: toCount(data, 'commentsCount'),
    createdAt: createdAt instanceof Date || createdAt instanceof Timestamp ? createdAt : null,
    // Posts written before the details screen have neither field, so both read as absent rather
    // than as an empty line above the caption.
    description: typeof data.description === 'string' ? data.description : undefined,
    displayName: typeof data.displayName === 'string' ? data.displayName : undefined,
    lovesCount: toCount(data, 'lovesCount'),
    likesCount: toCount(data, 'likesCount'),
    mediaType: mediaType === 'image' || mediaType === 'video' ? mediaType : undefined,
    // The cover, falling back to the first entry of the array when the field is absent.
    //
    // Posts created before the writer started saving `mediaUrl` carry only `mediaUrls`, and this
    // fallback is what makes their photo appear instead of the placeholder. It is a read-side
    // repair, so it heals every existing document at once instead of waiting on a backfill; new
    // posts save both fields, so the fallback never fires for them.
    mediaUrl: coverFrom(data),
    // The full set behind the cover, with anything that is not a usable http url dropped. A post
    // with no array falls back to its single cover, so nothing written before the editor existed
    // comes back as an empty list.
    mediaUrls:
      Array.isArray(data.mediaUrls) && data.mediaUrls.some((item) => typeof item === 'string')
        ? (data.mediaUrls as unknown[]).filter(
            (item): item is string => typeof item === 'string' && /^https?:\/\//i.test(item),
          )
        : typeof data.mediaUrl === 'string' && data.mediaUrl
          ? [data.mediaUrl]
          : [],
    sharesCount: toCount(data, 'sharesCount'),
    // Absent on posts written before visibility existed, which the rules treat as public, so the
    // indicator is left off rather than showing a lock nobody set.
    visibility: typeof data.visibility === 'string' ? data.visibility : undefined,
    // A post without a usable sound object is treated as having no sound, so one bad document
    // cannot break the row.
    sound: toPostSoundValue(data.sound) ?? undefined,
    title: typeof data.title === 'string' ? data.title : undefined,
    userId: typeof data.userId === 'string' ? data.userId : '',
  };
  // The other half of the diagnostic the upload side prints. If these two lines disagree for the
  // same post, the document was written with one url and is being served another; if they agree
  // and the photo is still wrong, the object behind that url holds the wrong bytes and the fault
  // is in what was uploaded. Read from the snapshot rather than from the rendered row, so it fires
  // once per document Firestore delivers.
  if (__DEV__) {
    console.log('Feed post media', { mediaUrl: post.mediaUrl ?? '', postId: id });
  }

  return post;
}

function PostVideo({
  uri,
  bottomInset,
  isActive,
  isMuted,
}: {
  uri: string;
  // Distance from the bottom of the post that the floating bars already cover, so the scrub
  // readout clears them instead of landing underneath.
  bottomInset: number;
  isActive: boolean;
  isMuted: boolean;
}) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = true;
    // A player created muted keeps a zero volume on Android, so the first post of the
    // feed would stay silent. Mute is applied by the effect below instead.
    instance.muted = false;
    instance.volume = 1;
    // Drives the seek bar while the post plays.
    instance.timeUpdateEventInterval = TIME_UPDATE_INTERVAL;
    instance.play();
  });

  const [isPaused, setIsPaused] = useState(false);
  const [wasActive, setWasActive] = useState(isActive);
  const [indicator, setIndicator] = useState<'play' | 'pause' | null>(null);
  const [isFastForwarding, setIsFastForwarding] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekSeconds, setSeekSeconds] = useState(0);
  const indicatorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durationRef = useRef(0);
  const trackWidthRef = useRef(0);
  const seekRef = useRef(0);
  const seekStartRef = useRef(0);
  // The gesture handlers read the player through a ref so the pan responder is created
  // once instead of being rebuilt on every render.
  const playerRef = useRef(player);

  useEffect(() => {
    playerRef.current = player;
  }, [player]);

  // Leaving the post resets the manual pause, so the feed autoplays again on the way
  // back. Adjusting state during render is the supported way to react to a prop change.
  if (wasActive !== isActive) {
    setWasActive(isActive);
    setIsPaused(false);

    if (!isActive) {
      // The player is rewound, so the scrub overlay has to start over as well.
      setSeekSeconds(0);
    }
  }

  useEffect(() => {
    return () => {
      if (indicatorTimer.current) {
        clearTimeout(indicatorTimer.current);
      }
    };
  }, []);

  // Only the post on screen plays, and a tap holds it paused, so posts never talk over
  // each other.
  useEffect(() => {
    const syncPlayback = () => {
      // eslint-disable-next-line react-hooks/immutability -- the player is an imperative native object, not render data.
      player.muted = isMuted;
      player.playbackRate = isFastForwarding ? FAST_FORWARD_RATE : 1;

      if (isActive && !isPaused) {
        // Unmuting restores the volume the player had while muted, so it is set again.
        player.volume = 1;
        player.play();
        return;
      }

      player.pause();

      // A post that left the screen is rewound, so it plays from the start when the
      // feed comes back to it. The player ignores a seek before the video is loaded.
      if (!isActive && !isPaused && player.status === 'readyToPlay') {
        player.currentTime = 0;
      }
    };

    syncPlayback();

    // A remote video finishes loading after this effect runs, and the native player
    // starts muted until then. Re-applying the state once it is ready is what gives the
    // first post of the feed its audio instead of only the posts reached by scrolling.
    const statusSubscription = player.addListener('statusChange', (payload) => {
      if (payload.status === 'readyToPlay') {
        syncPlayback();
      }
    });
    const playingSubscription = player.addListener('playingChange', () => {
      syncPlayback();
    });

    return () => {
      statusSubscription.remove();
      playingSubscription.remove();
    };
  }, [isActive, isFastForwarding, isMuted, isPaused, player]);

  // The scrub gesture needs the length of the video, which the player reports once the
  // video is loaded.
  useEffect(() => {
    const updateDuration = (value: number) => {
      durationRef.current = value;
    };
    const sourceSubscription = player.addListener('sourceLoad', (payload) => {
      updateDuration(payload.duration);
    });
    const statusSubscription = player.addListener('statusChange', (payload) => {
      if (payload.status === 'readyToPlay') {
        updateDuration(player.duration);
      }
    });

    return () => {
      sourceSubscription.remove();
      statusSubscription.remove();
    };
  }, [player]);

  // One tap toggles playback and flashes the matching glyph for a moment, like TikTok.
  const togglePlayback = () => {
    const nextIsPaused = !isPaused;
    setIsPaused(nextIsPaused);
    setIndicator(nextIsPaused ? 'play' : 'pause');

    if (indicatorTimer.current) {
      clearTimeout(indicatorTimer.current);
    }
    indicatorTimer.current = setTimeout(() => setIndicator(null), INDICATOR_MS);
  };

  // Dragging sideways scrubs the video. The pan responder is an ancestor of the
  // pressable, so a tap still toggles playback and a vertical drag still scrolls the
  // feed: this only claims the gesture once the movement is clearly horizontal.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- the pan responder must keep the same instance for the whole gesture, the compiler cannot reproduce that by hand.
  const panResponder = useMemo(() => {
    const applySeek = (next: number) => {
      const total = durationRef.current;
      const clamped = total > 0 ? Math.min(Math.max(next, 0), total) : Math.max(next, 0);
      seekRef.current = clamped;
      setSeekSeconds(clamped);
    };

    const commitSeek = () => {
      const instance = playerRef.current;

      // The player ignores a seek before the video is loaded, and duration is unknown
      // until then, so an early drag is dropped instead of rewinding the video.
      if (instance && durationRef.current > 0) {
        instance.currentTime = seekRef.current;
      }

      setIsSeeking(false);
    };

    // The callbacks below run on gesture events, not while rendering, so reading the
    // refs they close over is safe here.
    // eslint-disable-next-line react-hooks/refs
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        Math.abs(gesture.dx) > SEEK_TRIGGER_DISTANCE
        && Math.abs(gesture.dx) > Math.abs(gesture.dy) * SEEK_DIRECTION_RATIO,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        seekStartRef.current = playerRef.current?.currentTime ?? 0;
        applySeek(seekStartRef.current);
        setIsSeeking(true);
      },
      onPanResponderMove: (_event, gesture) => {
        const total = durationRef.current;

        if (total <= 0 || trackWidthRef.current <= 0) {
          return;
        }

        applySeek(seekStartRef.current + (gesture.dx / trackWidthRef.current) * total);
      },
      onPanResponderRelease: commitSeek,
      onPanResponderTerminate: commitSeek,
    });
  }, []);

  return (
    <View
      onLayout={(event) => {
        trackWidthRef.current = event.nativeEvent.layout.width;
      }}
      // Fills the post rather than taking a fixed height, so the video follows the measured
      // page height and never overflows it.
      style={styles.media}
      {...panResponder.panHandlers}
    >
      <Pressable
        accessibilityLabel={isPaused ? 'Play video' : 'Pause video'}
        accessibilityRole="button"
        delayLongPress={FAST_FORWARD_DELAY_MS}
        onLongPress={() => setIsFastForwarding(true)}
        onPress={togglePlayback}
        onPressOut={() => setIsFastForwarding(false)}
        style={styles.mediaFill}
      >
        {/* contain, not cover: a vertical clip or a wide one is shown whole instead of being
            cropped and zoomed into by the viewport. */}
        <VideoView
          contentFit="contain"
          nativeControls={false}
          player={player}
          style={styles.mediaFill}
        />

        {isFastForwarding ? (
          <View pointerEvents="none" style={styles.speedBadge}>
            <Text style={styles.speedBadgeText}>2x Speed</Text>
          </View>
        ) : null}

        {indicator ? (
          <View pointerEvents="none" style={styles.indicator}>
            {indicator === 'play' ? <View style={styles.playIcon} /> : (
              <View style={styles.pauseIcon}>
                <View style={styles.pauseBar} />
                <View style={styles.pauseBar} />
              </View>
            )}
          </View>
        ) : null}

        {isSeeking ? (
          <View pointerEvents="none" style={[styles.seekOverlay, { bottom: bottomInset + 32 }]}>
            <Text style={styles.seekTime}>
              {`${formatTime(seekSeconds)}`}
            </Text>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

// The attached song plays under the post, like the audio track on a TikTok. It sits well
// below the video's own audio so the two do not fight for attention.
const SOUND_VOLUME = 0.4;

function PostSoundLabelRow({
  isMuted,
  onToggleMute,
  sound,
}: {
  isMuted: boolean;
  onToggleMute: () => void;
  sound: PostSound;
}) {
  return (
    <Pressable
      accessibilityLabel={isMuted ? 'Unmute sound' : 'Mute sound'}
      accessibilityRole="button"
      onPress={onToggleMute}
      style={styles.soundLabel}
    >
      <Ionicons
        color={isMuted ? '#9CA3AF' : '#FFFFFF'}
        name={isMuted ? 'volume-mute' : 'musical-notes'}
        size={13}
      />
      {/* The artist and the title credit the artist the track came from. */}
      <Text numberOfLines={1} style={styles.soundLabelText}>
        {`${sound.artist} · ${sound.title}`}
      </Text>
    </Pressable>
  );
}

// Split from PostSoundRow so the player is only created for posts that actually have a sound:
// hooks cannot be conditional, and a row without music should not hold an audio object.
function PostSoundPlayer({ isActive, isMuted, onToggleMute, sound }: {
  isActive: boolean;
  isMuted: boolean;
  onToggleMute: () => void;
  sound: PostSound;
}) {
  // Starts empty because Audius hands out a signed link per track, not in the search result.
  const player = useAudioPlayer(null);
  const [streamUrl, setStreamUrl] = useState('');
  const replacedUrl = useRef('');

  // The link saved on the post is a track id, so the audio is resolved when the post is first
  // watched. It waits for the post to be on screen, which keeps a long feed from asking
  // Audius for tracks nobody has scrolled to yet.
  useEffect(() => {
    if (!isActive || streamUrl || !sound.isStreamable) {
      return;
    }

    let ignored = false;

    resolveStreamUrl(sound.id)
      .then((url) => {
        // The lookup is cached by id, so a result dropped because the post scrolled away costs
        // nothing the next time it is watched.
        if (!ignored) {
          setStreamUrl(url);
        }
      })
      .catch((error) => {
        console.warn('Could not load the sound for this post:', error);
      });

    return () => {
      ignored = true;
    };
  }, [isActive, sound.id, sound.isStreamable, streamUrl]);

  // A fresh link every time: Audius URLs carry a signature that stops working later, so the
  // player is pointed at a new one rather than replaying a stale one.
  useEffect(() => {
    if (!streamUrl || replacedUrl.current === streamUrl) {
      return;
    }

    player.replace({ uri: streamUrl });
    replacedUrl.current = streamUrl;
  }, [player, streamUrl]);

  // The volume is set on the object rather than at play time, so it also holds after the
  // platform applies its own default on a fresh load.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability -- the player is an imperative native object, not render data.
    player.volume = SOUND_VOLUME;
    // Songs are short and a post can be scrolled back to later, so the track loops for as
    // long as the post is on screen.
    player.loop = true;
  }, [player]);

  // Only the post filling the screen plays, and the feed mutes everything while it moves, so
  // two songs are never on top of each other. Nothing plays until a link is in hand.
  useEffect(() => {
    if (isActive && !isMuted && streamUrl) {
      player.play();
      return;
    }

    player.pause();
  }, [isActive, isMuted, player, streamUrl]);

  return <PostSoundLabelRow isMuted={isMuted} onToggleMute={onToggleMute} sound={sound} />;
}

function PostSoundRow({
  isActive,
  isMuted,
  onToggleMute,
  sound,
}: {
  isActive: boolean;
  isMuted: boolean;
  onToggleMute: () => void;
  sound?: PostSound;
}) {
  if (!sound) {
    return null;
  }

  return (
    <PostSoundPlayer
      isActive={isActive}
      isMuted={isMuted}
      onToggleMute={onToggleMute}
      sound={sound}
    />
  );
}

/**
 * Removes a post and the file behind it.
 *
 * The document goes first: it is the record of the post, and the feed's listener drops the row
 * on its own once it is gone. The file is removed afterwards and its failure is swallowed by
 * removePostMedia, because an orphaned upload is a much smaller problem than a post the owner
 * asked to have deleted that is still in their feed.
 */
async function deletePost(post: Post) {
  await deleteDoc(doc(getFirebaseDb(), 'posts', post.id));

  const path = storagePathFromUrl(post.mediaUrl);

  if (path) {
    await removePostMedia(path);
  }
}

/**
 * react-native-web stubs Alert.alert to a no-op, so the browser's own confirm is used there.
 * Returning a promise keeps the caller identical on both platforms.
 */
function confirmDestructive(title: string, message: string) {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
      return Promise.resolve(false);
    }

    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }

  return new Promise<boolean>((resolve) => {
    Alert.alert(title, message, [
      { onPress: () => resolve(false), style: 'cancel', text: 'Cancel' },
      {
        onPress: () => resolve(true),
        style: 'destructive',
        text: 'Delete',
      },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

export default function Home() {
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [feed, setFeed] = useState<{ posts: Post[]; tab: string }>({ posts: [], tab: '' });
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  // The list is measured instead of trusting the window height, otherwise a header or
  // safe area makes the page height and the item height disagree and snapping drifts. The
  // window is only the first guess, before the list has been laid out.
  const [pageHeight, setPageHeight] = useState(() => windowHeight);
  // One bar owns the pill and the search button, measured once so the content underneath can
  // start below it without either of them guessing an offset.
  const [topBarHeight, setTopBarHeight] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isScrolling, setIsScrolling] = useState(false);
  const [selectedTab, setSelectedTab] = useState('Friends');

  // The posts on screen belong to a named tab rather than being a bare list. A tab change starts a
  // new set of listeners, and until the first of them answers there is nothing honest to show: the
  // previous tab's posts are the wrong answer, and showing them for a moment is the bug that made
  // the Public tab look like it was serving restricted posts. Reading the list only when the tag
  // matches the selected tab is also why nothing has to be cleared in an effect.
  // Memoised because the derived identity has to be stable: `posts` is a dependency of the comment
  // count lookup, and a fresh array on every render would make that memo recompute constantly.
  const posts = useMemo(
    () => (feed.tab === selectedTab ? feed.posts : EMPTY_FEED),
    [feed, selectedTab],
  );
  // True between picking a tab and its first result, which is the only window where "no posts yet"
  // would be a lie.
  const isFeedSettling = feed.tab !== selectedTab;
  // The comment sheet renders over the post instead of navigating away, so the feed keeps
  // its scroll position and the video behind the sheet stays the same one.
  const [commentsPostId, setCommentsPostId] = useState('');
  // One switch for the whole feed, like the sound toggle in a short-video app: tapping the
  // song label silences every post, not just the one on screen.
  const [isSoundMuted, setIsSoundMuted] = useState(false);
  // Whose feed this is. Read from the auth listener rather than from currentUser at render, so
  // the owner actions on a post appear or disappear when the account changes instead of
  // depending on whichever render happened to read a null.
  const [viewerId, setViewerId] = useState('');
  // The post whose options sheet is open, or '' when it is closed. Held as an id rather than
  // the post so a listener update cannot leave a stale copy of the document in the sheet.
  const [menuPostId, setMenuPostId] = useState('');
  const [deletingPostId, setDeletingPostId] = useState('');
  const scrollEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (scrollEndTimer.current) {
        clearTimeout(scrollEndTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    // A post can carry its own song while its video still has its audio, so the two have to
    // mix instead of one interrupting the other. The rest of the audio mode is left alone,
    // since the ring switch behaviour is shared with the chat voice notes.
    setAudioModeAsync({ interruptionMode: 'mixWithOthers' }).catch((error) => {
      console.warn('Could not set the audio mode:', error);
    });
  }, []);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    try {
      unsubscribe = onAuthStateChanged(getFirebaseAuth(), (user) => {
        setViewerId(user?.uid ?? '');
      });
    } catch (error) {
      console.error('Firebase auth is unavailable:', error);
    }

    return unsubscribe;
  }, []);

  // The feed, as three queries rather than one.
  //
  // A single `collection(posts)` query cannot work with restricted posts: Firestore validates a
  // query against the read rule for every document it *might* return, so a rule that depends on
  // `resource.data.userId` or on a per-post audience makes the whole query fail rather than filter
  // it. Each query below is shaped so one clause of the rule proves it on its own, and the results
  // are merged here.
  //
  //   public         -> proves the "visibility == public" clause
  //   legacy         -> posts written before the field existed, which the rules also treat as public
  //   own posts      -> proves the "userId == me" clause
  //   visibleToUids  -> proves the "me in the audience" clause, via array-contains
  //
  // All four are needed: the public query misses your own private posts, the own-posts query
  // misses everyone else's, and the audience query is what a restricted post from someone you
  // follow comes back on.
  useEffect(() => {
    if (!viewerId) {
      return undefined;
    }

    const db = getFirebaseDb();
    // Merged by id, so a post that matches two of the queries is held once. The map is the
    // accumulator every listener writes into, which is why it is built once per effect run rather
    // than per snapshot.
    // Whether a post arrived on the audience query, which is the only query that can prove its
    // author follows the viewer. The Friends tab needs that in order to work out a mutual follow.
    const merged = new Map<string, { fromAudience: boolean; post: Post }>();
    // Bumped on every publish and on teardown, so a slow readFollow belonging to a tab that is no
    // longer selected cannot land on top of the tab that replaced it.
    let publishGeneration = 0;

    // The merged feed is sorted here rather than by the queries' own orderBy, because the queries
    // come back separately and only this point can produce one correct order. `createdAt` is a
    // serverTimestamp, so it can still be null for a post written in the same moment it was read,
    // and those sort to the bottom rather than throwing on `.toMillis()`.
    const toMillis = (value: Timestamp | Date | null | undefined) => {
      if (value instanceof Timestamp) {
        return value.toMillis();
      }
      return value instanceof Date ? value.getTime() : 0;
    };

    const publish = async () => {
      publishGeneration += 1;
      const generation = publishGeneration;
      let entries = [...merged.values()];

      // The Friends tab is the only one that is not a plain query, because a mutual follow cannot be
      // asked for in one. Both directions come from data this client is allowed to read:
      //
      //   they follow me  -> the post came back on the audience query, because the audience written
      //                      onto it is the author's own following list and the viewer is on it
      //   I follow them  -> readFollow reads users/{viewerId}/following/{authorId}, the viewer's own
      //                      subcollection, which the rules let them list
      //
      // Requiring both is a real mutual rather than a guess at one. A public post is excluded from
      // this test: nothing about a public post records whether its author follows the viewer, so it
      // cannot be shown to be mutual. The viewer's own posts are always kept, so the tab is not
      // simply empty for someone whose network has posted nothing restricted.
      if (selectedTab === 'Friends') {
        const followed = new Map<string, boolean>();

        await Promise.all(
          entries
            .filter((entry) => entry.fromAudience && entry.post.userId)
            .map((entry) => readFollow(viewerId, entry.post.userId).then((isFollowing) => {
              followed.set(entry.post.userId, isFollowing);
            })),
        );

        if (generation !== publishGeneration) {
          return;
        }

        entries = entries.filter((entry) => (
          entry.post.userId === viewerId
          || (entry.fromAudience && followed.get(entry.post.userId) === true)
        ));
      }

      if (generation !== publishGeneration) {
        return;
      }

      setFeed({
        posts: entries
          .map((entry) => entry.post)
          .sort((first, second) => toMillis(second.createdAt) - toMillis(first.createdAt)),
        tab: selectedTab,
      });
      setErrorMessage('');
      setLoading(false);
    };

    const onError = (label: string) => (error: Error) => {
      console.error(`Error fetching ${label} posts: `, error);
      // Firestore's own errors carry a `code` that plain Error does not, which is the only way to
      // tell "the rules are wrong" apart from "the network is wrong" and say something useful.
      const code = (error as { code?: string }).code;
      setErrorMessage(
        code === 'permission-denied'
          ? 'You do not have permission to view posts. Check your Firestore security rules and redeploy them.'
          : 'Could not load posts. Please try again.',
      );
      setLoading(false);
    };

    // A post is stored by whichever query found it, and `fromAudience` is OR'd in rather than
    // overwritten. Without that, a post matching both the public and the audience query would be
    // relabelled as public-only by whichever listener fired last and drop out of the Friends tab.
    const listen = (label: string, fromAudience: boolean, q: Query<DocumentData>) => onSnapshot(
      q,
      (snapshot) => {
        snapshot.forEach((postDocument) => {
          const post = toPost(postDocument.id, postDocument.data());
          const existing = merged.get(post.id);

          merged.set(post.id, {
            fromAudience: fromAudience || Boolean(existing?.fromAudience),
            post,
          });
        });
        // Published on every query rather than only when all of them land, so a slow or denied query
        // cannot leave the feed stuck on its spinner with nothing in it.
        void publish();
      },
      onError(label),
    );

    const publicPosts = () => [
      listen('public', false, query(
        collection(db, 'posts'),
        where('visibility', '==', 'public'),
        orderBy('createdAt', 'desc'),
        limit(FEED_QUERY_LIMIT),
      )),
      // Posts written before visibility existed. Firestore's `==` does not match a missing field,
      // but `== null` does, so without this every existing post would silently drop out of the feed
      // the moment the rules were deployed. Delete this query after the posts collection has been
      // backfilled with `visibility: 'public'`.
      listen('legacy', false, query(
        collection(db, 'posts'),
        where('visibility', '==', null),
        orderBy('createdAt', 'desc'),
        limit(FEED_QUERY_LIMIT),
      )),
    ];

    // The viewer's own posts, on every tab but Public. Only this query can return an only_me post,
    // so without it the one person allowed to see their own private post could not see it.
    const ownPosts = () => listen('own', false, query(
      collection(db, 'posts'),
      where('userId', '==', viewerId),
      orderBy('createdAt', 'desc'),
      limit(FEED_QUERY_LIMIT),
    ));

    // Everything the viewer is in the audience of: a restricted post from someone in their network,
    // and the only query that can prove such an author follows them.
    const audiencePosts = () => listen('audience', true, query(
      collection(db, 'posts'),
      where('visibleToUids', 'array-contains', viewerId),
      orderBy('createdAt', 'desc'),
      limit(FEED_QUERY_LIMIT),
    ));

    // What each tab is allowed to ask for.
    //
    // Public is deliberately strict: public posts and nothing else. It is the tab that promises
    // "anything here is open to everyone", so a followers_friends or only_me post appearing on it
    // is a leak of intent, not just of data. It carries neither the audience query nor the viewer's
    // own posts, because a private post of their own would otherwise turn up on the one tab that
    // means "public". Their own posts live on Follow and Friends instead.
    //
    // Live has no live content of its own in the data model yet, so it shows the same public set as
    // Public rather than quietly serving a restricted post under a tab that promises otherwise.
    const unsubscribers = selectedTab === 'Public' || selectedTab === 'Live'
      ? publicPosts()
      : [...publicPosts(), ownPosts(), audiencePosts()];

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      publishGeneration += 1;
    };
  }, [selectedTab, viewerId]);

  // Stable identity: FlatList stores these once and re-runs them if they change.
  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: { index: number | null }[] }) => {
      const nextIndex = viewableItems[0]?.index;
      if (typeof nextIndex === 'number') {
        setActiveIndex(nextIndex);
      }
    },
    [],
  );

  const handleListLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.height;
    setPageHeight((current) => (Math.abs(current - measured) < 1 ? current : measured));
  }, []);

  const getItemLayout = useCallback(
    (data: ArrayLike<Post> | null | undefined, index: number) => ({
      length: pageHeight,
      offset: pageHeight * index,
      index,
    }),
    [pageHeight],
  );

  // The scroll offset keeps the active page correct while the feed is still moving, so
  // the audio follows the post that fills the screen. Audio returns once scrolling stops,
  // and only for the active post.
  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const nextIndex = Math.round(event.nativeEvent.contentOffset.y / Math.max(pageHeight, 1));
    setActiveIndex((current) => (current === nextIndex ? current : nextIndex));
    setIsScrolling(true);

    if (scrollEndTimer.current) {
      clearTimeout(scrollEndTimer.current);
    }
    scrollEndTimer.current = setTimeout(() => setIsScrolling(false), SCROLL_SETTLE_MS);
  };

  const openComments = useCallback((postId: string) => {
    setCommentsPostId(postId);
  }, []);

  const closeComments = useCallback(() => {
    setCommentsPostId('');
  }, []);

  const toggleSoundMute = useCallback(() => {
    setIsSoundMuted((current) => !current);
  }, []);

  // The post the options sheet is showing. Looked up in the live list, so a post deleted from
  // under the sheet cannot be acted on from a copy of itself.
  const menuPost = useMemo(
    () => posts.find((post) => post.id === menuPostId) ?? null,
    [menuPostId, posts],
  );

  const closeOptions = useCallback(() => {
    setMenuPostId('');
  }, []);

  const openOptions = useCallback((postId: string) => {
    setMenuPostId(postId);
  }, []);

  const confirmDelete = useCallback(async (post: Post) => {
    const isConfirmed = await confirmDestructive('Delete post', 'Are you sure you want to delete this post?');

    if (!isConfirmed) {
      return;
    }

    setDeletingPostId(post.id);
    closeOptions();

    try {
      await deletePost(post);
    } catch (error) {
      console.error('Could not delete the post:', error);
      notify(
        'Could not delete',
        isFirestorePermissionError(error)
          ? 'The Firestore rules do not allow deleting this post.'
          : 'Please check your connection and try again.',
      );
    } finally {
      // Cleared whatever happened, so a failed delete cannot leave the row stuck as busy.
      setDeletingPostId('');
    }
  }, [closeOptions]);

  // The text, the audience and the photos are passed as params rather than the whole post: the
  // route param is the only thing that survives being read back on a cold start. The editor still
  // re-reads the document, because the params are only what the feed happened to be holding.
  const openEditor = useCallback((post: Post) => {
    closeOptions();

    router.push({
      pathname: '/edit-post',
      params: {
        description: post.description ?? '',
        // The editor needs the audience and the full photo set as well as the text. A list rides as
        // a JSON string because a param can only be a string; the editor parses it back.
        mediaUrls: JSON.stringify(post.mediaUrls ?? []),
        postId: post.id,
        visibility: post.visibility ?? '',
        title: post.title ?? '',
      },
    });
  }, [closeOptions]);

  // The sheet shows the counter the feed keeps on the post, so the header agrees with the
  // number next to the comment icon even when the list below is only the newest page.
  const commentsCount = useMemo(
    () => posts.find((post) => post.id === commentsPostId)?.commentsCount ?? 0,
    [commentsPostId, posts],
  );

  // The tab bar floats over the feed instead of shortening it, so everything anchored to the
  // bottom of a post has to clear the bar itself plus the phone inset below it.
  const bottomChrome = TAB_BAR_HEIGHT + insets.bottom;

  const renderItem = ({ item, index }: { item: Post; index: number }) => {
    // The sheet covers the lower half of the post, so the video pauses while it is open
    // instead of playing behind the comments.
    const isCurrentPost = isFocused && !isScrolling && index === activeIndex && commentsPostId === '';
    // Only the author gets the options. The uid is the same field the rules key on, so a
    // forged post claiming someone else's id still only shows this to its real author.
    const isOwnPost = Boolean(viewerId) && viewerId === item.userId;
    // Below the tab pill, which is measured rather than guessed, and above the media so the
    // button reads on a bright frame as well as on the black one.
    const optionsTop = topBarHeight + 10;

    return (
      <View style={[styles.itemContainer, { height: pageHeight }]}>
        {/* One wrapper owns the media box for both kinds, so a photo and a video are laid out
            the same way and neither can spill past the page. No padding or margin: the post
            has to reach the edges of the screen. */}
        <View style={styles.media}>
          {item.mediaType === 'video' && item.mediaUrl ? (
            <PostVideo
              bottomInset={bottomChrome}
              isActive={isCurrentPost}
              isMuted={!isCurrentPost}
              uri={item.mediaUrl}
            />
          ) : item.mediaUrl ? (
            // Keyed by the document, not left to position. The list is a merged, client-sorted view
            // of several live queries, so a document can change row between renders; without a key
            // React can carry an already-loaded Image over to a different post and leave the
            // previous photo on screen for a frame.
            <Image
              contentFit="contain"
              key={`${item.id}:${item.mediaUrl}`}
              source={{ uri: item.mediaUrl }}
              style={styles.mediaFill}
            />
          ) : item.backgroundColor ? (
            // A text post has no file behind it, so the colour stands in for the media and the
            // title and description sit on top of it.
            <View style={[styles.mediaFill, { backgroundColor: item.backgroundColor }]} />
          ) : (
            <Image
              contentFit="contain"
              source={{ uri: 'https://i.pravatar.cc/150?u=test' }}
              style={styles.mediaFill}
            />
          )}
        </View>

        {/* Title first, then the longer description: only these two, because the author name
            lives in the social bar and repeating it here stacked the same @name on top. */}
        <View style={[styles.overlay, { bottom: bottomChrome + SOCIAL_BAR_HEIGHT }]}>
          <PostSoundRow
            isActive={isCurrentPost}
            isMuted={isSoundMuted}
            onToggleMute={toggleSoundMute}
            sound={item.sound}
          />
          <PostTitle isOwnPost={isOwnPost} title={item.title} visibility={item.visibility} />
          <CaptionText
            // A titled post with no description reads as the title alone. "No caption" is only
            // shown when the post has no text of its own to show.
            caption={item.description?.trim() || item.caption}
            placeholder={item.title?.trim() ? null : 'No caption'}
          />
        </View>

        {isOwnPost ? (
          <Pressable
            accessibilityLabel="Post options"
            accessibilityRole="button"
            disabled={deletingPostId === item.id}
            hitSlop={8}
            onPress={() => openOptions(item.id)}
            style={[styles.postOptionsButton, { top: optionsTop }]}
          >
            {deletingPostId === item.id ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Ionicons color="#FFFFFF" name="ellipsis-horizontal" size={20} />
            )}
          </Pressable>
        ) : null}

        <SocialActions
          bottomInset={bottomChrome}
          key={item.id}
          onOpenComments={openComments}
          post={item}
        />
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  if (errorMessage) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>Posts unavailable</Text>
        <Text style={styles.emptySubText}>{errorMessage}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Explore replaces the feed rather than sitting over it. Leaving the paged list mounted
          underneath would keep the current video playing behind a white screen. */}
      {selectedTab === 'Explore' ? (
        // Measured, not guessed: the explore view starts under the bar whatever the status bar
        // inset and the pill height come to on the device.
        <ExploreContent topInset={topBarHeight + 12} />
      ) : isFeedSettling ? (
        // Between choosing a tab and its first result. Deliberately a spinner rather than the
        // empty state: there is no answer yet, and "No posts yet" on a tab that simply has not
        // loaded is the same class of lie as showing the previous tab's posts here.
        <View style={styles.emptyContainer}>
          <ActivityIndicator color="#FFFFFF" />
        </View>
      ) : posts.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>No posts yet.</Text>
          <Text style={styles.emptySubText}>Be the first to upload!</Text>
        </View>
      ) : (
        <FlatList
          data={posts}
          getItemLayout={getItemLayout}
          initialNumToRender={1}
          keyExtractor={(item) => item.id}
          maxToRenderPerBatch={2}
          onLayout={handleListLayout}
          onScroll={handleScroll}
          onViewableItemsChanged={handleViewableItemsChanged}
          pagingEnabled
          removeClippedSubviews
          renderItem={renderItem}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          snapToAlignment="start"
          snapToInterval={pageHeight}
          decelerationRate="fast"
          viewabilityConfig={viewabilityConfig}
          windowSize={3}
        />
      )}

      <View
        onLayout={(event) => setTopBarHeight(event.nativeEvent.layout.height)}
        style={[styles.topBar, { paddingTop: insets.top + 8 }]}
      >
        <FeedTabs onSelect={setSelectedTab} selectedTab={selectedTab} />

        <Pressable
          accessibilityLabel="Search"
          accessibilityRole="button"
          onPress={() => router.push('/search')}
          style={styles.searchButton}
        >
          <Ionicons color="#FFFFFF" name="search" size={24} />
        </Pressable>
      </View>

      <PostOptionsSheet
        isDeleting={deletingPostId !== ''}
        onClose={closeOptions}
        onDelete={() => {
          if (menuPost) {
            void confirmDelete(menuPost);
          }
        }}
        onEdit={() => {
          if (menuPost) {
            openEditor(menuPost);
          }
        }}
        post={menuPost}
      />

      <CommentSheet
        onClose={closeComments}
        postId={commentsPostId}
        totalCount={commentsCount}
        visible={commentsPostId !== ''}
      />
    </View>
  );
}

// The two owner actions, as a sheet over the feed rather than the platform ActionSheet: the feed
// already draws its own overlays this way, so the options look like part of the app on both
// platforms instead of dropping a different-looking dialog on top of the video.
function PostOptionsSheet({
  isDeleting,
  onClose,
  onDelete,
  onEdit,
  post,
}: {
  isDeleting: boolean;
  onClose: () => void;
  onDelete: () => void;
  onEdit: () => void;
  post: Post | null;
}) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={post !== null}
    >
      <View style={styles.optionsRoot}>
        {/* Tapping the dimmed post behind dismisses without picking an action. */}
        <Pressable accessibilityLabel="Close options" onPress={onClose} style={styles.optionsBackdrop} />

        <View style={[styles.optionsSheet, { paddingBottom: Math.max(insets.bottom, 14) }]}>
          <View style={styles.optionsHandle} />

          {post ? (
            <>
              <Pressable
                accessibilityLabel="Edit post"
                accessibilityRole="button"
                disabled={isDeleting}
                onPress={onEdit}
                style={({ pressed }) => [styles.optionsRow, pressed && styles.optionsRowPressed]}
              >
                <Ionicons color="#FFFFFF" name="create-outline" size={21} />
                <Text style={styles.optionsLabel}>Edit Post</Text>
              </Pressable>

              <View style={styles.optionsDivider} />

              <Pressable
                accessibilityLabel="Delete post"
                accessibilityRole="button"
                disabled={isDeleting}
                onPress={onDelete}
                style={({ pressed }) => [styles.optionsRow, pressed && styles.optionsRowPressed]}
              >
                {isDeleting ? (
                  <ActivityIndicator color="#FF6B6B" size="small" />
                ) : (
                  <Ionicons color="#FF6B6B" name="trash-outline" size={21} />
                )}
                <Text style={[styles.optionsLabel, styles.optionsLabelDanger]}>Delete Post</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

// Splits on #tags so they can be tinted without pulling in a markdown style parser.
const HASHTAG_PATTERN = /(#[\wÀ-ɏ]+)/g;

// The icon that stands for an audience, beside the title. Public posts show nothing: a globe on
// every post would be noise, and the absence of a lock is the normal case.
const VISIBILITY_ICONS: Record<string, { icon: keyof typeof Ionicons.glyphMap; label: string }> = {
  followers_friends: { icon: 'people-outline', label: 'Followers and Friends' },
  friends_only: { icon: 'people-outline', label: 'Friends Only' },
  only_me: { icon: 'lock-closed-outline', label: 'Only Me' },
};

// The headline from the details screen. One line only: the description underneath it has room for
// the rest, and a second clipped line of title just pushes the caption off the bottom.
function PostTitle({ isOwnPost, title, visibility }: {
  isOwnPost: boolean;
  title?: string;
  visibility?: string;
}) {
  const text = title?.trim();
  // Only on the author's own posts. Everyone who can see a post is already by definition in its
  // audience, so a marker on other people's posts tells the reader nothing they did not already
  // know, and on a feed of other people it is clutter.
  const marker = isOwnPost && visibility ? VISIBILITY_ICONS[visibility] : undefined;

  if (!text) {
    // The audience still has to be visible on an untitled post, or a private photo with no caption
    // would look exactly like a public one.
    return marker ? (
      <View style={styles.postTitleOnly}>
        <Ionicons color="rgba(255, 255, 255, 0.85)" name={marker.icon} size={13} />
        <Text style={styles.postTitleMarked}>{marker.label}</Text>
      </View>
    ) : null;
  }

  return (
    <View style={styles.postTitleRow}>
      <Text numberOfLines={2} style={styles.postTitle}>
        {text}
      </Text>

      {marker ? (
        <Ionicons
          accessibilityLabel={`Visible to ${marker.label}`}
          color="rgba(255, 255, 255, 0.85)"
          name={marker.icon}
          size={13}
          style={styles.postTitleIcon}
        />
      ) : null}
    </View>
  );
}

function CaptionText({
  caption,
  placeholder,
}: {
  caption?: string;
  /** Null renders nothing at all, which is how a titled post with no description reads. */
  placeholder?: string | null;
}) {
  const text = caption?.trim();

  if (!text) {
    return placeholder ? <Text style={styles.caption}>{placeholder}</Text> : null;
  }

  // Nested Text keeps the whole caption as one paragraph, so numberOfLines can still
  // clip it at two lines and add the ellipsis.
  return (
    <Text numberOfLines={2} style={styles.caption}>
      {text.split(HASHTAG_PATTERN).map((part, index) => (
        part.startsWith('#')
          ? <Text key={`${part}-${index}`} style={styles.hashtag}>{part}</Text>
          : part
      ))}
    </Text>
  );
}

const SOCIAL_ACTIONS = [
  { key: 'like', icon: 'thumbs-up-outline', iconActive: 'thumbs-up' },
  { key: 'love', icon: 'heart-outline', iconActive: 'heart' },
  { key: 'share', icon: 'arrow-redo-outline', iconActive: 'arrow-redo' },
  { key: 'comment', icon: 'chatbubble-outline', iconActive: 'chatbubble' },
] as const;

type SocialActionKey = typeof SOCIAL_ACTIONS[number]['key'];

// Keeps the counters readable at a glance: 999 becomes 1.0k, 1_250_000 becomes 1.3M.
function formatCount(value: number) {
  if (value < 1000) {
    return `${value}`;
  }
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`;
  }

  return `${(value / 1_000_000).toFixed(1)}M`;
}

// Matches the tab bar background so the two stack as a single block. The same translucent
// black, so the video reads through both and the pair looks like one floating bar.
const SOCIAL_BAR_BACKGROUND = 'rgba(0, 0, 0, 0.4)';

// The social bar is a single row: 12px of padding above and below a 40px avatar.
const SOCIAL_BAR_HEIGHT = 64;

// Both flags live in one document at posts/{postId}/reactions/{userId}, so the viewer only
// needs a single listener per post and a like and a love never fight over separate files.
const REACTIONS_COLLECTION = 'reactions';

// How many posts each of the feed's queries asks for. The feed is a paged vertical list, so a few
// screens' worth is enough; a larger number here means a larger composite index and a slower first
// paint for no visible gain.
const FEED_QUERY_LIMIT = 30;

// Stands in for "this tab has no results yet" so the derived list keeps a stable identity instead of
// being a fresh empty array on every render.
const EMPTY_FEED: Post[] = [];

interface ReactionFlags {
  liked?: boolean;
  loved?: boolean;
}

// Follow state is a plain per-author document, so it is fetched once and shared instead of
// being re-read every time a row remounts.
const followCache = new Map<string, boolean>();
const pendingFollows = new Map<string, Promise<boolean>>();

// Set once the rules reject the follow documents; retrying can only fail again.
let followIsDenied = false;

function readFollow(viewerId: string, authorId: string): Promise<boolean> {
  if (followIsDenied) {
    return Promise.resolve(false);
  }

  const cacheId = `${viewerId}|${authorId}`;
  const cached = followCache.get(cacheId);

  if (cached !== undefined) {
    return Promise.resolve(cached);
  }

  const inFlight = pendingFollows.get(cacheId);

  if (inFlight) {
    return inFlight;
  }

  const read = (async () => {
    try {
      const snapshot = await getDoc(doc(
        getFirebaseDb(),
        'users',
        viewerId,
        'following',
        authorId,
      ));
      const exists = snapshot.exists();

      followCache.set(cacheId, exists);
      return exists;
    } catch (error) {
      if (isFirestorePermissionError(error)) {
        followIsDenied = true;
        console.warn(
          'Follow state is not readable with the deployed Firestore rules. '
          + 'Allow users/{uid}/following, then redeploy firestore.rules.',
        );
        return false;
      }

      console.error('Could not load follow state:', error);
      return false;
    } finally {
      pendingFollows.delete(cacheId);
    }
  })();

  pendingFollows.set(cacheId, read);
  return read;
}

type ReactionCounts = Record<'like' | 'love', number>;

// Every row that mounts opens its own listener on the reactions collection, and FlatList
// remounts rows as the feed scrolls, so a rejected collection was being requested again and
// again. Remembering the rejection stops the repeat; the buttons stay disabled meanwhile.
const deniedReactionPaths = new Set<string>();
let hasWarnedAboutReactions = false;

// The reactions subcollection is the only source of truth for both the numbers and the
// viewer's own flags, so one collection listener answers all three. A stored counter on the
// post can drift away from these documents; counting the documents cannot.
function usePostReactions(postId: string, viewerId: string) {
  const [counts, setCounts] = useState<ReactionCounts>({ like: 0, love: 0 });
  const [flags, setFlags] = useState({ liked: false, loved: false });
  const [isDenied, setIsDenied] = useState(() => deniedReactionPaths.has(postId));

  useEffect(() => {
    // No listener without a uid. The zero counts and false flags are already the correct
    // answer for that state, so nothing needs to be reset here.
    if (!viewerId || deniedReactionPaths.has(postId)) {
      return undefined;
    }

    return onSnapshot(
      collection(getFirebaseDb(), 'posts', postId, REACTIONS_COLLECTION),
      (snapshot) => {
        const nextCounts: ReactionCounts = { like: 0, love: 0 };
        let own: ReactionFlags = {};

        snapshot.forEach((entry) => {
          const data = entry.data() as ReactionFlags;

          if (data.liked) {
            nextCounts.like += 1;
          }

          if (data.loved) {
            nextCounts.love += 1;
          }

          if (entry.id === viewerId) {
            own = data;
          }
        });

        setCounts(nextCounts);
        setFlags({ liked: Boolean(own.liked), loved: Boolean(own.loved) });
      },
      (error) => {
        if (isFirestorePermissionError(error)) {
          deniedReactionPaths.add(postId);
          setIsDenied(true);

          // Once per session: the message is the same for every post.
          if (!hasWarnedAboutReactions) {
            hasWarnedAboutReactions = true;
            console.warn(
              'Reading posts/{postId}/reactions was denied, so the like and love counts stay '
              + 'at zero. A collection query is rejected unless the rule allows list for every '
              + 'signed-in user; a rule scoped to request.auth.uid == userId denies it. Check the '
              + 'reactions match in the deployed firestore rules.',
            );
          }

          return;
        }

        console.error('Could not watch reactions:', error);
      },
    );
  }, [postId, viewerId]);

  // Applied on tap so the icon and number do not lag behind the round trip. The listener
  // then replaces both with the stored truth, and a failed write rolls them back.
  const applyOptimistic = useCallback((key: 'like' | 'love', value: boolean) => {
    setFlags((current) => ({ ...current, [`${key}d`]: value }));
    setCounts((current) => ({
      ...current,
      [key]: Math.max(0, current[key] + (value ? 1 : -1)),
    }));
  }, []);

  const rollback = useCallback((key: 'like' | 'love', value: boolean) => {
    applyOptimistic(key, !value);
  }, [applyOptimistic]);

  // Used when a write is rejected, so a failed tap disables the buttons just as a failed
  // read does.
  const markDenied = useCallback(() => {
    deniedReactionPaths.add(postId);
    setIsDenied(true);
  }, [postId]);

  return {
    applyOptimistic,
    counts,
    isDenied,
    liked: flags.liked,
    loved: flags.loved,
    markDenied,
    rollback,
  };
}

// A completed share is counted on the post document, which is where the feed reads the number
// from. Read and set rather than incremented, because a post created before sharing existed
// carries no counter field at all. The feed listener pushes the new value back down, so the
// icon needs no local state of its own.
async function recordShare(postId: string) {
  const db = getFirebaseDb();
  const postRef = doc(db, 'posts', postId);

  await runTransaction(db, async (transaction) => {
    const post = await transaction.get(postRef);
    const stored = post.exists() ? post.data().sharesCount : undefined;
    const count = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;

    transaction.update(postRef, { sharesCount: count + 1 });
  });
}

// react-native-web rejects the call outright in a browser without the Web Share API, so the
// capability is checked before sharing rather than caught after the fact.
function canOpenShareSheet() {
  if (Platform.OS !== 'web') {
    return true;
  }

  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

// Fallback for a browser that cannot open a share sheet. The media link is the whole post, so
// putting it on the clipboard is the one thing that still lets it leave the app.
async function copyPostLink(text: string) {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !navigator.clipboard) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.warn('The clipboard was not available:', error);
    return false;
  }
}

// react-native-web stubs Alert.alert to a no-op, so on web a message the user has to act on
// would simply vanish. The browser dialog is used there instead.
function notify(title: string, message: string) {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(`${title}\n\n${message}`);
    return;
  }

  Alert.alert(title, message);
}

function SocialActions({
  bottomInset,
  onOpenComments,
  post,
}: {
  bottomInset: number;
  onOpenComments: (postId: string) => void;
  post: Post;
}) {
  const [currentUserId, setCurrentUserId] = useState('');
  const [isFollowing, setIsFollowing] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const {
    applyOptimistic,
    counts: reactionCounts,
    isDenied,
    liked: hasLiked,
    loved: hasLoved,
    markDenied,
    rollback,
  } = usePostReactions(post.id, currentUserId);

  const authorId = post.userId;

  useEffect(() => {
    let isMounted = true;

    const readViewer = async () => {
      try {
        const viewer = getFirebaseAuth().currentUser;

        if (isMounted && viewer) {
          setCurrentUserId(viewer.uid);
        }
      } catch (error) {
        console.error('Firebase auth is unavailable:', error);
      }
    };

    void readViewer();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!currentUserId || !authorId) {
      return undefined;
    }

    let isMounted = true;

    const loadFollow = async () => {
      const following = await readFollow(currentUserId, authorId);

      if (isMounted) {
        setIsFollowing(following);
      }
    };

    void loadFollow();

    return () => {
      isMounted = false;
    };
  }, [authorId, currentUserId]);

  const toggleReaction = async (key: 'like' | 'love') => {
    if (isMutating || !currentUserId) {
      return;
    }

    const alreadyReacted = key === 'like' ? hasLiked : hasLoved;
    const nextValue = !alreadyReacted;

    setIsMutating(true);
    applyOptimistic(key, nextValue);

    try {
      const db = getFirebaseDb();
      const reactionRef = doc(db, 'posts', post.id, REACTIONS_COLLECTION, currentUserId);
      // The document holds both flags, so the other one is carried over rather than lost.
      const nextLiked = key === 'like' ? nextValue : hasLiked;
      const nextLoved = key === 'love' ? nextValue : hasLoved;

      // The document is removed once neither flag is set, so the subcollection only ever
      // holds documents that represent an actual reaction.
      if (!nextLiked && !nextLoved) {
        await deleteDoc(reactionRef);
      } else {
        await setDoc(
          reactionRef,
          {
            liked: nextLiked,
            loved: nextLoved,
            updatedAt: serverTimestamp(),
            userId: currentUserId,
          },
          { merge: true },
        );
      }
    } catch (error) {
      rollback(key, nextValue);

      if (isFirestorePermissionError(error)) {
        // The listener already told the user the path is closed, and this would otherwise
        // raise the same alert on every tap.
        if (isDenied) {
          return;
        }

        markDenied();
        Alert.alert(
          'Not allowed yet',
          'The deployed Firestore rules do not allow posts/{postId}/reactions. Add a match for that path in firestore.rules, redeploy, and try again.',
        );
        return;
      }

      console.error('Could not update the reaction:', error);
      Alert.alert('Could not save', 'Please check your connection and try again.');
    } finally {
      setIsMutating(false);
    }
  };

  const toggleFollow = async () => {
    if (isMutating || !currentUserId || !authorId || currentUserId === authorId) {
      return;
    }

    const nextIsFollowing = !isFollowing;

    setIsMutating(true);

    try {
      const followRef = doc(getFirebaseDb(), 'users', currentUserId, 'following', authorId);

      if (nextIsFollowing) {
        await setDoc(followRef, { createdAt: serverTimestamp(), userId: authorId });
      } else {
        await deleteDoc(followRef);
      }

      followCache.set(`${currentUserId}|${authorId}`, nextIsFollowing);
      setIsFollowing(nextIsFollowing);
    } catch (error) {
      followCache.delete(`${currentUserId}|${authorId}`);

      if (isFirestorePermissionError(error)) {
        Alert.alert(
          'Not allowed yet',
          'The deployed Firestore rules do not allow following. Deploy the updated firestore.rules and try again.',
        );
        return;
      }

      console.error('Could not update follow:', error);
      Alert.alert('Could not save', 'Please check your connection and try again.');
    } finally {
      setIsMutating(false);
    }
  };

  // The native share sheet is opened with the media link plus the caption, which is the part
  // people paste into a message. expo-sharing is not used: it needs a local file, and it adds
  // a native module, while the link already points at the public media URL.
  const sharePost = async () => {
    if (isSharing) {
      return;
    }

    const mediaUrl = post.mediaUrl?.trim() ?? '';
    const caption = post.caption?.trim() ?? '';
    const message = [caption, mediaUrl].filter(Boolean).join('\n\n');

    if (!message) {
      notify('Nothing to share', 'This post has no caption or media link yet.');
      return;
    }

    setIsSharing(true);

    // A browser with no share sheet goes straight to the clipboard, so the tap still does
    // something useful instead of reporting a failure the user cannot act on.
    if (!canOpenShareSheet()) {
      const copied = await copyPostLink(mediaUrl || message);

      setIsSharing(false);

      if (copied) {
        notify('Link copied', 'This browser cannot open a share sheet, so the link to this post is on your clipboard.');
      } else {
        notify('Sharing not available', 'This browser can neither share nor copy the link.');
      }

      return;
    }

    try {
      const result = await Share.share({ message, title: caption || 'Convo' });

      // Resolving does not always mean the post was sent: iOS reports a dismissed sheet, and
      // only a completed share is worth a count. Android always reports sharedAction, so a
      // share cancelled there still counts.
      if (result.action === Share.dismissedAction) {
        return;
      }

      await recordShare(post.id);
    } catch (error) {
      console.error('Could not share the post:', error);

      // The sheet can still fail on a device: a target app that rejects the intent, or a
      // browser that only offers the API in a secure context it has not been given yet.
      if (await copyPostLink(mediaUrl || message)) {
        notify('Link copied', 'The link to this post is on your clipboard.');
        return;
      }

      notify('Could not share', 'Please try again in a moment.');
    } finally {
      setIsSharing(false);
    }
  };

  const isOwnPost = Boolean(currentUserId) && currentUserId === authorId;
  const active: Record<SocialActionKey, boolean> = {
    comment: false,
    like: hasLiked,
    love: hasLoved,
    share: false,
  };
  // Comment and share have no subcollection to count, so those two still come from the
  // post document; like and love are counted from the reactions themselves.
  const counts: Record<SocialActionKey, number> = {
    comment: post.commentsCount,
    like: reactionCounts.like,
    love: reactionCounts.love,
    share: post.sharesCount,
  };

  return (
    <View style={[styles.socialBar, { bottom: bottomInset }]}>
      <View style={styles.socialAuthor}>
        <View style={styles.socialAvatar}>
          <Text style={styles.socialAvatarLetter}>
            {(post.displayName || 'User').charAt(0).toUpperCase()}
          </Text>
        </View>
        <Text numberOfLines={1} style={styles.socialUsername}>@{post.displayName || 'User'}</Text>
        {isOwnPost ? null : (
          <Pressable
            accessibilityRole="button"
            disabled={!authorId || isMutating}
            onPress={() => void toggleFollow()}
            style={[styles.followButton, isFollowing && styles.followButtonActive]}
          >
            <Text style={styles.followButtonText}>{isFollowing ? 'Following' : 'Follow'}</Text>
          </Pressable>
        )}
      </View>

      <View style={styles.socialIcons}>
        {SOCIAL_ACTIONS.map((action) => {
          // A toggled action takes its own colour; the rest stay white. Both are light
          // enough to read against the navy bar.
          const isActive = active[action.key];
          const tint = !isActive
            ? '#FFFFFF'
            : action.key === 'love' ? '#EF4444' : '#FFFFFF';

          return (
            <Pressable
              accessibilityLabel={action.key}
              accessibilityRole="button"
              // Denied rules would fail on every tap, so the button is disabled instead of
              // raising the same alert repeatedly. Only the reactions are closed in that
              // case; comments live on their own path and stay reachable. Share is held only
              // while the sheet is open, so a second tap cannot queue another one.
              disabled={isMutating
                || (isDenied && (action.key === 'like' || action.key === 'love'))
                || (action.key === 'share' && isSharing)}
              key={action.key}
              onPress={() => {
                if (action.key === 'like' || action.key === 'love') {
                  void toggleReaction(action.key);
                  return;
                }

                if (action.key === 'comment') {
                  onOpenComments(post.id);
                  return;
                }

                void sharePost();
              }}
              style={styles.socialIcon}
            >
              <Ionicons
                color={tint}
                name={isActive ? action.iconActive : action.icon}
                size={22}
                style={isActive ? null : styles.socialIconInactive}
              />
              <Text style={styles.socialCount}>{formatCount(counts[action.key])}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const FEED_TABS = ['Follow', 'Friends', 'Public', 'Live', 'Explore'] as const;

function FeedTabs({
  onSelect,
  selectedTab,
}: {
  onSelect: (tab: string) => void;
  selectedTab: string;
}) {
  // The active tab is the selectedTab that lives in Home, because that same value decides what
  // the screen renders below. A second activeTab kept here would be free to disagree with it.
  //
  // The underline is drawn inside the active tab rather than slid between them. A sliding bar
  // has to be told where the labels ended up, and that measurement is what left it stranded
  // under the wrong word when the row reflowed.
  return (
    <View style={styles.feedTabsWrapper}>
      <View style={styles.feedTabsRow}>
        {FEED_TABS.map((tab) => {
          const isActive = tab === selectedTab;

          return (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
              key={tab}
              onPress={() => onSelect(tab)}
              style={styles.feedTab}
            >
              <Text style={[styles.feedTabText, isActive && styles.feedTabTextActive]}>{tab}</Text>
              {/* Present on every tab and transparent when inactive, so the row never changes
                  height as the selection moves. */}
              <View style={[styles.feedUnderline, isActive && styles.feedUnderlineActive]} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'black' },
  loadingContainer: { flex: 1, backgroundColor: 'black', justifyContent: 'center', alignItems: 'center' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'black' },
  emptyText: { color: 'white', fontSize: 20, fontWeight: 'bold' },
  emptySubText: { color: 'gray', fontSize: 14, marginTop: 10 },
  itemContainer: { width: '100%' },
  // The media box: fills the item with no padding, and stays black so a photo that does not
  // match the phone shape is letterboxed against it instead of showing an edge.
  media: { backgroundColor: 'black', flex: 1, height: '100%', width: '100%' },
  // What a photo, a video or the pressable around it all share.
  mediaFill: { flex: 1, height: '100%', width: '100%' },
  // Sits directly on top of the social bar, so the caption is raised by the bar height plus
  // a little breathing room. The offset itself is applied at render, because the tab bar
  // height and the phone inset are only known on the device.
  overlay: { position: 'absolute', left: 16, right: 16, marginBottom: 10 },
  // Heavier than the description under it, so the headline reads first at a glance.
  postTitle: { color: '#FFFFFF', flex: 1, fontSize: 16, fontWeight: '700', lineHeight: 21 },
  // The title and the audience icon on one line, so the icon sits on the title's baseline rather
  // than adding a row of its own to the overlay above the caption.
  postTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 6, marginBottom: 4 },
  postTitleIcon: { marginTop: 1 },
  // An untitled post that is still restricted shows the audience on its own, in the title's place.
  postTitleOnly: { alignItems: 'center', flexDirection: 'row', gap: 6, marginBottom: 4 },
  postTitleMarked: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  caption: { color: '#FFFFFF', fontSize: 14, lineHeight: 19 },
  soundLabel: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 5,
    marginBottom: 6,
    maxWidth: '100%',
    paddingVertical: 2,
  },
  soundLabelText: { color: '#FFFFFF', flexShrink: 1, fontSize: 12, fontWeight: '600' },
  hashtag: { color: '#3B82F6' },
  indicator: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    borderRadius: 40,
    height: 72,
    justifyContent: 'center',
    position: 'absolute',
    top: '50%',
    transform: [{ translateY: -36 }],
    width: 72,
  },
  playIcon: {
    backgroundColor: 'transparent',
    borderBottomColor: 'transparent',
    borderBottomWidth: 13,
    borderLeftColor: '#FFFFFF',
    borderLeftWidth: 22,
    borderTopColor: 'transparent',
    borderTopWidth: 13,
    height: 0,
    marginLeft: 4,
    width: 0,
  },
  pauseIcon: {
    flexDirection: 'row',
    gap: 7,
  },
  pauseBar: {
    backgroundColor: '#FFFFFF',
    borderRadius: 2,
    height: 26,
    width: 7,
  },
  speedBadge: {
    alignSelf: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
    position: 'absolute',
    top: 28,
  },
  speedBadgeText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  seekOverlay: {
    alignSelf: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    borderRadius: 14,
    left: 20,
    paddingHorizontal: 16,
    paddingVertical: 12,
    position: 'absolute',
    right: 20,
  },
  seekTime: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    textAlign: 'center',
  },
  // The bar floats over the video rather than shortening the page, and it owns the pill and the
  // search button in one row so the two can never land on top of each other. It starts below
  // the status bar instead of at a fixed offset.
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 0,
    paddingHorizontal: 12,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 10,
  },
  feedTabsWrapper: {
    // Takes all the width the search button leaves, so the five labels share it evenly instead
    // of sizing to their text and running off the right edge.
    flex: 1,
    zIndex: 10,
    // Translucent black, the same fill as the tab bar below, so the video shows through both
    // bars. The pill shape keeps the tint from sitting as a hard band across the post.
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  searchButton: {
    alignItems: 'center',
    // The same tint as the pill, because the glyph is white and a white icon on the explore
    // screen's white background would be invisible without it.
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    borderRadius: 999,
    height: 38,
    justifyContent: 'center',
    marginLeft: 10,
    width: 38,
  },
  feedTabsRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  feedTab: {
    // An equal share of the row each, centred, so the labels are evenly distributed and none
    // of them can be pushed off the end of the pill.
    alignItems: 'center',
    flex: 1,
    paddingVertical: 6,
  },
  feedTabText: {
    // White at reduced opacity, so the inactive tabs stay readable over a bright frame of the
    // video and the active one still stands out. 14 rather than 15 because five labels now
    // share the row and each one has its own slot in it.
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: 'bold',
    opacity: 0.65,
  },
  feedTabTextActive: {
    color: '#FFFFFF',
    opacity: 1,
  },
  feedUnderline: {
    backgroundColor: 'transparent',
    borderRadius: 2,
    height: 3,
    marginTop: 5,
    width: 18,
  },
  feedUnderlineActive: {
    backgroundColor: '#FFFFFF',
  },
  socialBar: {
    position: 'absolute',
    // Sits on top of the tab bar rather than flush with the bottom of the post, because the
    // bar itself now floats over the feed. Edge to edge: no side inset and no rounding, so
    // the two read as one stacked shape.
    left: 0,
    right: 0,
    width: '100%',
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: SOCIAL_BAR_BACKGROUND,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  socialAuthor: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  socialAvatar: {
    alignItems: 'center',
    backgroundColor: '#172554',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  socialAvatarLetter: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  socialUsername: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 'bold',
    flexShrink: 1,
  },
  followButton: {
    backgroundColor: '#22C55E',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  followButtonActive: {
    backgroundColor: '#374151',
  },
  followButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: 'bold',
  },
  socialIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  socialIcon: {
    alignItems: 'center',
    gap: 3,
  },
  // Dims an icon that has not been toggled so the active ones carry the emphasis.
  socialIconInactive: {
    opacity: 0.6,
  },
  socialCount: {
    color: '#FFFFFF',
    fontSize: 12,
  },
  // The owner menu, hard right just under the tab pill. Absolute because it sits on the media,
  // not in a row: a row of chrome on top of a full page photo would need its own background and
  // would cover the picture. One number under an absolute fill box, so the feed keeps its height.
  postOptionsButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    borderRadius: 999,
    height: 36,
    justifyContent: 'center',
    position: 'absolute',
    right: 12,
    width: 36,
    // Under the top bar, which carries its own zIndex, so the pill always sits on the post.
    zIndex: 9,
  },
  optionsRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  optionsBackdrop: {
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    flex: 1,
  },
  // The same dark fill as the music sheet, so the two overlays belong to one surface. Solid, not
  // translucent: nothing of the post needs to show through a menu.
  optionsSheet: {
    backgroundColor: '#111827',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingTop: 8,
  },
  optionsHandle: {
    alignSelf: 'center',
    backgroundColor: '#4B5563',
    borderRadius: 2,
    height: 4,
    marginBottom: 8,
    width: 40,
  },
  optionsRow: {
    alignItems: 'center',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 14,
    minHeight: 56,
    paddingHorizontal: 12,
  },
  optionsRowPressed: {
    backgroundColor: '#1F2937',
  },
  optionsDivider: {
    backgroundColor: '#1F2937',
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 12,
  },
  optionsLabel: {
    color: '#FFFFFF',
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
  },
  optionsLabelDanger: {
    color: '#FF6B6B',
  },
});
