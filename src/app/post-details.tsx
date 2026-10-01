import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useVideoPlayer, VideoView } from 'expo-video';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';
import { PostSound, toPostSoundValue } from '@/lib/music';
import { uploadPost } from '@/lib/upload-post';
import { getString } from '@/lib/user-data';

type MediaType = 'image' | 'video';

// The lighter grey the description sits in, kept separate from the border grey so the two do not
// drift into each other.
const MUTED = '#8E8E93';
const DIVIDER = '#EFEFF0';
const POST_RED = '#FE2C55';

// Route params arrive as strings, and the media type is optional because a camera uri carries its
// own extension. Anything unrecognised is treated as an image, which is what the picker returns.
function toMediaType(value: unknown, uri: string): MediaType {
  if (value === 'video' || value === 'image') {
    return value;
  }

  const path = uri.split('?')[0].toLowerCase();
  return /\.(mp4|mov|m4v|3gp|webm|avi)$/.test(path) ? 'video' : 'image';
}

// A video cover cannot be an Image, so it plays the first frame muted instead. Kept as its own
// component because the player hook cannot be called conditionally from the parent.
function VideoCover({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.play();
  });

  return (
    <VideoView
      contentFit="cover"
      nativeControls={false}
      player={player}
      style={styles.cover}
    />
  );
}

const OPTIONS: { icon: keyof typeof Ionicons.glyphMap; title: string }[] = [
  { icon: 'link-outline', title: 'Add link' },
  { icon: 'people-outline', title: 'Followers can view this post' },
  { icon: 'ellipsis-horizontal', title: 'More options' },
  { icon: 'share-outline', title: 'Share to' },
];

// The sound picked on the camera screen arrives as a JSON string, because a route param can only
// be a string. A malformed or hand-edited param reads as no sound rather than throwing on mount.
function toSoundParam(value: unknown): PostSound | null {
  if (typeof value !== 'string' || !value) {
    return null;
  }

  try {
    return toPostSoundValue(JSON.parse(value));
  } catch {
    return null;
  }
}

export default function PostDetailsScreen() {
  // Only the media comes in. The title and the description are never passed as params because
  // this screen is the only place they are written, and base64 cannot ride in a URL either, so
  // the file is read from the uri at upload time.
  const params = useLocalSearchParams<{
    mediaType?: string;
    sound?: string;
    uri?: string;
  }>();

  const uri = typeof params.uri === 'string' ? params.uri : '';
  const mediaType = toMediaType(params.mediaType, uri);
  // Parsed once per param rather than on every render, so the sound keeps one identity and the
  // upload callback is not rebuilt each time anything on screen changes.
  const sound = useMemo(() => toSoundParam(params.sound), [params.sound]);

  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // The expand control only changes how much of the description is on screen, so the text itself
  // is never truncated on save.
  const [isExpanded, setIsExpanded] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const descriptionRef = useRef<TextInput>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    try {
      unsubscribe = onAuthStateChanged(getFirebaseAuth(), setCurrentUser);
    } catch (error) {
      console.error('Firebase auth is unavailable:', error);
    }

    return unsubscribe;
  }, []);

  useEffect(() => {
    const uid = currentUser?.uid;
    if (!uid) {
      return undefined;
    }

    let isCancelled = false;

    void (async () => {
      try {
        const snapshot = await getDoc(doc(getFirebaseDb(), 'users', uid));
        const data = snapshot.exists() ? snapshot.data() : {};
        const name = getString(data, ['displayName', 'name', 'username']);
        if (!isCancelled) {
          setDisplayName(name || currentUser?.displayName || uid.slice(0, 8));
        }
      } catch (error) {
        console.error('Could not load the profile name:', error);
        if (!isCancelled) {
          setDisplayName(currentUser?.displayName || uid.slice(0, 8));
        }
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [currentUser]);

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace('/upload');
  }, []);

  // Hashtag and mention append their character to the description and hand focus back to it, with
  // a space first unless the field is empty or already ends in one.
  const insertIntoDescription = useCallback((token: string) => {
    descriptionRef.current?.focus();
    setDescription((current) => `${current}${current.endsWith(' ') || !current ? '' : ' '}${token}`);
  }, []);

  // A local suggestion rather than a model call: there is no caption service wired up, and a
  // canned opening that already echoes the title is more use than an alert saying nothing works.
  const suggestCaption = useCallback(() => {
    const trimmedTitle = title.trim();

    if (trimmedTitle) {
      setDescription(
        `${trimmedTitle}\n\nDrop a comment telling us where this was shot and what made you stop scrolling.`,
      );
      return;
    }

    setDescription('A moment worth stopping for. What would you have done differently?');
  }, [title]);

  const notWired = useCallback((titleText: string) => {
    Alert.alert(titleText, 'This option is part of the new post flow and is not connected yet.');
  }, []);

  const onPost = useCallback(async () => {
    if (!currentUser) {
      Alert.alert('Login required', 'You need to be logged in to post.');
      return;
    }

    if (!uri) {
      Alert.alert('Nothing to post', 'This screen needs a photo or clip from the camera or your library.');
      return;
    }

    setIsUploading(true);

    try {
      await uploadPost({
        // The feed reads the description as the caption and draws the title on its own line above
        // it, so the title is deliberately not folded into this.
        caption: description.trim(),
        description,
        displayName: displayName || currentUser.displayName || 'User',
        mediaType,
        // The attribution fields come along because a CC BY track has to name the artist and the
        // licence.
        ...(sound ? { sound } : {}),
        title,
        uri,
        userId: currentUser.uid,
      });
    } catch (error) {
      // uploadPost has already turned the failure into the sentence to show.
      Alert.alert('Could not post', error instanceof Error ? error.message : 'Please try again in a moment.');
      setIsUploading(false);
      return;
    }

    setIsUploading(false);
    router.replace('/home');
  }, [currentUser, description, displayName, mediaType, sound, title, uri]);

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
      <StatusBar style="dark" />

      {/* Back on the left, the screen name on the right, as the reference layout has it. */}
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Go back"
          accessibilityRole="button"
          hitSlop={12}
          onPress={goBack}
          style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
        >
          <Ionicons color="#111111" name="chevron-back" size={28} />
        </Pressable>

        <Text style={styles.headerTitle}>Preview</Text>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Cover on the left, the title beside it. */}
          <View style={styles.previewRow}>
            <View style={styles.coverWrap}>
              {mediaType === 'video' && uri ? (
                <VideoCover uri={uri} />
              ) : uri ? (
                <Image contentFit="cover" source={{ uri }} style={styles.cover} />
              ) : (
                <View style={[styles.cover, styles.coverEmpty]}>
                  <Ionicons color="#B4B4B8" name="image-outline" size={22} />
                </View>
              )}

              {/* Sits on the thumbnail's own corner rather than beside it. */}
              <View style={styles.coverBadge}>
                <Text style={styles.coverBadgeText}>Cover</Text>
              </View>
            </View>

            <TextInput
              editable={!isUploading}
              maxLength={100}
              onChangeText={setTitle}
              onSubmitEditing={() => descriptionRef.current?.focus()}
              placeholder="Add a catchy title"
              placeholderTextColor="#111111"
              returnKeyType="next"
              style={styles.titleInput}
              value={title}
            />
          </View>

          <TextInput
            editable={!isUploading}
            maxLength={220}
            multiline
            numberOfLines={isExpanded ? 10 : 4}
            onChangeText={setDescription}
            placeholder="Writing a long description can help get 3x more views on average."
            placeholderTextColor={MUTED}
            ref={descriptionRef}
            style={[styles.descriptionInput, isExpanded && styles.descriptionInputExpanded]}
            textAlignVertical="top"
            value={description}
          />

          {/* Hashtag, mention and caption sit on the left, expand is pushed to the far right. */}
          <View style={styles.toolbar}>
            <Pressable
              accessibilityLabel="Add a hashtag"
              accessibilityRole="button"
              disabled={isUploading}
              hitSlop={8}
              onPress={() => insertIntoDescription('#')}
              style={({ pressed }) => [styles.toolbarButton, pressed && styles.pressed]}
            >
              <Text style={styles.toolbarSymbol}>#</Text>
            </Pressable>

            <Pressable
              accessibilityLabel="Mention someone"
              accessibilityRole="button"
              disabled={isUploading}
              hitSlop={8}
              onPress={() => insertIntoDescription('@')}
              style={({ pressed }) => [styles.toolbarButton, pressed && styles.pressed]}
            >
              <Text style={styles.toolbarSymbol}>@</Text>
            </Pressable>

            <Pressable
              accessibilityLabel="Suggest a caption"
              accessibilityRole="button"
              disabled={isUploading}
              hitSlop={8}
              onPress={suggestCaption}
              style={({ pressed }) => [styles.toolbarButton, pressed && styles.pressed]}
            >
              <Ionicons color="#111111" name="sparkles-outline" size={22} />
            </Pressable>

            <Pressable
              accessibilityLabel={isExpanded ? 'Collapse the description' : 'Expand the description'}
              accessibilityRole="button"
              disabled={isUploading}
              hitSlop={8}
              onPress={() => setIsExpanded((current) => !current)}
              style={({ pressed }) => [styles.toolbarButton, styles.toolbarButtonEnd, pressed && styles.pressed]}
            >
              <Ionicons
                color="#111111"
                name={isExpanded ? 'expand' : 'expand-outline'}
                size={22}
              />
            </Pressable>
          </View>

          {OPTIONS.map((option) => (
            <Pressable
              key={option.title}
              accessibilityLabel={option.title}
              accessibilityRole="button"
              disabled={isUploading}
              onPress={() => notWired(option.title)}
              style={({ pressed }) => [styles.optionRow, pressed && styles.optionRowPressed]}
            >
              <Ionicons color="#111111" name={option.icon} size={22} />
              <Text style={styles.optionTitle}>{option.title}</Text>
              <Ionicons color="#C7C7CC" name="chevron-forward" size={18} />
            </Pressable>
          ))}
        </ScrollView>

        {/* Drafts sits beside Post rather than under it, so neither can be missed with a thumb. */}
        <View style={styles.actions}>
          <Pressable
            accessibilityLabel="Drafts"
            accessibilityRole="button"
            disabled={isUploading}
            onPress={() => notWired('Drafts')}
            style={({ pressed }) => [
              styles.actionButton,
              styles.draftsButton,
              pressed && styles.pressed,
              isUploading && styles.disabled,
            ]}
          >
            <Ionicons color="#111111" name="document-text-outline" size={19} />
            <Text style={styles.draftsLabel}>Drafts</Text>
          </Pressable>

          <Pressable
            accessibilityLabel="Post"
            accessibilityRole="button"
            disabled={isUploading || !uri}
            onPress={() => void onPost()}
            style={({ pressed }) => [
              styles.actionButton,
              styles.postButton,
              pressed && styles.pressed,
              (isUploading || !uri) && styles.disabled,
            ]}
          >
            {isUploading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <>
                <Ionicons color="#FFFFFF" name="arrow-up-circle-outline" size={20} />
                <Text style={styles.postLabel}>Post</Text>
              </>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#FFFFFF',
    flex: 1,
  },
  flex: { flex: 1 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    // The same inset as the content below, so the arrow and the word line up with the rows under
    // them rather than sitting a few pixels further out.
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  headerButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    // Pulled left of the text inset, which is where a back arrow reads as belonging to the edge
    // rather than to the content column.
    marginLeft: -8,
    width: 40,
  },
  headerTitle: {
    color: '#111111',
    fontSize: 17,
    fontWeight: '700',
  },
  content: {
    paddingBottom: 24,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  previewRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
  },
  // Sized here rather than on the cover itself, so the badge can be positioned against a square
  // that never changes.
  coverWrap: {
    borderRadius: 10,
    height: 96,
    width: 96,
  },
  cover: {
    backgroundColor: '#F2F2F4',
    borderRadius: 10,
    height: '100%',
    width: '100%',
  },
  coverEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverBadge: {
    backgroundColor: '#000000',
    borderBottomRightRadius: 8,
    borderTopLeftRadius: 10,
    left: 0,
    paddingHorizontal: 6,
    paddingVertical: 2,
    position: 'absolute',
    top: 0,
  },
  coverBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
  },
  titleInput: {
    color: '#111111',
    flex: 1,
    fontSize: 17,
    fontWeight: '700',
    // Matches the cover's height so the field's tap area lines up with the square beside it.
    minHeight: 96,
    paddingHorizontal: 4,
    // Android top-aligns a field that is taller than its text, which would drop the title below
    // the middle of the cover.
    textAlignVertical: 'center',
  },
  descriptionInput: {
    color: '#111111',
    fontSize: 15,
    lineHeight: 21,
    marginTop: 14,
    minHeight: 84,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  descriptionInputExpanded: {
    minHeight: 200,
  },
  toolbar: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 20,
    paddingVertical: 12,
  },
  toolbarButton: {
    alignItems: 'center',
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  toolbarButtonEnd: {
    marginLeft: 'auto',
  },
  toolbarSymbol: {
    color: '#111111',
    fontSize: 22,
    fontWeight: '600',
  },
  optionRow: {
    alignItems: 'center',
    borderBottomColor: DIVIDER,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 14,
    minHeight: 56,
    paddingHorizontal: 4,
  },
  optionRowPressed: {
    backgroundColor: '#F7F7F8',
  },
  optionTitle: {
    color: '#111111',
    flex: 1,
    fontSize: 15,
  },
  actions: {
    borderTopColor: DIVIDER,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  actionButton: {
    alignItems: 'center',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 8,
    height: 50,
    justifyContent: 'center',
  },
  draftsButton: {
    backgroundColor: '#EFEFF0',
  },
  draftsLabel: {
    color: '#111111',
    fontSize: 16,
    fontWeight: '700',
  },
  postButton: {
    backgroundColor: POST_RED,
    flex: 1,
  },
  postLabel: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.6,
  },
  disabled: {
    opacity: 0.45,
  },
});