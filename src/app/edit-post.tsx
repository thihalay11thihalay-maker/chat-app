import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
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
import { toParam, toStringArrayParam } from '@/lib/route-params';
import {
  getSupabaseUploadErrorMessage,
  isSupabaseStorageConfigured,
  removePostMedia,
  storagePathFromUrl,
  uploadPostMedia,
} from '@/lib/supabase';
import { buildAudience, DEFAULT_POST_VISIBILITY, PostVisibility } from '@/lib/upload-post';

const MUTED = '#8E8E93';
const DIVIDER = '#EFEFF0';
const SAVE_RED = '#FE2C55';
const IMAGE_CONTENT_TYPE = 'image/jpeg';

// The same limits the post details screen writes under, so an edit cannot grow a field past what
// the feed is built to lay out.
const TITLE_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 220;

// A ceiling on the photos on one post. Ten is where a phone picker stops being useful and the
// thumbnails stop fitting on screen, and it keeps a mis-tap from uploading a whole library.
const MAX_MEDIA = 10;

// The audiences a post can be published to. Kept identical to the list the post details screen
// offers, including the wording, so the same post never reads as two different settings depending
// on which screen it was set from.
const VISIBILITY_OPTIONS: { description: string; id: PostVisibility; label: string }[] = [
  { description: 'Anyone can see', id: 'public', label: 'Public' },
  {
    description: 'Only people who follow you and your friends',
    id: 'followers_friends',
    label: 'Followers and Friends',
  },
  { description: 'Only your mutual friends', id: 'friends_only', label: 'Friends Only' },
  { description: 'Private, only visible to you', id: 'only_me', label: 'Only Me' },
];

/**
 * The photos and the audience a stored post actually has.
 *
 * A post written before the editor existed has neither field, so both are read with a fallback
 * rather than trusted: the photo list falls back to the single cover, and the audience falls back
 * to public. Falling back to an empty list would show the owner a post with no photos on it, which
 * is not what is published.
 */
function readMedia(data: Record<string, unknown>): string[] {
  const fromArray = Array.isArray(data.mediaUrls)
    ? data.mediaUrls.filter(
        (item): item is string => typeof item === 'string' && /^https?:\/\//i.test(item),
      )
    : [];
  const cover = typeof data.mediaUrl === 'string' && /^https?:\/\//i.test(data.mediaUrl)
    ? data.mediaUrl
    : '';

  if (fromArray.length > 0) {
    // The cover is normally the first entry, but a document written by hand might not be, and the
    // feed draws `mediaUrl`, so it is forced to the front of the list rather than left to disagree
    // with it.
    return cover && !fromArray.includes(cover) ? [cover, ...fromArray] : fromArray;
  }

  return cover ? [cover] : [];
}

function toPostVisibility(value: unknown): PostVisibility {
  const found = VISIBILITY_OPTIONS.find((option) => option.id === value);
  return found ? found.id : DEFAULT_POST_VISIBILITY;
}

export default function EditPostScreen() {
  // The feed passes the post id together with the fields it happened to be holding, so the screen
  // can paint something immediately. The document is still read on mount: it is the only place the
  // photo list, the real audience and the ownership check can come from, and a param is not
  // trustworthy for any of those.
  const params = useLocalSearchParams<{
    description?: string | string[];
    mediaUrls?: string | string[];
    postId?: string | string[];
    visibility?: string | string[];
    title?: string | string[];
  }>();

  const postId = toParam(params.postId);

  const [title, setTitle] = useState(() => toParam(params.title));
  const [description, setDescription] = useState(() => toParam(params.description));
  const [mediaUrls, setMediaUrls] = useState<string[]>(() => toStringArrayParam(params.mediaUrls));
  const [visibility, setPostVisibility] = useState<PostVisibility>(() =>
    toPostVisibility(toParam(params.visibility)),
  );
  const [isLoading, setIsLoading] = useState(Boolean(postId));
  const [isSaving, setIsSaving] = useState(false);
  const [isPickingVisibility, setIsPickingVisibility] = useState(false);
  const [isPickingPhotos, setIsPickingPhotos] = useState(false);
  const [isRemovingMedia, setIsRemovingMedia] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const descriptionRef = useRef<TextInput>(null);

  // Files uploaded during this session that the document does not point at yet. They are removed
  // if the screen goes away without a save, so backing out of a half finished edit does not leave
  // paid-for storage nobody can reach.
  const unsavedUploads = useRef<string[]>([]);
  // Set once the save lands, which is what stops the cleanup above from deleting the very files it
  // just handed over to the document.
  const hasSaved = useRef(false);

  const selectedVisibility =
    VISIBILITY_OPTIONS.find((option) => option.id === visibility) ?? VISIBILITY_OPTIONS[0];

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    try {
      unsubscribe = onAuthStateChanged(getFirebaseAuth(), setCurrentUser);
    } catch (error) {
      console.error('Firebase auth is unavailable:', error);
    }

    return unsubscribe;
  }, []);

  // The document read. It always runs, because the photos, the audience and the ownership check all
  // have to come from the stored post rather than from a route param. It also confirms the post is
  // still there: one deleted from another device between opening this screen and saving has to
  // fail here rather than on a write that silently changes nothing.
  useEffect(() => {
    // No id means there is nothing to read, and isLoading already started false for that case, so
    // there is no state to set here.
    if (!postId) {
      return undefined;
    }

    let isCancelled = false;

    void (async () => {
      try {
        const snapshot = await getDoc(doc(getFirebaseDb(), 'posts', postId));

        if (isCancelled) {
          return;
        }

        if (!snapshot.exists()) {
          setErrorMessage('This post no longer exists.');
          return;
        }

        const data = snapshot.data() as Record<string, unknown>;

        setTitle(typeof data.title === 'string' ? data.title : '');
        setDescription(typeof data.description === 'string' ? data.description : '');
        setMediaUrls(readMedia(data));
        setPostVisibility(toPostVisibility(data.visibility));
        setIsOwner(typeof data.userId === 'string' && data.userId === currentUser?.uid);
      } catch (error) {
        console.error('Could not load the post to edit:', error);
        if (!isCancelled) {
          setErrorMessage('Could not load this post. Please try again.');
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [currentUser, postId]);

  // The cleanup for an abandoned edit. A ref, not state, because it is read from an unmount
  // cleanup where setting state would be pointless, and an empty list costs nothing to keep.
  useEffect(() => {
    return () => {
      if (hasSaved.current) {
        return;
      }

      const paths = unsavedUploads.current;

      unsavedUploads.current = [];

      for (const path of paths) {
        void removePostMedia(path);
      }
    };
  }, []);

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace('/home');
  }, []);

  /**
   * Adds photos to the post.
   *
   * Each picked file is uploaded straight to storage and the returned url is appended to the list
   * on screen, rather than being held until Save. A photo that takes a moment to upload should show
   * up as it lands, and the file has to exist before the document can point at it either way. The
   * document itself is written once, by Save Changes, so the feed never sees a half edited post.
   */
  const addPhotos = useCallback(async () => {
    if (!isOwner || isPickingPhotos) {
      return;
    }

    if (!isSupabaseStorageConfigured()) {
      setErrorMessage(
        'Photos cannot be added yet: Supabase is not configured. Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to .env.local, then restart the dev server.',
      );
      return;
    }

    const room = MAX_MEDIA - mediaUrls.length;

    if (room <= 0) {
      Alert.alert('Photo limit reached', `A post can have up to ${MAX_MEDIA} photos.`);
      return;
    }

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      Alert.alert('Permission required', 'Allow access to your photos to add them to this post.');
      return;
    }

    setIsPickingPhotos(true);
    setErrorMessage('');

    // Declared out here so the catch below can still reach the paths of a partially completed add.
    const paths: string[] = [];

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: false,
        // A picker that hands back the original rather than a re-encoded copy, for the same reason
        // the camera screen does: the file that gets stored is the file that was taken.
        mediaTypes: ['images'],
        // More than one at a time, but never past the ceiling, so the picker cannot return twenty
        // photos for a post that has room for two.
        selectionLimit: room,
      });

      if (result.canceled || !currentUser) {
        return;
      }

      const added: string[] = [];

      for (const asset of result.assets) {
        if (!asset.uri) {
          continue;
        }

        const uploaded = await uploadPostMedia(currentUser.uid, {
          contentType: IMAGE_CONTENT_TYPE,
          // The picker does not always give a name, and the helper sanitises whatever it gets, so
          // the extension is what matters rather than the original filename.
          fileName: asset.fileName ?? `edit_${Date.now()}.jpg`,
          uri: asset.uri,
        });

        added.push(uploaded.mediaUrl);
        paths.push(uploaded.mediaPath);
      }

      if (added.length === 0) {
        return;
      }

      // Tracked before the state update so a screen that unmounts between the two still cleans up.
      unsavedUploads.current = [...unsavedUploads.current, ...paths];
      setMediaUrls((current) => [...current, ...added].slice(0, MAX_MEDIA));
    } catch (error) {
      console.error('Could not add the photos:', error);
      setErrorMessage(getSupabaseUploadErrorMessage(error));

      // Anything that did upload before the failure is handed to the abandoned-edit cleanup, so a
      // partial add does not leave files in the bucket that no document points at.
      unsavedUploads.current = [...unsavedUploads.current, ...paths];
    } finally {
      setIsPickingPhotos(false);
    }
  }, [currentUser, isOwner, isPickingPhotos, mediaUrls.length]);

  /**
   * Removes one photo: the file goes first, then it leaves the list.
   *
   * Storage before the array on purpose. If the removal fails the photo stays in the list and the
   * document keeps pointing at a file that is still there, which is a post that renders. The other
   * order leaves the document pointing at a url that 404s, and there is no way back from that
   * without another edit.
   */
  const removePhoto = useCallback(
    async (url: string) => {
      if (!isOwner || isRemovingMedia) {
        return;
      }

      const path = storagePathFromUrl(url);

      if (!path) {
        setErrorMessage('Could not work out which file that photo is stored as.');
        return;
      }

      setIsRemovingMedia(true);
      setErrorMessage('');

      try {
        await removePostMedia(path);
      } finally {
        // The url leaves the list either way: the file is either gone or the user is being told it
        // could not be, and a thumbnail the user has just swiped away should not stay behind.
        setMediaUrls((current) => current.filter((item) => item !== url));
        setIsRemovingMedia(false);
      }
    },
    [isOwner, isRemovingMedia],
  );

  const onSave = useCallback(async () => {
    if (!postId || isSaving) {
      return;
    }

    if (!currentUser) {
      Alert.alert('Login required', 'You need to be logged in to edit a post.');
      return;
    }

    setIsSaving(true);
    setErrorMessage('');

    try {
      const postRef = doc(getFirebaseDb(), 'posts', postId);
      // Ownership is checked against the stored document rather than trusted from the route, so
      // a hand written link cannot edit somebody else's post.
      const snapshot = await getDoc(postRef);

      if (!snapshot.exists()) {
        Alert.alert('Nothing to save', 'This post has already been deleted.');
        setIsSaving(false);
        return;
      }

      if (snapshot.data().userId !== currentUser.uid) {
        Alert.alert('Not allowed', 'You can only edit a post you created.');
        setIsSaving(false);
        return;
      }

      // The audience is rebuilt on every save, not only when the visibility changed. It is a
      // snapshot of the author's follow list, so re-saving a restricted post is also the only way to
      // pick up follows made since it was published. The author is the one whose list is read, and
      // the ownership check above has already established that they are.
      const audience = await buildAudience(currentUser.uid, visibility);

      await updateDoc(postRef, {
        description,
        // The cover follows the list, because the feed draws `mediaUrl` and would otherwise show a
        // photo the owner has just removed. An empty list writes an empty cover, which is what a
        // post with no photos looks like everywhere else in the app.
        mediaUrl: mediaUrls[0] ?? '',
        mediaUrls,
        visibleToUids: audience,
        visibility,
        title: title.trim(),
      });
    } catch (error) {
      console.error('Could not save the post:', error);
      Alert.alert('Could not save', 'Please check your connection and try again.');
      setIsSaving(false);
      return;
    }

    // The document owns these files now, so the abandoned-edit cleanup must leave them alone.
    hasSaved.current = true;
    unsavedUploads.current = [];
    setIsSaving(false);
    // The feed listens to the posts collection, so the new text is already on screen by the time
    // this screen leaves.
    router.back();
  }, [currentUser, description, isSaving, mediaUrls, postId, visibility, title]);

  if (isLoading) {
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={SAVE_RED} />
        </View>
      </SafeAreaView>
    );
  }

  const canEdit = isOwner && !isSaving;

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
      <StatusBar style="dark" />

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

        <Text style={styles.headerTitle}>Edit post</Text>
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
          {errorMessage ? (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>{errorMessage}</Text>
            </View>
          ) : null}

          {/* The photos on the post, end to end, with the add button last. Horizontal rather than
              a grid because the order matters: the first one is the cover the feed shows. */}
          <ScrollView
            contentContainerStyle={styles.mediaStrip}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.mediaStripScroll}
          >
            {mediaUrls.map((url) => (
              <View key={url} style={styles.thumbnailWrap}>
                <Image source={{ uri: url }} style={styles.thumbnail} />

                {/* The X sits on the corner of the photo, the way a photo picker marks what it
                    will remove, so it never covers the middle of the image. */}
                <Pressable
                  accessibilityLabel="Remove this photo"
                  accessibilityRole="button"
                  disabled={!canEdit}
                  hitSlop={6}
                  onPress={() => void removePhoto(url)}
                  style={({ pressed }) => [styles.removeMedia, pressed && styles.pressed]}
                >
                  <Ionicons color="#FFFFFF" name="close" size={13} />
                </Pressable>
              </View>
            ))}

            <Pressable
              accessibilityLabel={`Add a photo, ${MAX_MEDIA - mediaUrls.length} left`}
              accessibilityRole="button"
              disabled={!canEdit || isPickingPhotos || mediaUrls.length >= MAX_MEDIA}
              onPress={() => void addPhotos()}
              style={({ pressed }) => [
                styles.addMedia,
                pressed && styles.pressed,
                (!canEdit || mediaUrls.length >= MAX_MEDIA) && styles.disabled,
              ]}
            >
              {isPickingPhotos ? (
                <ActivityIndicator color={SAVE_RED} />
              ) : (
                <Ionicons color={SAVE_RED} name="add" size={26} />
              )}
            </Pressable>
          </ScrollView>

          <Text style={styles.fieldLabel}>Title</Text>
          <TextInput
            editable={canEdit}
            maxLength={TITLE_MAX_LENGTH}
            onChangeText={setTitle}
            onSubmitEditing={() => descriptionRef.current?.focus()}
            placeholder="Add a catchy title"
            placeholderTextColor={MUTED}
            returnKeyType="next"
            style={styles.titleInput}
            value={title}
          />

          <Text style={styles.fieldLabel}>Description</Text>
          <TextInput
            editable={canEdit}
            maxLength={DESCRIPTION_MAX_LENGTH}
            multiline
            onChangeText={setDescription}
            placeholder="Writing a long description..."
            placeholderTextColor={MUTED}
            ref={descriptionRef}
            style={styles.descriptionInput}
            textAlignVertical="top"
            value={description}
          />

          {/* The audience, on the same row pattern as the text fields above it. It reads back the
              selection rather than describing it, so the row is the answer without being opened. */}
          <Text style={styles.fieldLabel}>Visibility</Text>
          <Pressable
            accessibilityLabel={`Post visibility, currently ${selectedVisibility.label}`}
            accessibilityRole="button"
            disabled={!canEdit}
            onPress={() => setIsPickingVisibility(true)}
            style={({ pressed }) => [
              styles.visibilityRow,
              pressed && styles.visibilityRowPressed,
              !canEdit && styles.disabled,
            ]}
          >
            <Ionicons color="#111111" name="people-outline" size={20} />
            <Text style={styles.visibilityLabel}>{selectedVisibility.label}</Text>
            <Ionicons color="#C7C7CC" name="chevron-forward" size={18} />
          </Pressable>
        </ScrollView>

        {/* The button sits on the divider rather than floating over the fields. */}
        <View style={styles.actions}>
          <Pressable
            accessibilityLabel="Save changes"
            accessibilityRole="button"
            disabled={!canEdit}
            onPress={() => void onSave()}
            style={({ pressed }) => [
              styles.saveButton,
              pressed && styles.pressed,
              !canEdit && styles.disabled,
            ]}
          >
            {isSaving ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.saveLabel}>Save Changes</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      {/* Who can see this post. A sheet over the screen rather than a new one, so the post being
          edited stays visible. No blur: a solid white surface over a dimmed backdrop, the same
          treatment the post details screen uses for the same choice. */}
      <Modal
        animationType="slide"
        onRequestClose={() => setIsPickingVisibility(false)}
        transparent
        visible={isPickingVisibility}
      >
        <View style={styles.sheetRoot}>
          <Pressable
            accessibilityLabel="Close audience options"
            onPress={() => setIsPickingVisibility(false)}
            style={styles.sheetBackdrop}
          />

          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />

            <Text style={styles.sheetTitle}>Who can view this post</Text>

            {VISIBILITY_OPTIONS.map((option) => {
              const isSelected = option.id === visibility;

              return (
                <Pressable
                  key={option.id}
                  accessibilityLabel={`${option.label}, ${option.description}`}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: isSelected, selected: isSelected }}
                  onPress={() => {
                    setPostVisibility(option.id);
                    setIsPickingVisibility(false);
                  }}
                  style={({ pressed }) => [styles.sheetRow, pressed && styles.sheetRowPressed]}
                >
                  <View style={styles.sheetText}>
                    <Text style={styles.sheetLabel}>{option.label}</Text>
                    <Text style={styles.sheetDescription}>{option.description}</Text>
                  </View>

                  {/* The tick is the selected marker. The row is not tinted, so the choice reads
                      the same whichever screen it was set from. */}
                  {isSelected ? (
                    <Ionicons color={SAVE_RED} name="checkmark-circle" size={22} />
                  ) : (
                    <Ionicons color="#D1D1D6" name="ellipse-outline" size={22} />
                  )}
                </Pressable>
              );
            })}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#FFFFFF',
    flex: 1,
  },
  flex: { flex: 1 },
  loadingContainer: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  headerButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
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
  notice: {
    backgroundColor: '#FFF1F0',
    borderRadius: 10,
    marginBottom: 14,
    padding: 12,
  },
  noticeText: {
    color: '#C0392B',
    fontSize: 13,
    lineHeight: 18,
  },
  // The strip scrolls horizontally, so it is allowed to run to the screen edges and the content
  // padding is done on the strip itself. A nested vertical scroll would fight the form's own.
  mediaStripScroll: {
    marginHorizontal: -16,
  },
  mediaStrip: {
    gap: 10,
    // The negative margins above are undone here, which is what keeps the first thumbnail and the
    // add button clear of the screen edge.
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  thumbnailWrap: {
    borderRadius: 10,
  },
  thumbnail: {
    backgroundColor: '#F2F2F4',
    borderRadius: 10,
    height: 84,
    width: 84,
  },
  removeMedia: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    borderColor: '#FFFFFF',
    borderRadius: 11,
    borderWidth: 1.5,
    height: 22,
    justifyContent: 'center',
    position: 'absolute',
    right: -6,
    top: -6,
    width: 22,
  },
  addMedia: {
    alignItems: 'center',
    borderColor: '#E0E0E2',
    borderRadius: 10,
    borderStyle: 'dashed',
    borderWidth: 1.5,
    height: 84,
    justifyContent: 'center',
    width: 84,
  },
  fieldLabel: {
    color: '#111111',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6,
    marginTop: 16,
  },
  titleInput: {
    borderBottomColor: DIVIDER,
    borderBottomWidth: StyleSheet.hairlineWidth,
    color: '#111111',
    fontSize: 17,
    fontWeight: '700',
    minHeight: 48,
    paddingHorizontal: 0,
    paddingVertical: 10,
  },
  descriptionInput: {
    borderBottomColor: DIVIDER,
    borderBottomWidth: StyleSheet.hairlineWidth,
    color: '#111111',
    fontSize: 15,
    lineHeight: 21,
    minHeight: 120,
    paddingHorizontal: 0,
    paddingTop: 10,
  },
  visibilityRow: {
    alignItems: 'center',
    borderBottomColor: DIVIDER,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 0,
  },
  visibilityRowPressed: {
    backgroundColor: '#F7F7F8',
  },
  visibilityLabel: {
    color: '#111111',
    flex: 1,
    fontSize: 15,
  },
  sheetRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetBackdrop: {
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    flex: 1,
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    overflow: 'hidden',
    paddingBottom: 28,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  sheetHandle: {
    alignSelf: 'center',
    backgroundColor: '#D1D1D6',
    borderRadius: 2,
    height: 4,
    marginBottom: 14,
    width: 40,
  },
  sheetTitle: {
    color: '#111111',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 6,
  },
  sheetRow: {
    alignItems: 'center',
    borderBottomColor: DIVIDER,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    minHeight: 60,
    paddingHorizontal: 4,
    paddingVertical: 10,
  },
  sheetRowPressed: {
    backgroundColor: '#F7F7F8',
  },
  // The label and its explanation share a column so the tick stays hard right whatever the length
  // of the text, and both wrap under themselves rather than pushing the tick off the sheet.
  sheetText: {
    flex: 1,
    gap: 2,
  },
  sheetLabel: {
    color: '#111111',
    fontSize: 15,
    fontWeight: '700',
  },
  sheetDescription: {
    color: MUTED,
    fontSize: 12,
    lineHeight: 16,
  },
  actions: {
    borderTopColor: DIVIDER,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  saveButton: {
    alignItems: 'center',
    backgroundColor: SAVE_RED,
    borderRadius: 12,
    height: 50,
    justifyContent: 'center',
  },
  saveLabel: {
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
