import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useVideoPlayer, VideoView } from 'expo-video';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// React Native's Image rather than expo-image: expo-image cannot open a local file:// uri on
// Android, and the cover is always one of those until the post is published.
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { toDisplaySource, useCapture } from '@/components/capture-provider';
import { MentionSheet, MentionUser } from '@/components/mention-sheet';
import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';
import { toMediaType, toParam, toSoundParam } from '@/lib/route-params';
import { DEFAULT_POST_VISIBILITY, PostVisibility, uploadPost } from '@/lib/upload-post';
import { getString } from '@/lib/user-data';

// The lighter grey the description sits in, kept separate from the border grey so the two do not
// drift into each other.
const MUTED = '#8E8E93';
const DIVIDER = '#EFEFF0';
const POST_RED = '#FE2C55';

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

// The audiences a post can be published to, in the order they are offered. The label is what the
// options row shows once one is chosen; the description is the plain english explanation inside the
// sheet, because "Followers and Friends" on its own says nothing about who is included.
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

// The rows under the editor, in the order they appear. Built inside the component because two of
// them are not fixed strings: the audience row reads back the selection, and the mention row reads
// back how many people are in the caption.
function useOptionRows(
  label: string,
  link: string,
  mentionCount: number,
  onOpenVisibility: () => void,
  onOpenLink: () => void,
  onOpenMentions: () => void,
  onShare: () => void,
  onPlaceholder: (title: string) => void,
) {
  return [
    {
      // The link row carries the url under its title rather than in place of it: "Add link" stays
      // the label the row is known by, and the address underneath is what has actually been
      // attached. Empty until there is one, in which case there is no second line at all.
      accessibilityLabel: link ? `Edit link, currently ${link}` : 'Add link',
      icon: 'link-outline',
      onPress: onOpenLink,
      subtitle: link,
      title: link ? 'Edit link' : 'Add link',
    },
    {
      accessibilityLabel: `Post visibility, currently ${label}`,
      icon: 'people-outline',
      onPress: onOpenVisibility,
      title: label,
    },
    {
      // The count, not a list of names: the names are in the caption where they were written, and a
      // row three lines deep is no longer a row.
      accessibilityLabel:
        mentionCount > 0 ? `Mention people, ${mentionCount} mentioned` : 'Mention people',
      icon: 'at-outline',
      onPress: onOpenMentions,
      subtitle: mentionCount > 0 ? `${mentionCount} mentioned` : '',
      title: '@Mention',
    },
    { icon: 'share-outline', onPress: onShare, title: 'Share to' },
  ] as const;
}

export default function PostDetailsScreen() {
  // The camera hands the shot over as a route param. `uri` is read as well so a link or a
  // hand written url addressing this screen the old way still resolves. Only the media comes
  // this way: the title and the description are never passed as params because this screen is
  // the only place they are written, and base64 cannot ride in a URL either, so the file is read
  // from the uri at upload time.
  const params = useLocalSearchParams<{
    imageUri?: string | string[];
    mediaType?: string | string[];
    sound?: string | string[];
    uri?: string | string[];
  }>();

  const imageUri = toParam(params.imageUri) || toParam(params.uri);
  const mediaType = toMediaType(params.mediaType, imageUri);
  // Parsed once per param rather than on every render, so the song keeps one identity and the
  // upload callback is not rebuilt each time anything on screen changes.
  const sound = useMemo(() => toSoundParam(params.sound), [params.sound]);
  // What the Post button has to have: a file to upload.
  const canPost = Boolean(imageUri);
  // The captured photo's base64, preferred over the local file uri because it skips the file
  // system, which is where a path can stop resolving under the user. The original uri is the
  // fallback when there is no capture to read from.
  const { capture, clearCapture } = useCapture();
  // The bytes are only handed over when they are proven to belong to the photo being posted.
  // `imageUri` is frozen at navigation time while the capture context keeps changing, so a capture
  // can legitimately be present and still be a different, older photo: the user opened this screen,
  // went back, and took another shot before coming forward again. Empty string means "no matching
  // bytes", which sends the upload down the uri path rather than uploading the wrong picture.
  const matchedBase64 = capture && capture.uri === imageUri ? capture.base64 : '';
  const coverSource = useMemo(() => toDisplaySource(capture, imageUri), [capture, imageUri]);

  if (__DEV__ && capture?.base64 && capture.uri !== imageUri) {
    // Loud in development, silent in production: on a device this is the difference between a post
    // showing the photo just taken and one showing the photo before it, and it is invisible in the
    // UI because both are ordinary images that load fine.
    console.warn(
      `Held capture is for a different shot (capture ${capture.uri}, post ${imageUri}). Using the post's uri.`,
    );
  }

  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // The expand control only changes how much of the description is on screen, so the text itself
  // is never truncated on save.
  const [isExpanded, setIsExpanded] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  // Who can see the post. Public until chosen otherwise, which is the same audience a post had
  // before this existed, so nothing changes for anyone who ignores the row.
  const [visibility, setPostVisibility] = useState<PostVisibility>(DEFAULT_POST_VISIBILITY);
  const [isPickingVisibility, setIsPickingVisibility] = useState(false);
  const [isPickingMentions, setIsPickingMentions] = useState(false);
  // Everyone mentioned in the caption, by user id. The `@name` in the description is what the
  // reader sees; this is what the post is written with, so a mention can be turned into a
  // notification without parsing the caption back apart.
  const [mentionedUsers, setMentionedUsers] = useState<MentionUser[]>([]);
  // Attached by the Add link row. Empty until one is added, and an empty string is written to
  // Firestore rather than omitted, so the field can be asked about without a missing-key check.
  const [postLink, setPostLink] = useState('');
  const [isPickingLink, setIsPickingLink] = useState(false);
  // What the link sheet is editing. Held separately from postLink so cancelling throws the edit
  // away instead of leaving a half typed url on the post.
  const [linkDraft, setLinkDraft] = useState('');
  const descriptionRef = useRef<TextInput>(null);
  // Whether an upload is in flight, readable synchronously so the guard above holds within a tick.
  const isPostingRef = useRef(false);

  // The selected audience, read back rather than kept as a second piece of state. An id that is no
  // longer in the list falls back to the default, so an old document or a hand edited value cannot
  // leave the row blank.
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

  // The text one mention puts into the caption. Shared by the add and the remove path so the two
  // can never disagree about what was inserted, and it is the same shape comment-sheet writes for a
  // reply, so a mention reads identically wherever it appears.
  const toggleMention = useCallback(
    (user: MentionUser) => {
      const token = `@${user.name} `;
      const isMentioned = mentionedUsers.some((item) => item.id === user.id);

      // Two separate updates rather than one nested inside the other: a state updater that also set
      // another piece of state would run twice under StrictMode and insert the name twice.
      if (isMentioned) {
        // Deselecting takes the name back out, so the caption and the list cannot drift apart. Every
        // occurrence goes, not just the first, in case the same name was typed by hand as well.
        setDescription((text) => text.split(token).join(''));
        setMentionedUsers((current) => current.filter((item) => item.id !== user.id));
        return;
      }

      setDescription((text) => `${text}${text.endsWith(' ') || !text ? '' : ' '}${token}`);
      setMentionedUsers((current) => [...current, user]);
    },
    [mentionedUsers],
  );

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

  const openVisibility = useCallback(() => setIsPickingVisibility(true), []);

  const openMentions = useCallback(() => setIsPickingMentions(true), []);

  /**
   * Hands the post to the OS share sheet.
   *
   * There is no link in the message, which is the one thing worth flagging: this screen writes the
   * post, so the post does not exist yet, and there is no id to put in a permalink or a url to
   * hand over. The photo is a local cache path, which is meaningless to whoever receives it. So
   * what goes out is the writing, plus the image itself on the platform that can carry it. A
   * permalink drops in here once posts have addresses.
   */
  const onShare = useCallback(async () => {
    // react-native-web has no Share module at all, and a browser without the Web Share API cannot
    // open a sheet either. Checked before the call so the tap says something instead of throwing.
    if (Platform.OS === 'web') {
      Alert.alert('Sharing is not available here', 'Open the app on a phone to share a post.');
      return;
    }

    // The title alone reads as a headline, so it leads; the description is the body. A post with
    // neither still shares something rather than an empty sheet.
    const headline = title.trim() || description.trim() || 'A new post';
    const message = [headline, description.trim()].filter(Boolean).join('\n\n');

    try {
      const result = await Share.share(
        Platform.OS === 'ios' && mediaType === 'image' && imageUri
          ? // iOS carries `url` across as an attachment, so the photo goes as the image itself.
            // Android has no equivalent for a local file, and putting the cache path in the message
            // would only send something the recipient cannot open.
            { message, url: imageUri }
          : { message },
      );

      // Dismissing the sheet is a normal outcome, not a failure, so nothing is reported. There is
      // also no share counter to bump here: that lives on the post document, and this post has not
      // been written yet.
      if (result.action === Share.dismissedAction) {
        return;
      }
    } catch (error) {
      console.error('Could not share the post:', error);
      Alert.alert('Could not share', 'The share sheet could not be opened. Please try again.');
    }
  }, [description, imageUri, mediaType, title]);

  // Opening the link sheet seeds the draft with whatever is already attached, so editing a link
  // starts from the current one rather than from an empty field.
  const openLink = useCallback(() => {
    setLinkDraft(postLink);
    setIsPickingLink(true);
  }, [postLink]);

  // Only a value that looks like a link is kept. Anything else is dropped with a message rather
  // than written to the post, because a post carrying "hello" as its url is worse than one with no
  // link at all.
  const commitLink = useCallback(() => {
    const trimmed = linkDraft.trim();

    if (!trimmed) {
      setPostLink('');
      setIsPickingLink(false);
      return;
    }

    if (!/^https?:\/\/\S+$/i.test(trimmed)) {
      Alert.alert('Not a valid link', 'Enter a web address starting with http:// or https://.');
      return;
    }

    setPostLink(trimmed);
    setIsPickingLink(false);
  }, [linkDraft]);

  const optionRows = useOptionRows(
    selectedVisibility.label,
    postLink,
    mentionedUsers.length,
    openVisibility,
    openLink,
    openMentions,
    () => void onShare(),
    notWired,
  );

  const onPost = useCallback(async () => {
    console.log('Post button pressed');

    // Checked before anything else and set synchronously, before the first await. `isUploading`
    // alone cannot do this job: a second tap can land before the render that reflects it, which
    // is enough to publish the same post twice.
    if (isPostingRef.current) {
      return;
    }

    if (!currentUser) {
      Alert.alert('Login required', 'You need to be logged in to post.');
      return;
    }

    if (!canPost) {
      Alert.alert('Nothing to post', 'This screen needs a photo or a clip.');
      return;
    }

    isPostingRef.current = true;
    setIsUploading(true);

    try {
      // Uploads the file to Supabase storage and writes the title, the description, the media url,
      // the song name and the audience to the posts collection in Firestore.
      await uploadPost({
        // The feed reads the description as the caption and draws the title on its own line above
        // it, so the title is deliberately not folded into this.
        caption: description.trim(),
        description,
        displayName: displayName || currentUser.displayName || 'User',
        mediaType,
        // Written alongside the `@name` already in the caption: the text is what the reader sees,
        // and these ids are what a notification would be addressed to.
        mentionedUserIds: mentionedUsers.map((user) => user.id),
        // Written with the post rather than left to the reader's guesswork, so a restricted post
        // is identifiable from the document alone.
        postLink,
        visibility,
        // The attribution fields come along because a CC BY track has to name the artist and the
        // licence.
        ...(sound ? { sound } : {}),
        title,
        // The uri the camera handed over, unmodified. Photos additionally carry their base64, so
        // the upload skips a second read of the cache path.
        uri: imageUri,
        ...(mediaType === 'image' && matchedBase64 ? { base64: matchedBase64 } : {}),
        userId: currentUser.uid,
      });
    } catch (error) {
      // uploadPost has already turned the failure into the sentence to show. Its describeError
      // covers the cases worth naming: an unconfigured or unreachable Supabase, a bucket that does
      // not exist, a rejected token, and storage policies blocking the insert.
      Alert.alert('Could not post', error instanceof Error ? error.message : 'Please try again in a moment.');
      return;
    } finally {
      // Cleared on every path out of the try, including the failure above. A spinner left running
      // is the one failure this screen cannot hide: it looks identical to a tap that did nothing.
      isPostingRef.current = false;
      setIsUploading(false);
    }

    // The capture is a photo held as a string in memory, so it is released once the post it
    // belonged to is written and the file on disk has been uploaded. Replaced rather than pushed
    // back, so the caption screen does not sit under the feed holding a post that is already live.
    clearCapture();
    router.replace('/home');
  }, [canPost, clearCapture, currentUser, description, displayName, imageUri, matchedBase64, mediaType, mentionedUsers, postLink, visibility, sound, title]);

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
      <StatusBar style="dark" />

      {/* Back on the left, the action on the right, as the reference layout has it.

          The right hand control is the publish button, and it is a real button. It used to be a
          static `Post` label sitting in the header's space-between far right, where it read as the
          submit button and swallowed every tap on it: pressing it did nothing at all, because a
          Text has no press handler. It is now the same action as the one in the bottom bar, sharing
          onPost so the two cannot disagree about what it does. */}
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

        <Pressable
          accessibilityLabel="Post"
          accessibilityRole="button"
          accessibilityState={{ busy: isUploading }}
          // Only an upload in flight disables this. `!canPost` deliberately does not: a disabled
          // control says nothing when tapped, which is the exact failure this screen just had. The
          // button stays live and onPost explains what is missing instead.
          disabled={isUploading}
          hitSlop={8}
          onPress={() => void onPost()}
          style={({ pressed }) => [
            styles.headerPost,
            isUploading && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          {isUploading ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Text style={styles.headerPostLabel}>Post</Text>
          )}
        </Pressable>
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
          {/* The captured shot as a small cover on the left, the title beside it. */}
          <View style={styles.previewRow}>
            <View style={styles.coverWrap}>
              {mediaType === 'video' && imageUri ? (
                <VideoCover uri={imageUri} />
              ) : imageUri ? (
                <Image
                  onError={(event) => {
                    // The uri reached this screen but could not be opened, which is a different
                    // fault from never arriving. Logging it keeps the two apart in the console.
                    console.warn('Cover preview could not load:', event.nativeEvent?.error, imageUri);
                  }}
                  resizeMode="cover"
                  source={coverSource}
                  style={styles.cover}
                />
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

          {sound ? (
            <View style={styles.soundRow}>
              <Ionicons color="#111111" name="musical-note" size={15} />
              <Text numberOfLines={1} style={styles.soundText}>
                {sound.title}
              </Text>
            </View>
          ) : null}

          <TextInput
            editable={!isUploading}
            maxLength={220}
            multiline
            numberOfLines={isExpanded ? 10 : 4}
            onChangeText={setDescription}
            placeholder="Writing a long description..."
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
              // Opens the picker rather than dropping a bare @ into the field. A lone @ gives the
              // writer nothing to pick from, and they would have to know the exact name to type
              // after it; the sheet searches the people who actually exist.
              onPress={openMentions}
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

          {/* The audience row keeps its old second slot, between Add link and @Mention, and
              reads back the selection rather than a fixed sentence. */}
          {optionRows.map((option) => (
            <Pressable
              key={option.title}
              accessibilityLabel={'accessibilityLabel' in option ? option.accessibilityLabel : option.title}
              accessibilityRole="button"
              disabled={isUploading}
              onPress={option.onPress}
              style={({ pressed }) => [styles.optionRow, pressed && styles.optionRowPressed]}
            >
              <Ionicons color="#111111" name={option.icon} size={22} />

              {/* Title and, for the link row, the address under it. The column takes the slack so
                  the chevron stays hard right however long the url is; the url itself is one line
                  and ellipsises, because a full query string is not something to read in a row. */}
              <View style={styles.optionText}>
                <Text style={styles.optionTitle}>{option.title}</Text>
                {'subtitle' in option && option.subtitle ? (
                  <Text numberOfLines={1} style={styles.optionSubtitle}>
                    {option.subtitle}
                  </Text>
                ) : null}
              </View>

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
            accessibilityState={{ busy: isUploading }}
            // Same reasoning as the header button: only an upload in flight turns this inert, so a
            // tap with nothing to post gets an explanation from onPost rather than silence. It still
            // looks dimmed, so the two agree on readiness without agreeing to be mute.
            disabled={isUploading}
            onPress={() => void onPost()}
            style={({ pressed }) => [
              styles.actionButton,
              styles.postButton,
              pressed && styles.pressed,
              (isUploading || !canPost) && styles.disabled,
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

      {/* Who can see this post. A sheet over the screen rather than a new one, so the caption being
          posted stays visible while the audience is chosen. No blur: the sheet is a solid white
          surface over a dimmed backdrop, which is the same treatment the camera's filter and music
          sheets use, and it costs no extra native view. */}
      <Modal
        animationType="slide"
        onRequestClose={() => setIsPickingVisibility(false)}
        transparent
        visible={isPickingVisibility}
      >
        <View style={styles.visibilityRoot}>
          {/* Tapping the caption behind dismisses without changing anything. */}
          <Pressable
            accessibilityLabel="Close audience options"
            onPress={() => setIsPickingVisibility(false)}
            style={styles.visibilityBackdrop}
          />

          <View style={styles.visibilitySheet}>
            <View style={styles.visibilityHandle} />

            <Text style={styles.visibilityTitle}>Who can view this post</Text>

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
                  style={({ pressed }) => [
                    styles.visibilityRow,
                    pressed && styles.visibilityRowPressed,
                  ]}
                >
                  <View style={styles.visibilityText}>
                    <Text style={styles.visibilityLabel}>{option.label}</Text>
                    <Text style={styles.visibilityDescription}>{option.description}</Text>
                  </View>

                  {/* The tick is the selected marker. The row is not tinted, so the choice reads the
                      same whether the sheet is over a light photo or a dark one. */}
                  {isSelected ? (
                    <Ionicons color={POST_RED} name="checkmark-circle" size={22} />
                  ) : (
                    <Ionicons color="#D1D1D6" name="ellipse-outline" size={22} />
                  )}
                </Pressable>
              );
            })}
          </View>
        </View>
      </Modal>

      {/* The link attached to the post. Same sheet as the audience so the two read as one surface,
          and the same solid fill: no blur anywhere on this screen. */}
      <Modal
        animationType="slide"
        onRequestClose={() => setIsPickingLink(false)}
        transparent
        visible={isPickingLink}
      >
        <View style={styles.visibilityRoot}>
          <Pressable
            accessibilityLabel="Close link editor"
            onPress={() => setIsPickingLink(false)}
            style={styles.visibilityBackdrop}
          />

          {/* The same treatment the screen below the sheet uses. A sheet is anchored to the bottom
              of the window, so without this the keyboard covers the field and both buttons on a
              short screen, which is the whole interaction: there is nothing to look at up there. */}
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.visibilitySheet}>
              <View style={styles.visibilityHandle} />

              <Text style={styles.visibilityTitle}>Add a link</Text>

              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                // A url keyboard, and no spell checker underlining half a domain name.
                autoComplete="url"
                editable={!isUploading}
                keyboardType="url"
                onChangeText={setLinkDraft}
                onSubmitEditing={commitLink}
                placeholder="https://"
                placeholderTextColor={MUTED}
                returnKeyType="done"
                style={styles.linkInput}
                value={linkDraft}
              />

              <View style={styles.linkActions}>
                <Pressable
                  accessibilityLabel="Remove link"
                  accessibilityRole="button"
                  disabled={!postLink}
                  onPress={() => {
                    setLinkDraft('');
                    setPostLink('');
                    setIsPickingLink(false);
                  }}
                  style={({ pressed }) => [styles.linkAction, pressed && styles.pressed, !postLink && styles.disabled]}
                >
                  <Text style={styles.linkActionText}>Remove</Text>
                </Pressable>

                <Pressable
                  accessibilityLabel="Save link"
                  accessibilityRole="button"
                  onPress={commitLink}
                  style={({ pressed }) => [styles.linkAction, styles.linkActionPrimary, pressed && styles.pressed]}
                >
                  <Text style={styles.linkActionPrimaryText}>Save</Text>
                </Pressable>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>

      <MentionSheet
        currentUserId={currentUser?.uid ?? ''}
        onClose={() => setIsPickingMentions(false)}
        onToggle={toggleMention}
        selectedIds={mentionedUsers.map((user) => user.id)}
        visible={isPickingMentions}
      />
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
  // The publish action in the header's far right. A filled pill rather than bare text, because a
  // plain label in that position is indistinguishable from a title and cannot tell a tap apart from
  // a dead space.
  headerPost: {
    alignItems: 'center',
    backgroundColor: POST_RED,
    borderRadius: 999,
    justifyContent: 'center',
    minWidth: 68,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  headerPostLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
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
  // The song chosen on the camera screen, echoed here so it is clear what is being posted with.
  soundRow: {
    alignItems: 'center',
    borderBottomColor: DIVIDER,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 7,
    marginTop: 12,
    paddingBottom: 10,
  },
  soundText: {
    color: '#111111',
    flexShrink: 1,
    fontSize: 13,
    fontWeight: '600',
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
    fontSize: 15,
  },
  // The title and the url share this column so the chevron stays hard right whatever the address
  // length. The title keeps its own flex so the row height still comes from the 56dp minimum
  // rather than from the two lines of text.
  optionText: {
    flex: 1,
    gap: 2,
  },
  optionSubtitle: {
    color: MUTED,
    fontSize: 12,
    lineHeight: 16,
  },
  visibilityRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  visibilityBackdrop: {
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    flex: 1,
  },
  visibilitySheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    overflow: 'hidden',
    paddingBottom: 28,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  visibilityHandle: {
    alignSelf: 'center',
    backgroundColor: '#D1D1D6',
    borderRadius: 2,
    height: 4,
    marginBottom: 14,
    width: 40,
  },
  visibilityTitle: {
    color: '#111111',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 6,
  },
  visibilityRow: {
    alignItems: 'center',
    borderBottomColor: DIVIDER,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    minHeight: 60,
    paddingHorizontal: 4,
    paddingVertical: 10,
  },
  visibilityRowPressed: {
    backgroundColor: '#F7F7F8',
  },
  // The label and its explanation share a column so the tick stays hard right whatever the length
  // of the text, and both wrap under themselves rather than pushing the tick off the sheet.
  visibilityText: {
    flex: 1,
    gap: 2,
  },
  visibilityLabel: {
    color: '#111111',
    fontSize: 15,
    fontWeight: '700',
  },
  visibilityDescription: {
    color: MUTED,
    fontSize: 12,
    lineHeight: 16,
  },
  linkInput: {
    backgroundColor: '#F2F2F4',
    borderRadius: 10,
    color: '#111111',
    fontSize: 15,
    marginTop: 12,
    minHeight: 46,
    paddingHorizontal: 14,
  },
  linkActions: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'flex-end',
    marginTop: 14,
  },
  linkAction: {
    alignItems: 'center',
    borderRadius: 10,
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 18,
  },
  linkActionText: {
    color: MUTED,
    fontSize: 15,
    fontWeight: '700',
  },
  linkActionPrimary: {
    backgroundColor: POST_RED,
  },
  linkActionPrimaryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
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
