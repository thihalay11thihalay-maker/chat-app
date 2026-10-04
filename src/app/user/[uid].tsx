import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { doc, getDoc } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { openDirectChat, readPerson } from '@/lib/chat-rooms';
import { getFirebaseAuth, getFirebaseDb, isFirestorePermissionError } from '@/lib/firebase';
import { loadFollowCounts, readFollow, setFollowing } from '@/lib/follow';
import { listenToUserPosts, Post } from '@/lib/post';
import { getAge, getString } from '@/lib/user-data';

/** The feed's own words for each audience, so a post reads the same in both places. */
const VISIBILITY_LABEL: Record<string, string> = {
  followers_friends: 'Followers and friends',
  friends_only: 'Friends only',
  only_me: 'Only me',
  public: 'Public',
};

/**
 * Somebody's profile: who they are, whether this account follows them, and what they have posted.
 *
 * A screen rather than a sheet because it is where a person goes to find out more about somebody, and
 * everything here is a reason to keep looking -- a post they wrote, whether this account is already
 * talking to them, who else follows them. A sheet would put all of that behind one dismiss.
 *
 * The name in the route params is drawn first and the profile read overwrites it. This is opened from
 * places that already know who they are opening -- a comment, a search result -- and the title should
 * not be blank while a read is in flight. It is a placeholder rather than a source: a name passed in
 * from a list can be stale, and the read always wins.
 */
export default function UserProfileScreen() {
  const { name: passedName, uid } = useLocalSearchParams<{ name?: string; uid: string }>();
  const authorId = Array.isArray(uid) ? uid[0] : uid || '';
  const fallbackName = Array.isArray(passedName) ? passedName[0] ?? '' : passedName ?? '';

  // Resolved rather than read at render: on a cold start Firebase restores the session
  // asynchronously, so a first render can legitimately have no account yet. Reading it once would
  // leave Follow and Message disabled for as long as this screen stayed open.
  const [viewerId, setViewerId] = useState('');

  useEffect(() => {
    let unsubscribe = () => {};

    try {
      unsubscribe = onAuthStateChanged(getFirebaseAuth(), (user) => setViewerId(user?.uid ?? ''));
    } catch (error) {
      console.error('Firebase auth is unavailable:', error);
    }

    return unsubscribe;
  }, []);

  const isMe = authorId !== '' && authorId === viewerId;

  const [profile, setProfile] = useState({ age: null as number | null, city: '', name: fallbackName, photoUrl: '' });
  const [posts, setPosts] = useState<Post[]>([]);
  const [counts, setCounts] = useState<{ followers: number | null; following: number | null }>({ followers: null, following: null });
  const [isFollowing, setIsFollowing] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingPosts, setIsLoadingPosts] = useState(true);
  const [error, setError] = useState('');

  /**
   * The profile, the follow state and the two counts, read together.
   *
   * Focus rather than mount, so a name changed elsewhere is the name shown here when the reader comes
   * back, and so a follow pressed here is still a follow afterwards.
   *
   * The counts are allowed to be unknown and are not waited for separately: "how many people follow
   * her" is not worth a blank profile, and the follower list needs rules the app may not have
   * deployed yet.
   */
  const load = useCallback(() => {
    if (!authorId) {
      setIsLoading(false);
      setError('That profile could not be opened.');

      return;
    }

    setIsLoading(true);
    setError('');
    let isStale = false;

    void (async () => {
      try {
        const snapshot = await getDoc(doc(getFirebaseDb(), 'users', authorId));
        const data = snapshot.exists() ? snapshot.data() : {};
        const person = readPerson(data, '');

        if (isStale) {
          return;
        }

        setProfile({
          age: getAge(data),
          city: getString(data, ['city', 'country']),
          name: person.name || fallbackName,
          photoUrl: person.photoUrl,
        });

        // A signed-out reader is shown the profile and nothing to press: following is something an
        // account does, and there is no account here to do it with.
        if (viewerId) {
          const [following, loaded] = await Promise.all([
            readFollow(viewerId, authorId),
            loadFollowCounts(authorId, viewerId),
          ]);

          if (!isStale) {
            setIsFollowing(following);
            setCounts(loaded);
          }
        }
      } catch (loadError) {
        console.error('Could not load the profile:', loadError);

        if (!isStale) {
          setError('Could not load this profile. Please try again.');
        }
      } finally {
        if (!isStale) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      isStale = true;
    };
  }, [authorId, fallbackName, viewerId]);

  useFocusEffect(useCallback(() => load() as () => void, [load]));

  // The posts are a listener rather than part of `load`: this screen stays open while somebody reads
  // them, and a profile that only knows what was true when it opened is a screenshot. It is torn down
  // with the screen, because an unmounted screen holding a query open is a leak nobody would notice.
  useFocusEffect(
    useCallback(() => {
      if (!authorId) {
        return;
      }

      return listenToUserPosts(
        authorId,
        viewerId,
        (next) => {
          setPosts(next);
          setIsLoadingPosts(false);
        },
        (listenError) => {
          console.error('Could not read this profile\'s posts:', listenError);
          setIsLoadingPosts(false);

          if (isFirestorePermissionError(listenError)) {
            console.warn(
              `Reading the posts of ${authorId} was refused. Deploy the updated firestore.rules and `
              + 'firestore.indexes.json, then try again.',
            );
          }
        },
      );
    }, [authorId, viewerId]),
  );

  const toggleFollow = async () => {
    if (isWorking || isMe || !viewerId || !authorId) {
      return;
    }

    const nextIsFollowing = !isFollowing;

    setIsWorking(true);

    try {
      await setFollowing(viewerId, authorId, nextIsFollowing);
      setIsFollowing(nextIsFollowing);

      // The count on this profile is the only one a reader can watch change, so it moves here rather
      // than waiting to be right. It stays null when the rules would not let the number be read in
      // the first place: a count this screen cannot read is a count it cannot honestly move.
      setCounts((current) => (
        current.followers === null
          ? current
          : { ...current, followers: Math.max(0, current.followers + (nextIsFollowing ? 1 : -1)) }
      ));
    } catch (followError) {
      console.error('Could not update follow:', followError);

      if (isFirestorePermissionError(followError)) {
        Alert.alert(
          'Not allowed yet',
          'The deployed Firestore rules do not allow following. Deploy the updated firestore.rules and try again.',
        );
        return;
      }

      Alert.alert('Could not save', 'Please check your connection and try again.');
    } finally {
      setIsWorking(false);
    }
  };

  /**
   * Opens the conversation, or makes it if there is not one already.
   *
   * Looked up before it is made rather than the other way round, because the participant list cannot
   * be changed after a room is written, so a second room with the same two people would be a second
   * conversation with them.
   */
  const message = async () => {
    if (isWorking || !viewerId || !authorId) {
      return;
    }

    setIsWorking(true);

    try {
      const chatId = await openDirectChat(authorId, profile.name);

      router.push({
        params: { id: chatId, name: profile.name, otherUserId: authorId },
        pathname: '/chat/[id]',
      } as never);
    } catch (messageError) {
      console.error('Could not start a conversation:', messageError);
      Alert.alert('Could not open the conversation', 'Please try again in a moment.');
    } finally {
      setIsWorking(false);
    }
  };

  const details = [
    profile.age === null ? '' : `${profile.age} years old`,
    profile.city,
  ].filter(Boolean).join('  ·  ');

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Go back"
          accessibilityRole="button"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
        >
          <Ionicons color="#20232A" name="chevron-back" size={24} />
        </Pressable>
      </View>

      {isLoading ? (
        <ActivityIndicator color="#2FBF71" style={styles.loading} />
      ) : (
        <FlatList
          ListEmptyComponent={isLoadingPosts ? (
            <ActivityIndicator color="#2FBF71" style={styles.loading} />
          ) : (
            <Text style={styles.empty}>{error || 'Nothing posted here yet.'}</Text>
          )}
          ListHeaderComponent={(
            <View style={styles.identity}>
              {profile.photoUrl ? (
                <Image source={{ uri: profile.photoUrl }} style={styles.picture} />
              ) : (
                <View style={[styles.picture, styles.pictureFallback]}>
                  <Text style={styles.initial}>{(profile.name || '?').charAt(0).toUpperCase()}</Text>
                </View>
              )}

              <Text style={styles.name}>{profile.name || 'Nobody'}</Text>
              <Text style={styles.meta}>{details || 'Nothing about them yet'}</Text>

              {/* Only the numbers that could actually be read. A count the rules would not return is
                  left off rather than shown as zero, because "0 followers" is a claim about somebody
                  and this screen has not been able to check it. */}
              <View style={styles.counts}>
                {counts.following === null ? null : (
                  <Text style={styles.count}>
                    <Text style={styles.countNumber}>{counts.following}</Text> following
                  </Text>
                )}
                {counts.followers === null ? null : (
                  <Text style={styles.count}>
                    <Text style={styles.countNumber}>{counts.followers}</Text> followers
                  </Text>
                )}
              </View>

              {/* Your own profile has nothing to follow and nobody to message, and offering both would
                  be two buttons that can only ever report a mistake. */}
              {isMe ? null : (
                <View style={styles.actions}>
                  <Pressable
                    accessibilityLabel={isFollowing ? 'Unfollow' : 'Follow'}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isFollowing }}
                    disabled={isWorking || !viewerId}
                    onPress={() => void toggleFollow()}
                    style={({ pressed }) => [
                      styles.followButton,
                      isFollowing && styles.followButtonActive,
                      pressed && styles.pressed,
                    ]}
                  >
                    {isWorking ? (
                      <ActivityIndicator
                        color={isFollowing ? '#363A42' : '#FFFFFF'}
                        size="small"
                      />
                    ) : (
                      <Text style={[styles.followButtonText, isFollowing && styles.followButtonTextActive]}>
                        {isFollowing ? 'Following' : 'Follow'}
                      </Text>
                    )}
                  </Pressable>

                  <Pressable
                    accessibilityLabel={`Message ${profile.name || 'this account'}`}
                    accessibilityRole="button"
                    disabled={isWorking || !viewerId}
                    onPress={() => void message()}
                    style={({ pressed }) => [styles.messageButton, pressed && styles.pressed]}
                  >
                    <Ionicons color="#363A42" name="chatbubble-outline" size={17} />
                    <Text style={styles.messageButtonText}>Message</Text>
                  </Pressable>
                </View>
              )}
            </View>
          )}
          contentContainerStyle={styles.content}
          data={posts}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <ProfilePost post={item} />}
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}

/** One post on somebody's profile: the cover, the caption, and who it was published to. */
function ProfilePost({ post }: { post: Post }) {
  return (
    <View style={styles.post}>
      {post.mediaUrl ? (
        <Image source={{ uri: post.mediaUrl }} style={styles.postMedia} />
      ) : (
        <View style={[styles.postMedia, { backgroundColor: post.backgroundColor ?? '#E7E2DA' }]} />
      )}

      {post.caption ? <Text numberOfLines={2} style={styles.postCaption}>{post.caption}</Text> : null}

      <View style={styles.postMeta}>
        <Text style={styles.postMetaText}>
          {post.likesCount > 0 ? `${post.likesCount} likes  ·  ` : ''}
          {post.commentsCount > 0 ? `${post.commentsCount} comments` : ''}
        </Text>

        {/* Left off entirely when the post has no visibility, which is what a post written before
            visibility existed looks like: the rules treat it as public, so a lock would be invented. */}
        {post.visibility && VISIBILITY_LABEL[post.visibility] ? (
          <Text style={styles.postMetaText}>
            {VISIBILITY_LABEL[post.visibility]}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  headerButton: {
    padding: 4,
  },
  pressed: {
    opacity: 0.7,
  },
  loading: {
    marginTop: 40,
  },
  content: {
    paddingBottom: 40,
    paddingHorizontal: 20,
  },
  identity: {
    alignItems: 'center',
    paddingBottom: 8,
  },
  picture: {
    borderRadius: 45,
    height: 90,
    width: 90,
  },
  pictureFallback: {
    alignItems: 'center',
    backgroundColor: '#E7E2DA',
    justifyContent: 'center',
  },
  initial: {
    color: '#656A73',
    fontSize: 34,
    fontWeight: '700',
  },
  name: {
    color: '#20232A',
    fontSize: 21,
    fontWeight: '700',
    marginTop: 14,
    textAlign: 'center',
  },
  meta: {
    color: '#656A73',
    fontSize: 14,
    marginTop: 6,
    textAlign: 'center',
  },
  counts: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 10,
  },
  count: {
    color: '#8D929C',
    fontSize: 13,
  },
  countNumber: {
    color: '#20232A',
    fontWeight: '700',
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
    width: '100%',
  },
  followButton: {
    alignItems: 'center',
    backgroundColor: '#2FBF71',
    borderRadius: 999,
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  followButtonActive: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E3DED5',
    borderWidth: 1,
  },
  followButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  followButtonTextActive: {
    color: '#363A42',
  },
  messageButton: {
    alignItems: 'center',
    borderColor: '#E3DED5',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  messageButtonText: {
    color: '#363A42',
    fontSize: 14,
    fontWeight: '700',
  },
  post: {
    marginTop: 22,
  },
  postMedia: {
    aspectRatio: 4 / 3,
    borderRadius: 14,
    width: '100%',
  },
  postCaption: {
    color: '#363A42',
    fontSize: 14,
    lineHeight: 19,
    marginTop: 8,
  },
  postMeta: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginTop: 6,
  },
  postMetaText: {
    color: '#A2A7B0',
    fontSize: 12,
  },
  empty: {
    color: '#8D929C',
    fontSize: 14,
    paddingVertical: 30,
    textAlign: 'center',
  },
});
