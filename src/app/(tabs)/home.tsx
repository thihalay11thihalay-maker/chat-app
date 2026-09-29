import { Ionicons } from '@expo/vector-icons';
import { router, useIsFocused } from 'expo-router';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { collection, deleteDoc, doc, getDoc, onSnapshot, orderBy, query, serverTimestamp, setDoc, Timestamp } from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  FlatList,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';

interface Post {
  id: string;
  displayName?: string;
  mediaType?: 'image' | 'video';
  mediaUrl?: string;
  caption?: string;
  createdAt?: Timestamp | Date | null;
  commentsCount: number;
  lovesCount: number;
  likesCount: number;
  sharesCount: number;
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

function toPost(id: string, data: Record<string, unknown>): Post {
  const createdAt = data.createdAt;
  const mediaType = data.mediaType;

  return {
    id,
    caption: typeof data.caption === 'string' ? data.caption : undefined,
    commentsCount: toCount(data, 'commentsCount'),
    createdAt: createdAt instanceof Date || createdAt instanceof Timestamp ? createdAt : null,
    displayName: typeof data.displayName === 'string' ? data.displayName : undefined,
    lovesCount: toCount(data, 'lovesCount'),
    likesCount: toCount(data, 'likesCount'),
    mediaType: mediaType === 'image' || mediaType === 'video' ? mediaType : undefined,
    mediaUrl: typeof data.mediaUrl === 'string' ? data.mediaUrl : undefined,
    sharesCount: toCount(data, 'sharesCount'),
    userId: typeof data.userId === 'string' ? data.userId : '',
  };
}

function PostVideo({
  uri,
  height,
  isActive,
  isMuted,
}: {
  uri: string;
  height: number;
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
      style={{ height, width: '100%' }}
      {...panResponder.panHandlers}
    >
      <Pressable
        accessibilityLabel={isPaused ? 'Play video' : 'Pause video'}
        accessibilityRole="button"
        delayLongPress={FAST_FORWARD_DELAY_MS}
        onLongPress={() => setIsFastForwarding(true)}
        onPress={togglePlayback}
        onPressOut={() => setIsFastForwarding(false)}
        style={{ height: '100%', width: '100%' }}
      >
        <VideoView
          contentFit="cover"
          nativeControls={false}
          player={player}
          style={{ height: '100%', width: '100%' }}
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
          <View pointerEvents="none" style={styles.seekOverlay}>
            <Text style={styles.seekTime}>
              {`${formatTime(seekSeconds)}`}
            </Text>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

export default function Home() {
  const isFocused = useIsFocused();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  // The list is measured instead of trusting the window height, otherwise a header or
  // safe area makes the page height and the item height disagree and snapping drifts.
  const [pageHeight, setPageHeight] = useState(() => Dimensions.get('window').height);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isScrolling, setIsScrolling] = useState(false);
  const [selectedTab, setSelectedTab] = useState('Friends');
  const scrollEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (scrollEndTimer.current) {
        clearTimeout(scrollEndTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    const db = getFirebaseDb();
    const q = query(collection(db, 'posts'), orderBy('createdAt', 'desc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const postsData = snapshot.docs.map((doc) => toPost(doc.id, doc.data()));
      setPosts(postsData);
      setErrorMessage('');
      setLoading(false);
    }, (error) => {
      console.error('Error fetching posts: ', error);
      setErrorMessage(
        error.code === 'permission-denied'
          ? 'You do not have permission to view posts. Check your Firestore security rules.'
          : 'Could not load posts. Please try again.',
      );
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

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

  const renderItem = ({ item, index }: { item: Post; index: number }) => {
    const isCurrentPost = isFocused && !isScrolling && index === activeIndex;

    return (
      <View style={[styles.itemContainer, { height: pageHeight }]}>
        {item.mediaType === 'video' ? (
          <PostVideo
            height={pageHeight}
            isActive={isCurrentPost}
            isMuted={!isCurrentPost}
            uri={item.mediaUrl ?? ''}
          />
        ) : (
          <Image
            contentFit="cover"
            source={{ uri: item.mediaUrl || 'https://i.pravatar.cc/150?u=test' }}
            style={{ height: '100%', width: '100%' }}
          />
        )}

        {/* Only the caption: the author name lives in the social bar, and repeating it
            here stacked the same @name on top of the bar. */}
        <View style={styles.overlay}>
          <CaptionText caption={item.caption} />
        </View>

        <SocialActions key={item.id} post={item} />
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
      {posts.length === 0 ? (
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

      <FeedTabs onSelect={setSelectedTab} selectedTab={selectedTab} />

      <Pressable
        accessibilityLabel="Search"
        accessibilityRole="button"
        onPress={() => router.push('/search')}
        style={styles.searchButton}
      >
        <Ionicons color="#FFFFFF" name="search" size={26} />
      </Pressable>
    </View>
  );
}

// Splits on #tags so they can be tinted without pulling in a markdown style parser.
const HASHTAG_PATTERN = /(#[\wÀ-ɏ]+)/g;

function CaptionText({ caption }: { caption?: string }) {
  const text = caption?.trim();

  if (!text) {
    return <Text style={styles.caption}>No caption</Text>;
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

// Matches the tab bar background so the two stack as a single block. Kept here as a
// constant because the bar is opaque and the shadow that used to lift it is gone.
const SOCIAL_BAR_BACKGROUND = 'rgba(30, 58, 138, 0.95)';

// Both flags live in one document at posts/{postId}/reactions/{userId}, so the viewer only
// needs a single listener per post and a like and a love never fight over separate files.
const REACTIONS_COLLECTION = 'reactions';

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

function isPermissionError(error: unknown) {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';

  return code === 'permission-denied' || code === 'unauthenticated';
}

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
      if (isPermissionError(error)) {
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
        if (isPermissionError(error)) {
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

function SocialActions({ post }: { post: Post }) {
  const [currentUserId, setCurrentUserId] = useState('');
  const [isFollowing, setIsFollowing] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
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

      if (isPermissionError(error)) {
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

      if (isPermissionError(error)) {
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
    <View style={styles.socialBar}>
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
              // raising the same alert repeatedly.
              disabled={isMutating || isDenied}
              key={action.key}
              onPress={() => {
                if (action.key === 'like' || action.key === 'love') {
                  void toggleReaction(action.key);
                  return;
                }

                Alert.alert(
                  action.key === 'share' ? 'Share' : 'Comment',
                  `${formatCount(counts[action.key])} on this post`,
                );
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

// Each tab is a label plus the 12px margins on both sides, so the sliding underline is
// sized and stepped by the same distance and lines up under the label.
const TAB_LABEL_GAP = 24;
const TAB_STRIDE = 72;

const FEED_TABS = ['Friends', 'Public', 'Live'] as const;

function FeedTabs({
  onSelect,
  selectedTab,
}: {
  onSelect: (tab: string) => void;
  selectedTab: string;
}) {
  // Held in state rather than a ref: the value is created once and read during render.
  const [translateX] = useState(() => new Animated.Value(0));
  const activeIndex = Math.max(FEED_TABS.indexOf(selectedTab as typeof FEED_TABS[number]), 0);

  // The underline is a single view that slides to the width of the selected tab instead of
  // three separate lines, which is what gives the TikTok feel.
  useEffect(() => {
    Animated.spring(translateX, {
      toValue: activeIndex * TAB_STRIDE,
      useNativeDriver: true,
      speed: 18,
      bounciness: 6,
    }).start();
  }, [activeIndex, translateX]);

  return (
    // Absolute so the tabs float over the video instead of taking space from it.
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
              <Text style={[styles.feedTabText, isActive ? styles.feedTabTextActive : null]}>
                {tab}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Animated.View style={[styles.feedTabUnderline, { transform: [{ translateX }] }]} />
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
  // Sits directly on top of the social bar, so the caption is raised by the bar height
  // plus a little breathing room.
  overlay: { position: 'absolute', bottom: 78, left: 16, right: 16, marginBottom: 10 },
  caption: { color: '#FFFFFF', fontSize: 14, lineHeight: 19 },
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
    bottom: 110,
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
  feedTabsWrapper: {
    position: 'absolute',
    top: 50,
    alignSelf: 'center',
    zIndex: 10,
  },
  // Same top as the tabs so the icon lines up with their labels, pinned to the right edge.
  searchButton: {
    position: 'absolute',
    right: 20,
    top: 50,
    zIndex: 10,
    padding: 4,
  },
  feedTabsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  feedTab: {
    marginHorizontal: 12,
    paddingVertical: 6,
  },
  feedTabText: {
    color: '#9CA3AF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  feedTabTextActive: {
    color: '#FFFFFF',
  },
  feedTabUnderline: {
    position: 'absolute',
    bottom: 0,
    left: 12,
    height: 3,
    borderRadius: 2,
    backgroundColor: '#FFFFFF',
    width: TAB_STRIDE - TAB_LABEL_GAP,
  },
  socialBar: {
    position: 'absolute',
    // Flush with the bottom of the post, which is where the tab bar starts, so the two
    // read as one stacked shape with no gap between them. Edge to edge: no side inset and
    // no rounding, matching the tab bar directly below it.
    bottom: 0,
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
});
