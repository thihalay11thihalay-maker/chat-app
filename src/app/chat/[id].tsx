import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import { router, useLocalSearchParams } from 'expo-router';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChatMessage, MessageBubble } from '@/components/chat-message-bubble';
import { GifPicker } from '@/components/gif-picker';
import { MediaViewer } from '@/components/media-viewer';
import { PersonAvatar } from '@/components/person-avatar';
import { useChatMedia } from '@/hooks/use-chat-media';

import { getFirebaseAuth, getFirebaseDb, isRealtimeDatabaseConfigured } from '@/lib/firebase';
import { CallType } from '@/lib/agora-call';
import { useFeatureFlag } from '@/lib/feature-flags';
import {
  canPostToRoom,
  isGroupRoom,
  readParticipantIds,
  readPerson,
  readRoomAbout,
  readRoomAdminIds,
  readRoomAvatarUrl,
  readRoomKind,
  readRoomName,
  readRoomOwnerId,
  readRoomPrivacy,
  recordMessagePreview,
  RoomKind,
  RoomPrivacy,
} from '@/lib/chat-rooms';
import {
  AlbumItem,
  deleteChatMessage,
  describeMessage,
  describeSendFailure,
  editMessageText,
  HEART_EMOJI,
  isExpired,
  loadMessageReactions,
  REACTION_EMOJI,
  ReactionEntry,
  sendTextMessage,
  setMessagePinned,
  summarizeMessage,
  tallyReactions,
  toggleMessageReaction,
} from '@/lib/chat-messages';
import { ChatSettings, DEFAULT_CHAT_SETTINGS, describeDisappearing, loadChatSettings } from '@/lib/chat-settings';
import { cacheMedia, cachedMediaUri, saveMediaToPhone } from '@/lib/media-cache';
import { findMockChat } from '@/lib/mock-chats';
import { subscribeToPresence } from '@/lib/presence';
import {
  detectTranslationLanguage,
  languageLabel,
  translateMessageText,
  TranslationLanguage,
  TRANSLATION_LANGUAGES,
} from '@/lib/translate';
import { startTyping, subscribeToTyping } from '@/lib/typing';

/**
 * One button on the bar that comes up over a long-pressed message.
 *
 * An icon as well as a label, because the bar is a row of six or seven across the width of a phone and
 * the labels alone would either truncate or need a row each. The label is still there, under the icon,
 * because an icon on its own is a guess and "Delete" next to "Reply" is not.
 */
type MessageAction = {
  destructive?: boolean;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
};

/** What the Translate row has produced, and what it was asked for. */
type ShownTranslation = {
  language: TranslationLanguage;
  original: string;
  text: string;
};

/** Which reaction on which message somebody is holding to see who chose it. */
type ReactionPeek = {
  emoji: string;
  messageId: string;
};

/** What the save button on a photograph or a clip is doing about that particular file. */
type SaveState = 'saving' | 'saved';

export default function ChatDetailScreen() {
  // `otherUserId` comes from the chat list, which already read the profile to draw the row. It is
  // used here to put the person's name in the title without a second read; the screen falls back to
  // the chat id when the screen was opened without it. `name` is the row's own name, which is the
  // only title a group has: it has no single other person to be named after.
  const { id, name, otherUserId } = useLocalSearchParams<{
    id: string;
    name?: string;
    otherUserId?: string;
  }>();
  const chatId = Array.isArray(id) ? id[0] : id || 'chat';
  const roomName = Array.isArray(name) ? name[0] : name;
  // A mock inbox row pushes its own id here. Firestore has no such chat, and the security
  // rules would refuse the read, so those ids are answered from the mock list instead and the
  // listener below is never started for them.
  const mockChat = findMockChat(chatId);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [otherName, setOtherName] = useState('');
  // The other person's picture, read alongside their name. The header shows this in place of the room's
  // own picture for a one-to-one, which is what makes a conversation look like a conversation with
  // somebody rather than like a titled box.
  const [otherPhotoUrl, setOtherPhotoUrl] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>(mockChat?.messages ?? []);
  const [messageText, setMessageText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [loadError, setLoadError] = useState('');
  // Everybody in the room. The chat list passes one id, and only for a one-to-one chat, so this is
  // read here: a group has several people to mark unread and no single "other" to take from the list.
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  // What the room calls itself, read from its own document rather than from the row that opened it, so
  // a rename in the profile screen shows up here and a room opened from a link is still titled.
  const [roomTitle, setRoomTitle] = useState('');
  const [roomAbout, setRoomAbout] = useState('');
  const [roomAvatarUrl, setRoomAvatarUrl] = useState('');
  const [roomKind, setRoomKind] = useState<RoomKind>('direct');
  const [roomPrivacy, setRoomPrivacy] = useState<RoomPrivacy>('public');
  const [roomOwnerId, setRoomOwnerId] = useState('');
  const [roomAdminIds, setRoomAdminIds] = useState<string[]>([]);

  // This account's own id, held early because who the *other* person is depends on it.
  const readerId = currentUser?.uid;

  /**
   * The one other person in a one-to-one, worked out rather than trusted from the route.
   *
   * The inbox passes `otherUserId`, but three of the five ways into this screen do not: starting a
   * conversation from Find Friends, joining a room with a link, and returning here from the search
   * screen. All three arrived with the title blank, no presence and no picture, and a one-to-one whose
   * title comes from its own document -- which has none -- fell all the way through to "Group chat".
   *
   * So the room's own participant list is the authority. It is the thing that cannot be wrong, because
   * it is what the rules check every read and write of this room against, and it is read here whatever
   * route was taken.
   *
   * A group is left empty on purpose: several people cannot be named by one id, and the header titles
   * those rooms from the room document instead. Waiting for `readerId` matters here rather than being
   * tidiness -- before auth resolves every participant differs from an empty string, so picking "the
   * first one who is not me" would pick this account's own row and answer with the reader's face.
   */
  const otherUid = useMemo(() => {
    const fromRoute = Array.isArray(otherUserId) ? otherUserId[0] : otherUserId;

    if (fromRoute || mockChat) {
      return fromRoute ?? '';
    }

    if (roomKind !== 'direct' || !readerId) {
      return '';
    }

    return participantIds.find((participantId) => participantId !== readerId) ?? '';
  }, [mockChat, otherUserId, participantIds, readerId, roomKind]);
  const flatListRef = useRef<FlatList<ChatMessage>>(null);

  // Whether this account may post into this room. The rules are the authority and would refuse a message
  // from somebody who may not, so this is about not offering a composer that cannot succeed. In a
  // channel that is everybody but the owner, and it is the only thing that makes a channel one way.
  const mayPost = canPostToRoom(roomKind, roomOwnerId, roomAdminIds, currentUser?.uid ?? '');

  // Somebody who may remove anybody's message and pin anything in the room, which decides what the
  // long-press sheet offers rather than what the rules will accept.
  const managesRoom = currentUser?.uid !== undefined
    && currentUser.uid !== ''
    && (currentUser.uid === roomOwnerId || roomAdminIds.includes(currentUser.uid));

  // The message being answered, shown above the composer and carried into the next send.
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  // The message being rewritten. While this is set the composer edits rather than sends, which is why it
  // has to be cleared whenever the conversation changes underneath.
  const [editTarget, setEditTarget] = useState<ChatMessage | null>(null);
  // The message the long-press sheet is open for, and the one the emoji picker is open for. Two rather
  // than one because they are different menus and only one of them is ever wanted at a time.
  const [reactionTarget, setReactionTarget] = useState<ChatMessage | null>(null);
  // Whether the searchable gif picker is up. Held separately from the attachment menu because the picker
  // opens after that sheet closes: the two are a detour on the way to sending, and stacking one on the
  // other would ask for two dismissals for one choice.
  const [isGifPickerVisible, setIsGifPickerVisible] = useState(false);
  // What can be done to the long-pressed message, held here rather than handed to a system dialog: the
  // list is longer than Android's alert has room for, and an alert that dropped its own way out could not
  // be dismissed at all.
  const [messageActions, setMessageActions] = useState<{ actions: MessageAction[]; title: string } | null>(null);
  // Which message is being acted on, so the six reactions come up over that message rather than over
  // whichever row happens to be drawn where the screen happens to be. Cleared by everything that closes
  // the bar, because a strip left behind over a message nobody is holding is a strip in the way of reading.
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  // The local copy of each message's media, by message id, once the background download has finished.
  // Held here rather than read from the filesystem on every render because a bubble has to be told which
  // file to draw, and asking the disk sixty times a second to find out would be absurd.
  const [cachedUrls, setCachedUrls] = useState<Record<string, string>>({});
  // Which album the viewer is showing, which of its photographs it was opened on, and the message it came
  // from. Null rather than a boolean because the viewer needs to know where to start: opening the fourth
  // photograph of ten has to land on the fourth, not on the first, or the tap that opened it appears to do
  // nothing.
  //
  // The whole list is held here rather than looked up from the message by id, because the bubble that was
  // tapped has already been passed and re-passed through the row renderer; holding the items means a
  // conversation that moves on underneath the viewer cannot change what is being looked at.
  //
  // The message id travels with it because the viewer names its cached copies after it, and a shared
  // placeholder here would have two different albums writing over each other's files in the cache.
  const [openAlbum, setOpenAlbum] = useState<{ items: AlbumItem[]; messageId: string; startIndex: number } | null>(null);
  // Which media is on its way to the gallery and which has arrived. Keyed by message id rather than a
  // single flag, because two photographs saved in a row must not turn one button into another.
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  // Who reacted to something, asked by holding a reaction rather than by tapping it: tapping it is how you
  // take your own reaction back, and a screen that opened a list on the same tap would fight the reader.
  const [reactionPeek, setReactionPeek] = useState<ReactionPeek | null>(null);
  // The message the Translate button was pressed on, which is what the language sheet is choosing a
  // language *for*, and the translation once it has come back. Two rather than one state because the
  // sheet and the answer are different moments: between them there is a request in flight.
  // The message the Translate button was pressed on, which is what the language sheet is choosing a
  // language *for*, and the translation once it has come back. Two rather than one state because the
  // sheet and the answer are different moments: between them there is a request in flight.
  const [translateTarget, setTranslateTarget] = useState<ChatMessage | null>(null);
  const [translation, setTranslation] = useState<ShownTranslation | null>(null);
  const [isTranslating, setIsTranslating] = useState(false);
  // Reactions, keyed by message id. Read once for what is on screen and then refreshed for the message
  // somebody is reacting to, which is why this is a map rather than a field on the message list.
  const [reactions, setReactions] = useState<Record<string, ReactionEntry[]>>({});
  // The set of message ids the reactions currently in state were read for, so an unchanged snapshot does
  // not read them again. A ref rather than state because it is bookkeeping for the listener below and
  // nothing renders it.
  const lastReactionKeyRef = useRef('');
  // How much room the system navigation bar takes at the bottom. Read once here and given to every sheet
  // in this screen, because a sheet that guesses is a sheet whose last row sits under the bar.
  const insets = useSafeAreaInsets();
  // Writing to the gallery, and nothing else. Asked for when somebody presses Save rather than at launch,
  // and write-only, because this app never needs to read the reader's photographs -- it only puts its own
  // messages there.
  const [, requestSavePermission] = MediaLibrary.usePermissions({
    writeOnly: true,
    granularPermissions: ['photo', 'video'],
  });
  // Android asks for nothing to write into the gallery, and iOS asks for the one thing below. Naming the
  // platform here keeps that difference in one place rather than in the middle of the save.
  const isAndroid = Platform.OS === 'android';
  // This account's own settings for this room: muted, and how long messages last.
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_CHAT_SETTINGS);
  // Whether the call buttons are shown at all. Off until an Agora App Certificate is configured.
  const chatCallsEnabled = useFeatureFlag('chatCalls');
  // Names for the sender labels in a group, resolved once from the profiles the room already knows about.
  const [senderNames, setSenderNames] = useState<Record<string, string>>({});

  /**
   * Keeps the chat room document in step with the last message in it.
   *
   * The inbox reads `lastMessage` for the preview, `lastMessageSenderId` for who sent it, and
   * `lastMessageTime` for both the relative timestamp and the order of the list. None of those move
   * on their own when a message is added to the messages subcollection, so without this every room
   * would sit at "Say hello" forever and the list would never reorder.
   *
   * Declared above the media hook that calls it: the callback below is passed during the first
   * render, and a hook that referenced this before it existed would read it in its temporal dead
   * zone.
   *
   * Best effort by design. The message itself is already written and is what matters; a preview that
   * lags behind is a much smaller problem than a message the reader never sees, so a failure here is
   * logged rather than shown or allowed to fail the send.
   */
  const touchChatRoom = useCallback(
    async (preview: string, senderId: string) => {
      // The recipients are passed in rather than read back, because this screen has already read them:
      // the same helper serves sends from screens that have not, and paying for a read the caller
      // already answered would be the price of sharing it.
      const recipients = participantIds.length > 0 ? participantIds : otherUid ? [otherUid] : [];

      try {
        await recordMessagePreview({ chatId, preview, recipients, senderId });
      } catch (error) {
        console.warn('Could not update the chat room preview:', error);
      }
    },
    [chatId, otherUid, participantIds],
  );

  const {
    cancelAudioRecording,
    handleAttachmentPress,
    isAttachmentMenuVisible,
    isRecording,
    isUploading,
    pickMedia,
    recorderDurationSeconds,
    sendGif,
    setIsAttachmentMenuVisible,
    shareLocation,
    startAudioRecording,
    stopAndSendAudio,
  } = useChatMedia(chatId, currentUser, (preview) => {
    if (currentUser) {
      void touchChatRoom(preview, currentUser.uid);
    }
  // The room's disappearing-messages timer, passed through so media carries an expiry too.
  //
  // It was omitted, which defaulted to 0 and made `expiryField()` write nothing. Text messages in this
  // same room were being given an `expiresAt` and albums, photos, videos, voice notes, locations and
  // contact cards were not -- so a room set to expire after a day would keep every picture somebody ever
  // sent in it, indefinitely, while their messages went. The timer is the promise the room makes to both
  // people in it, and media was the one thing quietly opting out of it.
  }, settings.disappearingAfterSeconds);
  const isBusy = isSending || isUploading;

  // The object form so the call type travels as a real param rather than a fragment of the path.
  // router encodes the params itself, so chatId is passed raw: encoding it here as well would
  // encode the percent signs twice and the call screen would decode the wrong id.
  const openCall = (callType: CallType) => {
    router.push({
      params: { callType, id: chatId },
      pathname: '/call/[id]',
    } as never);
  };

  useEffect(() => {
    if (mockChat) {
      return undefined;
    }

    const messagesQuery = query(
      collection(getFirebaseDb(), 'chats', chatId, 'messages'),
      orderBy('createdAt', 'asc'),
    );

    return onSnapshot(messagesQuery, (snapshot) => {
      const loaded = snapshot.docs.map((messageDocument) => ({
        ...messageDocument.data(),
        id: messageDocument.id,
      } as ChatMessage));
      // A message whose time has come is not drawn. The listener still hands it over, because the delete
      // below is what actually removes it and that needs the id: filtering here alone would leave the
      // document in the room forever, invisible to everybody and still costing a read.
      const alive = loaded.filter((message) => !isExpired(message.expiresAt));

      setMessages(alive);
      setLoadError('');

      const expiredIds = loaded.filter((message) => isExpired(message.expiresAt)).map((message) => message.id);

      if (expiredIds.length > 0) {
        // Every member may delete a message that has already expired, so whichever one happens to see it
        // last finishes the job. Failing is not worth reporting: somebody else's client will do it.
        for (const messageId of expiredIds) {
          void deleteChatMessage(chatId, messageId).catch(() => {});
        }
      }

      // Reactions for the tail of the room only. The newest messages are the ones on screen, and reading
      // a reaction for every message ever sent would make opening a long conversation cost a read per
      // message in it.
      const recentIds = alive.slice(-24).map((message) => message.id);
      const recentKey = recentIds.join(',');

      // Only when the window actually moved.
      //
      // This ran on every snapshot event, and a snapshot fires for a reaction being added, a message being
      // edited, one being pinned, one expiring -- anything in the room. Scrolling, or somebody typing, or a
      // second device receiving a read receipt all produced a fresh round of reaction reads for a set of ids
      // that had not changed. Comparing the joined ids makes the read happen when the visible tail really is
      // different, and skip in every other case.
      //
      // A reaction added to a message already on screen arrives as its own snapshot event, so this does not
      // delay a reaction appearing: the ids are unchanged but the caller re-reads on its own optimistic
      // write, and the next genuine tail change re-reads anyway. What it removes is the duplicate work, not
      // the updates that matter.
      if (recentIds.length > 0 && recentKey !== lastReactionKeyRef.current) {
        lastReactionKeyRef.current = recentKey;

        void loadMessageReactions(chatId, recentIds).then((loadedReactions) => {
          setReactions(loadedReactions);
        });
      }
    }, (error) => {
      console.error('Failed to load chat messages:', error);
      setLoadError('Could not load messages.');
    });
  }, [chatId, mockChat]);

  // This account's settings for this room, read once when it opens. Muted affects the header, and the
  // disappearing timer affects every message this account sends from here on, so both are needed before
  // the first send rather than discovered afterwards.
  useEffect(() => {
    if (mockChat || !currentUser?.uid) {
      return undefined;
    }

    let isCancelled = false;

    void loadChatSettings(chatId, currentUser.uid).then((loaded) => {
      if (!isCancelled) {
        setSettings(loaded);
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [chatId, currentUser?.uid, mockChat]);

  // Names for the sender labels, from the same profiles the room's unread counters are built out of.
  // Read once for the whole room rather than per bubble, and only for a room with several people: a
  // one-to-one has one other person whose name is already the title.
  // Whether the sender's name is drawn above every other person's message, which is only true once the
  // room has several people in it. Held as its own value so the effect below and the row renderer agree
  // on one answer rather than each working it out.
  const showsSenderNames = isGroupRoom(roomKind);

  useEffect(() => {
    const ids = participantIds.filter((participantId) => participantId !== currentUser?.uid);

    if (mockChat || !showsSenderNames || ids.length === 0) {
      return undefined;
    }

    let isCancelled = false;

    void (async () => {
      const entries = await Promise.all(ids.map(async (participantId) => {
        try {
          const snapshot = await getDoc(doc(getFirebaseDb(), 'users', participantId));
          const person = snapshot.exists() ? readPerson(snapshot.data(), '') : { name: '' };

          return [participantId, person.name] as const;
        } catch {
          // One profile that cannot be read leaves that person without a label rather than failing the
          // room. The name copied onto each message is the fallback for them.
          return [participantId, ''] as const;
        }
      }));

      if (!isCancelled) {
        setSenderNames(Object.fromEntries(entries));
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [currentUser?.uid, mockChat, participantIds, roomKind, showsSenderNames]);

  // Keeps the newest message in view once the keyboard is up, which is the whole point of opening
  // it. The list does not scroll by itself when the keyboard arrives: its content has not changed,
  // so the listener that scrolls it on new messages never fires, and without this the composer is
  // visible but the conversation it belongs to has been pushed up out of view.
  //
  // Read from the keyboard controller rather than React Native's `Keyboard` module, because on
  // Android the window no longer resizes for the keyboard and the built in module's events are the
  // ones that stopped reporting correctly under edge to edge. Selecting just `isVisible` keeps this
  // to one render per open and close instead of one per frame of the animation.
  const keyboardVisible = useKeyboardState((state) => state.isVisible);

  useEffect(() => {
    if (!keyboardVisible) {
      return undefined;
    }

    const scrollToLatest = () => {
      flatListRef.current?.scrollToEnd({ animated: true });
    };

    scrollToLatest();
    // A second beat, because the keyboard animates in over roughly 250ms. Scrolling on the frame the
    // state flips lands before the composer has finished moving, which reads as the list snapping
    // once, then again. The timer is cleared if the keyboard is dismissed before it fires.
    const settle = setTimeout(scrollToLatest, 300);

    return () => clearTimeout(settle);
  }, [keyboardVisible]);

  // The title, resolved here rather than stored: a mock room knows its own name, a real one uses the
  // profile that was read, and a room opened without either falls back to something identifying.
  //
  // A group's own name wins over anything else, because it is the name its owner chose and the only one
  // that exists for a room with several people. The name the row carried is the fallback for it, and for
  // a one-to-one the profile read here is newer than the one the row was drawn from.
  const titleName = mockChat
    ? mockChat.name
    : otherUid
      ? otherName || roomName || otherUid.slice(0, 8)
      : roomTitle || roomName || (roomKind === 'channel' ? 'Channel' : 'Group chat');

  /**
   * The other person's name, for the places that draw them rather than the room.
   *
   * Not `titleName`: a one-to-one titled from the row that opened it can fall back to a room name, and a
   * room name is the wrong letter on an avatar.
   */
  const otherDisplayName = mockChat ? mockChat.name : otherName || otherUid.slice(0, 8);

  /**
   * Where the picture and the name in the header go.
   *
   * A one-to-one opens the other person's profile, because that is the screen that answers "who is this"
   * and it is what the reader is reaching for when they press a face. A group or a channel opens the
   * room's own profile, which is where its name, about, picture and members live. Deliberately not the
   * same destination in both cases: a one-to-one has no settings a person can change, so sending it to
   * the room profile would be a dead end.
   */
  const openIdentity = useCallback(() => {
    if (mockChat) {
      return;
    }

    if (otherUid) {
      router.push({ params: { name: otherDisplayName, uid: otherUid }, pathname: '/user/[uid]' } as never);

      return;
    }

    router.push({ params: { id: chatId }, pathname: '/chat/[id]/profile' } as never);
  }, [chatId, mockChat, otherDisplayName, otherUid]);

  useEffect(() => {
    let unsubscribe = () => {};

    try {
      unsubscribe = onAuthStateChanged(getFirebaseAuth(), setCurrentUser);
    } catch (error) {
      // Firebase is not configured or auth could not initialise. currentUser is
      // already null, so the screen simply behaves as a signed-out visitor.
      console.error('Firebase auth is unavailable:', error);
    }

    return unsubscribe;
  }, []);

  // The other participant's name, for the title. Read here rather than passed as text because a name
  // can change after a room is opened, and this is the only place on the screen that shows it.
  // Skipped for a mock room, whose name the mock list already knows.
  useEffect(() => {
    // Nothing to read. The name falls back during render below rather than being cleared here, so a
    // title never blanks for a frame on the way in or out.
    if (!otherUid || mockChat) {
      return undefined;
    }

    let isCancelled = false;

    void (async () => {
      try {
        const snapshot = await getDoc(doc(getFirebaseDb(), 'users', otherUid));
        const person = snapshot.exists() ? readPerson(snapshot.data(), '') : { name: '', photoUrl: '' };

        if (!isCancelled) {
          setOtherName(person.name || otherUid.slice(0, 8));
          setOtherPhotoUrl(person.photoUrl);
        }
      } catch (error) {
        console.error('Could not load the other participant:', error);
        if (!isCancelled) {
          setOtherName('');
          setOtherPhotoUrl('');
        }
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [mockChat, otherUid]);

  /**
   * What a message looks like as a one-line preview, matching the labels the attachment sheet uses.
   *
   * A url would be unreadable in the list and says nothing about the message, which is why the send
   * path writes these words rather than the media location.
   */
  function toMessagePreview(message: Record<string, unknown>) {
    // An album is named rather than counted, and the count comes off its own items because the preview is
    // the only line there is: a conversation whose last message is an album must not show an empty row,
    // which is what the text branch below would produce for a message carrying photographs and no words.
    if (message.type === 'album') {
      const items = Array.isArray(message.albumItems) ? (message.albumItems as AlbumItem[]) : [];

      return items.length > 0 ? `Sent ${describeMessage({ albumItems: items, type: 'album' })}` : 'Sent an album';
    }

    if (message.type === 'image' || message.type === 'video' || message.type === 'audio') {
      if (message.type === 'video') return 'Sent a video';
      if (message.type === 'audio') return 'Sent a voice message';

      return 'Sent a photo';
    }

    return typeof message.text === 'string' ? message.text : '';
  }

  /**
   * Rewrites the room's preview from whatever the newest surviving message is.
   *
   * Needed after a message is taken back down: the room document keeps the text of the message that
   * was there, so the inbox would go on quoting something nobody can open any more. One ordered read
   * of the newest message, and the preview either follows it or falls back to an empty room.
   *
   * Best effort, like the update that runs when a message is sent. A stale preview in the list is
   * untidy; failing the delete because of it would be worse.
   */
  const refreshRoomPreview = useCallback(async () => {
    try {
      const newest = await getDocs(query(
        collection(getFirebaseDb(), 'chats', chatId, 'messages'),
        orderBy('createdAt', 'desc'),
        limit(1),
      ));
      const latest = newest.docs[0]?.data();

      if (latest) {
        await updateDoc(doc(getFirebaseDb(), 'chats', chatId), {
          lastMessage: toMessagePreview(latest).slice(0, 120),
          lastMessageSenderId: latest.senderId ?? '',
          // The message's own timestamp rather than now: this is when the conversation actually last
          // said something, and using now would keep pushing an empty room to the top of the inbox.
          lastMessageTime: latest.createdAt ?? serverTimestamp(),
        });

        return;
      }

      // The room is empty again, so it says so and drops out of the top of the list. `null` rather
      // than a timestamp because there is no longer a moment anything happened.
      await updateDoc(doc(getFirebaseDb(), 'chats', chatId), {
        lastMessage: 'Say hello',
        lastMessageSenderId: '',
        lastMessageTime: null,
      });
    } catch (error) {
      console.warn('Could not refresh the chat room preview:', error);
    }
  }, [chatId]);

/**
   * Puts a photograph or a clip in the phone's own gallery.
   *
   * The permission is asked for here rather than on first launch, because this is the only thing in the
   * app that writes to the gallery and a prompt somebody cannot yet say what has triggered it is a prompt
   * they will refuse. Asked for write-only: saving needs no permission to read anything else on the
   * device, and asking for the rest would be asking for a great deal more than the job needs.
   */
  const saveMedia = useCallback((message: ChatMessage) => {
    setSaveStates((current) => ({ ...current, [message.id]: 'saving' }));

    void (async () => {
      try {
        const permission = await requestSavePermission();
        let granted = permission?.granted ?? false;

        // On Android, writing to the gallery needs no permission at all -- the system allows any app to
        // add its own files there -- so a refusal is not an answer on this platform and the save is
        // attempted anyway. iOS asks properly and the refusal is final.
        if (!granted && isAndroid) {
          granted = true;
        }

        if (!granted) {
          throw new Error('Convo needs permission to save to your gallery.');
        }

        await saveMediaToPhone(message);
        setSaveStates((current) => ({ ...current, [message.id]: 'saved' }));
        Alert.alert('Saved', 'It is in your gallery and in your files.');
      } catch (error) {
        setSaveStates((current) => {
          const next = { ...current };
          delete next[message.id];

          return next;
        });
        Alert.alert(
          'Not saved',
          error instanceof Error ? error.message : 'Your device would not accept the file.',
        );
      }
    })();
  }, [isAndroid, requestSavePermission]);

  /**
   * Everything that can be done to a message, as the bar that comes up over it.
 *
 * The bar is built per message rather than shown whole, because what is on it depends on the message and
 * on who is asking: the sender may edit their own words and take the message back down, somebody who runs
 * the room may remove anybody's message and pin it, and everybody may answer it, copy it out, pass it on
 * or have it translated.
 *
 * Offered rather than checked afterwards, since the rules would refuse the others anyway. An action that
 * cannot work is not worth a button.
 */
const requestMessageActions = useCallback((message: ChatMessage) => {
    if (mockChat) {
      return;
    }

    const isMine = message.senderId === currentUser?.uid;
    const actions: MessageAction[] = [];
    // Words are the only thing that can be translated. A photograph has no text of its own, and offering
    // to translate the caption of a video would be translating a different message from the one the button
    // was pressed on. A captioned photo does have text, and gets the row on that account.
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    // What Copy puts on the clipboard: the words when there are any, and otherwise the link to the file.
    // Copying the address of a photograph is the only thing "copy" can mean for one, and it is the address
    // somebody wants when they want to send the picture to somebody who is not in this room.
    const toCopy = text !== ''
      ? text
      : typeof message.mediaUrl === 'string' && message.mediaUrl !== ''
        ? message.mediaUrl
        : '';

    if (mayPost) {
      actions.push({
        icon: 'return-down-back',
        label: 'Reply',
        onPress: () => setReplyTarget(message),
      });
    }

    if (toCopy !== '') {
      actions.push({
        icon: 'copy',
        label: 'Copy',
        onPress: () => {
          void Clipboard.setStringAsync(toCopy).then(
            () => { Alert.alert('Copied', 'The message is on your clipboard.'); },
            (error: unknown) => {
              console.error('Could not copy the message:', error);
              Alert.alert('Not copied', 'Your device would not accept the copy.');
            },
          );
        },
      });
    }

    actions.push({
      icon: 'arrow-redo-outline',
      label: 'Forward',
      onPress: () => {
        router.push({
          params: { id: chatId, messageId: message.id },
          pathname: '/chat/[id]/forward',
        } as never);
      },
    });

    if (isMine && message.type === 'text' && mayPost) {
      actions.push({
        icon: 'create',
        label: 'Edit',
        onPress: () => {
          setEditTarget(message);
          setMessageText(message.text ?? '');
        },
      });
    }

    if (text !== '') {
      actions.push({
        icon: 'language',
        label: 'Translate',
        onPress: () => setTranslateTarget(message),
      });
    }

    // Saving is only offered where there is a file to save, and a voice note is deliberately left off:
    // a recording is not something anybody keeps in their camera roll, and a document is opened rather
    // than collected. A photograph and a clip are the two things people actually want to keep.
    if (message.type === 'image' || message.type === 'video') {
      actions.push({
        icon: 'download',
        label: 'Save',
        onPress: () => saveMedia(message),
      });
    }

    if (managesRoom) {
      actions.push({
        icon: message.pinned ? 'bookmark-outline' : 'bookmark',
        label: message.pinned ? 'Unpin' : 'Pin',
        onPress: () => {
          void (async () => {
            try {
              await setMessagePinned(chatId, message.id, !message.pinned);
            } catch (error) {
              console.error('Could not pin the message:', error);
              Alert.alert('Could not pin', 'Please try again.');
            }
          })();
        },
      });
    }

    if (isMine || managesRoom) {
      actions.push({
        destructive: true,
        icon: 'trash',
        label: isMine ? 'Delete' : 'Delete for everyone',
        onPress: () => {
          Alert.alert('Delete message', 'This removes it for everyone in the conversation.', [
            { style: 'cancel', text: 'Cancel' },
            {
              style: 'destructive',
              text: 'Delete',
              onPress: () => {
                void (async () => {
                  try {
                    await deleteChatMessage(chatId, message.id);
                    await refreshRoomPreview();
                  } catch (error) {
                    console.error('Could not delete the message:', error);
                    Alert.alert('Message not deleted', 'Please try again.');
                  }
                })();
              },
            },
          ]);
        },
      });
    }

    if (actions.length === 0) {
      return;
    }

    // A bar over the conversation rather than a system alert: a list of six is more than Android's alert
    // has room for, and an alert that drops its own way out cannot be dismissed at all. The whole screen
    // above it is the way out, which is the one dismissal everybody already knows.
    setActiveMessageId(message.id);
    setMessageActions({ actions, title: summarizeMessage(message) });
  }, [chatId, currentUser?.uid, managesRoom, mayPost, mockChat, refreshRoomPreview, saveMedia]);

  const closeMessageActions = useCallback(() => {
    setActiveMessageId(null);
    setMessageActions(null);
  }, []);

  /**
   * Leaves reply and edit mode without changing anything.
   *
   * Both put the composer into a state where the next thing sent is not simply what was typed, so both
   * need a way out that is not the small cross in the corner of the composer. A press anywhere on the
   * conversation is that way out: it is where the reader's attention already is, and a mode that can
   * only be left by finding a 16pt cross is a mode people get stuck in.
   */
  const dismissComposerMode = useCallback(() => {
    setEditTarget(null);
    setReplyTarget(null);
  }, []);

/** Takes this account's reaction off a message, or puts it on for the first time. */
  const handleReactionPress = useCallback((message: ChatMessage, emoji: string) => {
    void toggleMessageReaction(chatId, message.id, emoji).then(() => {
      return loadMessageReactions(chatId, [message.id]);
    }).then((updated) => {
      setReactions((current) => ({ ...current, [message.id]: updated[message.id] ?? [] }));
    }).catch((error) => {
      console.error('Could not react to the message:', error);
    });
  }, [chatId]);

  /**
   * A reaction chosen from the strip over a message.
   *
   * The bar goes at the same time: the strip has answered the question it opened, and leaving the bar up
   * under a message that has just been reacted to is a second row of choices nobody asked for.
   */
  const reactFromStrip = useCallback((message: ChatMessage, emoji: string) => {
    closeMessageActions();
    handleReactionPress(message, emoji);
  }, [closeMessageActions, handleReactionPress]);

  /** The heart on a bubble: this account's heart on that message, or off it again. */
  const toggleHeart = useCallback((message: ChatMessage) => {
    handleReactionPress(message, HEART_EMOJI);
  }, [handleReactionPress]);

  /** Holding the heart offers the whole set, for somebody who meant a different emoji. */
  const openReactionPicker = useCallback((message: ChatMessage) => {
    setReactionTarget(message);
  }, []);

  /**
   * Translates a message into a chosen language and shows the result over the conversation.
   *
   * The answer is shown rather than written into the composer or sent back into the room: a translation
   * is something the reader asked for, not something anybody said. Copying it is one tap away for the
   * case where they did want to send it on.
   */
  const runTranslation = useCallback((message: ChatMessage, target: TranslationLanguage) => {
    const text = typeof message.text === 'string' ? message.text.trim() : '';

    if (text === '') {
      return;
    }

    setTranslateTarget(null);
    setIsTranslating(true);

    void translateMessageText(text, target)
      .then((translated) => {
        setTranslation({ language: target, original: text, text: translated });
      })
      .catch((error: unknown) => {
        // Every failure from the translation module is already a sentence somebody can be told, and it is
        // worth telling rather than swallowing: a button that does nothing is worse than one that explains.
        Alert.alert(
          'Could not translate',
          error instanceof Error ? error.message : 'Please try again in a moment.',
        );
      })
      .finally(() => {
        setIsTranslating(false);
      });
  }, []);

/**
 * Whether this account's heart is on a message, for the bubble to draw it filled.
   *
   * Read off the tally that is already on screen rather than from a second source, so the heart on the
   * bubble and the pill under it cannot disagree about who reacted.
   */
  const hasMyHeart = useCallback((messageId: string) => (
    (reactions[messageId] ?? []).some((reaction) => (
      reaction.uid === currentUser?.uid && reaction.emoji === HEART_EMOJI
    ))
  ), [currentUser?.uid, reactions]);

  /**
   * Warms the app's own copy of the media that is on screen.
   *
   * Photographs and clips that have been looked at are downloaded into the cache without being asked for,
   * so the same conversation opens straight away next time and opens at all without a connection. It is
   * the same cache the Save button writes into, so a file that was already saved is not downloaded twice.
   *
   * Bounded on purpose, in two ways. Only the newest handful of messages are considered, because a
   * conversation can be a thousand long and a cache of all of it is a phone with no room left. And one
   * download runs at a time: twenty clips starting together is twenty connections and a battery spent on
   * something the reader did not ask for.
   *
   * Failures are the cache's own business and are logged by the cache, not raised: nothing on screen
   * depends on this having worked, and the remote file is still what the bubble falls back to.
   */
  useEffect(() => {
    // Photographs and clips are the two that are worth having a copy of. Voice notes are not warmed: they
    // are small and nobody replays one out of an old conversation, and this budget is better spent on the
    // pictures.
    const recent = messages
      .filter((message) => message.type === 'image' || message.type === 'video')
      .slice(-6);

    if (recent.length === 0) {
      return undefined;
    }

    let isCurrent = true;

    void (async () => {
      // What is already on the device is asked of the cache rather than of this map, because the map only
      // knows about downloads this screen watched and the cache may well have been warmed last time. This
      // is the usual case on a second visit, and it is the reason the cache is worth having at all.
      //
      // Awaited before the state is touched so this cannot be a synchronous set during the effect itself,
      // which would render the whole conversation a second time for nothing.
      const already = recent
        .map((message) => [message.id, cachedMediaUri(message)] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] !== null);

      if (already.length > 0) {
        await Promise.resolve();

        if (!isCurrent) {
          return;
        }

        setCachedUrls((current) => (
          already.every(([messageId, uri]) => current[messageId] === uri)
            ? current
            : { ...current, ...Object.fromEntries(already) }
        ));
      }

      for (const message of recent) {
        if (!isCurrent || already.some(([messageId]) => messageId === message.id)) {
          continue;
        }

        // One download at a time, deliberately: twenty clips starting together is twenty connections and a
        // battery spent on something nobody asked for.
        const file = await cacheMedia(message);

        if (!isCurrent || !file) {
          continue;
        }

        setCachedUrls((current) => ({ ...current, [message.id]: file.uri }));
      }
    })();

    return () => {
      isCurrent = false;
    };
  }, [messages]);

  /**
   * Who chose a reaction.
   *
   * Names are read from the same map the sender labels come from, and a name that is not known yet is
   * said to be somebody's rather than guessed at: the reader is being told who reacted to them, and a
   * wrong name here is worse than no name.
   */
  const reactionPeekNames = useMemo(() => {
    if (!reactionPeek) {
      return [];
    }

    return (reactions[reactionPeek.messageId] ?? [])
      .filter((reaction) => reaction.emoji === reactionPeek.emoji)
      .map((reaction) => ({
        emoji: reaction.emoji,
        name: reaction.uid === currentUser?.uid
          ? 'You'
          : senderNames[reaction.uid] || 'Somebody',
        uid: reaction.uid,
      }));
  }, [currentUser?.uid, reactionPeek, reactions, senderNames]);

  // The room document, read once when the conversation is opened.
  //
  // One read for three things that used to be three answers from three places: the participant list,
  // because sending a message has to move the unread badge of everybody in a group; what the room is
  // called and about, so the title and the profile are the room's own rather than whatever the row was
  // drawn from; and whether it is a channel, which decides whether this account may post into it at all.
  //
  // A live listener rather than a single read, because the owner can rename the room from the profile
  // screen and this one is under it. Skipped for a mock room, whose id is not a Firestore document.
  useEffect(() => {
    if (mockChat) {
      return undefined;
    }

    let isCancelled = false;

    void (async () => {
      try {
        const snapshot = await getDoc(doc(getFirebaseDb(), 'chats', chatId));
        const data = snapshot.exists() ? snapshot.data() : undefined;

        if (!isCancelled && data) {
          // Bare ids only. A room written with `{ uid }` objects is filtered rather than trusted, so
          // an unread counter can never be written to a key that is not a uid.
          setParticipantIds(readParticipantIds(data));
          setRoomKind(readRoomKind(data));
          setRoomAbout(readRoomAbout(data));
          setRoomOwnerId(readRoomOwnerId(data));
          setRoomAdminIds(readRoomAdminIds(data));
          setRoomAvatarUrl(readRoomAvatarUrl(data));
          setRoomPrivacy(readRoomPrivacy(data));

          // Only for a room with several people: a one-to-one is titled by the person, not by the room,
          // and writing a name onto it would be a name nobody chose.
          if (isGroupRoom(readRoomKind(data))) {
            setRoomTitle(readRoomName(data, ''));
          }
        }
      } catch (error) {
        // Best effort: without it the sender's own message still goes out, and the other person in a
        // one-to-one room is still marked through the id the list passed in.
        console.warn('Could not load the chat participants:', error);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [chatId, mockChat]);

  // Who else is typing in this room. The signal expires by age rather than by being cleared, so a
  // typist who closes the app mid-sentence cannot leave the other person looking at a permanent
  // "typing" indicator.
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);

  useEffect(() => {
    // A mock room has no document behind it, and nothing to announce into.
    if (mockChat) {
      return undefined;
    }

    return subscribeToTyping(chatId, readerId, setTypingUserIds);
  }, [chatId, mockChat, readerId]);

  // Our own signal, held so it can be stopped rather than merely restarted.
  const stopTypingRef = useRef<(() => void) | null>(null);

  const noteTyping = useCallback(() => {
    if (mockChat || !readerId) {
      return;
    }

    // Already announcing: startTyping refreshes on its own timer, so calling it again on every
    // keystroke would stack timers and multiply the writes.
    if (stopTypingRef.current) {
      return;
    }

    stopTypingRef.current = startTyping(chatId, readerId);
  }, [chatId, mockChat, readerId]);

  const clearTyping = useCallback(() => {
    stopTypingRef.current?.();
    stopTypingRef.current = null;
  }, []);

  // Leaving the screen must stop the signal, or the other side is told somebody is typing until the
  // five second window lapses.
  useEffect(() => () => {
    stopTypingRef.current?.();
    stopTypingRef.current = null;
  }, []);

  // Whether the other person is online, for the line under the name. One listener, and only for a
  // one-to-one room: a group has several people, and a single answer about the room would be a claim
  // about all of them.
  const [isOtherOnline, setIsOtherOnline] = useState(false);
  // Read once here rather than inferred from the result, because "Offline" is a statement about a
  // person and this build cannot know it. With no database configured the line stays blank instead.
  const presenceAvailable = isRealtimeDatabaseConfigured();

  useEffect(() => {
    // Nothing to report for a mock room, a group, or a room opened without the other id.
    if (!otherUid || mockChat) {
      return undefined;
    }

    return subscribeToPresence([otherUid], (presence) => setIsOtherOnline(presence[otherUid] === true));
  }, [mockChat, otherUid]);

  // The typist is named only when it is provably the one person the title is showing. In a group any
  // of several people could be behind the signal, so a name there would be a guess.
  const isTheOtherPersonTyping =
    typingUserIds.length === 1 && Boolean(otherUid) && typingUserIds[0] === otherUid;
  const typingName = mockChat?.name ?? otherName;

  // Typing first, because it is the more urgent of the two, and because a person who is typing in the
  // room this screen is showing is answering "is the other person there" by definition. A group has
  // no single presence to show, so it says nothing at all when nobody is typing.
  const statusLabel = typingUserIds.length > 0
    ? typingUserIds.length > 1
      ? `${typingUserIds.length} people are typing`
      : isTheOtherPersonTyping && typingName
        ? `${typingName.split(' ')[0]} is typing`
        : 'Someone is typing'
    // Muted before online, because it is the one thing on this line the reader cannot otherwise see: the
    // mute button that used to live in this header is gone (four buttons in this row squeezed the name out
    // of existence on a narrow phone), and a conversation silently muted is a thing people want to be told
    // about. Changing it is two taps away, on the room's settings screen.
    : settings.muted
      ? 'Muted'
      : otherUid && !mockChat && presenceAvailable
        ? isOtherOnline
          ? 'Online'
          : 'Offline'
        : '';

  /**
   * Clears this account's unread count for the room, once, when the conversation is opened.
   *
   * Writing 0 rather than adjusting it down means a message that arrives in the moment between the
   * screen opening and this landing is also marked read, which is the behaviour a reader expects:
   * they are looking at the conversation.
   *
   * Best effort, and skipped entirely for a mock room because those ids are not Firestore
   * documents and the write would be refused anyway.
   */
  useEffect(() => {
    if (!readerId || mockChat) {
      return undefined;
    }

    // No cancellation guard: there is no state to set afterwards, so tearing the effect down early
    // has nothing to protect. The write simply completes or fails on its own.
    void (async () => {
      try {
        await updateDoc(doc(getFirebaseDb(), 'chats', chatId), {
          [`unreadCounts.${readerId}`]: 0,
        });
      } catch (error) {
        // A badge that will not clear is untidy, not broken: the conversation is open and readable
        // either way, so this is never worth interrupting the reader over.
        console.warn('Could not clear the unread count for this chat:', error);
      }
    })();
  }, [chatId, mockChat, readerId]);

  /**
   * What the send button does, which depends on what the composer is in.
   *
   * Editing a message and sending a new one share a text box and a button, and are told apart by
   * `editTarget` rather than by a different screen, because the thing being edited is on screen and the
   * point is to change it where the reader is already looking.
   */
  const handleSend = async () => {
    const text = messageText.trim();
    if (!text || !currentUser || isBusy) {
      return;
    }

    // The composer is emptied before the write rather than after it, so the text leaves the box the
    // moment it is sent instead of sitting there for the length of a round trip. If the write is
    // refused the text is put back, so nothing is ever lost by being quick.
    setMessageText('');
    clearTyping();
    setIsSending(true);

    try {
      if (editTarget) {
        await editMessageText(chatId, editTarget.id, text);
        setEditTarget(null);
        return;
      }

      await sendTextMessage({
        chatId,
        // The timer is this account's own setting for this room, so a message disappearing is a thing
        // the person who wrote it agreed to, not a room-wide policy imposed on them.
        expiresInSeconds: settings.disappearingAfterSeconds,
        replyTo: replyTarget
          ? {
            id: replyTarget.id,
            senderName: senderNames[replyTarget.senderId]
              || replyTarget.senderName
              || 'Someone',
            text: summarizeMessage(replyTarget),
          }
          : null,
        text,
      });

      setReplyTarget(null);
      void touchChatRoom(text, currentUser.uid);
    } catch (error) {
      console.error('Failed to send message:', error);
      // Restored only if the box is still empty, so a message typed while this one was in flight is
      // not overwritten by the failure of the older send.
      setMessageText((current) => (current ? current : text));
      // Said rather than shrugged at, because "please try again" on a write the rules refuse is a
      // sentence that sends the reader looking for a network problem that is not there.
      Alert.alert(
        editTarget ? 'Message not edited' : 'Message not sent',
        describeSendFailure(error),
      );
    } finally {
      setIsSending(false);
    }
  };

  /** Leaves edit mode without changing anything, and gives the box back to sending. */
  const cancelEdit = useCallback(() => {
    setEditTarget(null);
    setMessageText('');
  }, []);

  // Pinned messages, newest last, read from the loaded room rather than from a second query. A pinned
  // message is a message, so it is already in the list above; asking for it again would be a second
  // listener over the same documents to answer a question the first one already answers.
  const pinnedMessages = messages.filter((message) => message.pinned);

  /**
   * Where a photo sits in its album, or nothing when it is not part of one.
   *
   * From the messages either side of it rather than from `albumIndex`, because a reader who has scrolled
   * into the middle of a long conversation has the first photo of the album above the loaded window and a
   * count read off the list would then describe only what happens to be on screen.
   */
  const albumFor = useCallback((message: ChatMessage, index: number) => {
    if (!message.albumId) {
      return undefined;
    }

    const sameAlbum = (other?: ChatMessage) => other?.albumId === message.albumId;
    const previous = messages[index - 1];
    const next = messages[index + 1];

    return {
      count: message.albumCount ?? 1,
      // Four positions rather than three, because an album of three has a middle: rounding off its bottom
      // corners as well as its top ones would cut the group into two pictures with a seam between them.
      position: !sameAlbum(previous) && !sameAlbum(next)
        ? 'only'
        : sameAlbum(previous)
          ? sameAlbum(next)
            ? 'middle'
            : 'last'
          : 'first',
    } as const;
  }, [messages]);

  const renderMessage = ({ item, index }: { index: number; item: ChatMessage }) => (
    <MessageBubble
      album={albumFor(item, index)}
      cachedUrl={cachedUrls[item.id]}
      hasMyHeart={hasMyHeart(item.id)}
      isMine={item.senderId === currentUser?.uid}
      message={item}
      onLongPress={requestMessageActions}
      onLongPressHeart={openReactionPicker}
      onLongPressReaction={(message, emoji) => setReactionPeek({ emoji, messageId: message.id })}
      onOpenMedia={(items, startIndex, messageId) => setOpenAlbum({ items, messageId, startIndex })}
      onPressHeart={toggleHeart}
      onPressEmoji={reactFromStrip}
      onPressReaction={handleReactionPress}
      onSave={saveMedia}
      reactions={tallyReactions(reactions[item.id] ?? [], currentUser?.uid ?? '')}
      saveState={saveStates[item.id] ?? 'idle'}
      senderName={senderNames[item.senderId]}
      showReactionStrip={messageActions !== null && activeMessageId === item.id}
      showSenderName={showsSenderNames}
    />
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        {/* Drawn before the conversation rather than over it, so it only gets a press that nothing else
            wanted. That ordering is the whole reason the bar is not in a dialog: a dialog is a separate
            window, its dimmed backdrop sits over every message, and so it swallowed the press on the
            strip of reactions that comes up at the same time -- the strip was drawn, and unpressable.
            Behind the conversation, the strip is the topmost thing where it is, and the press on the empty
            part of the conversation lands here. */}
        {messageActions !== null ? (
          <Pressable
            accessibilityLabel="Close the message menu"
            accessibilityRole="button"
            onPress={closeMessageActions}
            style={styles.menuDismissLayer}
          />
        ) : null}

        <View style={styles.header}>
<Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.backButton}>
            <Text style={styles.backText}>{'<-'}</Text>
          </Pressable>

          {/* The picture and the name as one target, because they answer one question: who is this with. A
              press on either goes to the same place, so the two cannot disagree about where the tap leads.
              For a one-to-one that is the person's own profile; for a group it is the room's. */}
          <Pressable
            accessibilityLabel={otherUid ? otherDisplayName : 'Room info'}
            accessibilityRole="button"
            onPress={openIdentity}
            style={({ pressed }) => [styles.headerIdentity, pressed && styles.pressed]}
          >
            {/* One-to-one: the other person, because a conversation has no picture of its own and the only
                thing worth showing there is who it is with. One component for the picture and its light, so
                the dot here cannot disagree with the one in the chat list. */}
            {otherUid && !mockChat ? (
              <PersonAvatar
                isOnline={isOtherOnline}
                name={otherDisplayName}
                photoUrl={otherPhotoUrl}
                size={38}
              />
            ) : roomAvatarUrl ? (
              <Image
                accessibilityIgnoresInvertColors
                contentFit="cover"
                source={{ uri: roomAvatarUrl }}
                style={styles.headerAvatar}
                transition={120}
              />
            ) : (
              /* A group or a channel that has no picture of its own. Drawn rather than left blank, because
                 the room profile screen already shows this glyph for the same room, and two screens
                 disagreeing about what a pictureless group looks like is worse than either answer. */
              <View style={styles.headerAvatarFallback}>
                <Ionicons color="#8D929C" name={roomKind === 'channel' ? 'megaphone' : 'people'} size={18} />
              </View>
            )}

            {/* flex: 1 is what makes the name win the leftover space rather than the buttons. The header
                used to hold four buttons here, which on a 360dp phone left this block about 24dp -- narrow
                enough that the name was invisible while the fixed-size picture beside it was perfectly
                visible, which is a confusing thing to be shown. flexShrink 0 keeps the picture from being
                squeezed instead, which is the same bug one level down. */}
            <View style={styles.headerTitle}>
              {/* The kind, and whether the room can still be joined with a link. The second half only on a room
                  with several people: a conversation's whole audience is the two people in it, and a lock on
                  it would be a claim that there was somebody to keep out. */}
              <Text ellipsizeMode="tail" numberOfLines={1} style={styles.eyebrow}>
                {roomKind === 'direct'
                  ? 'CONVERSATION'
                  : `${roomKind === 'channel' ? 'CHANNEL' : 'GROUP'} · ${roomPrivacy === 'private' ? 'PRIVATE' : 'PUBLIC'}`}
              </Text>
              <Text ellipsizeMode="tail" numberOfLines={1} style={styles.title}>{titleName}</Text>
              {/* Sits under the name rather than in place of it, showing who is typing or whether the
                  other person is online, and only when there is something to report. A reserved line
                  keeps the header from changing height as people start and stop typing. The room's own
                  about fills the line when there is nothing live to say, which is what makes the line
                  worth its height for a group: a name on its own does not say what the room is for. */}
              <Text
                numberOfLines={1}
                style={[
                  styles.statusLabel,
                  typingUserIds.length > 0 ? styles.statusLabelTyping : null,
                  !statusLabel && !roomAbout && styles.typingLabelHidden,
                ]}
              >
                {statusLabel || roomAbout || ' '}
              </Text>
            </View>
          </Pressable>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityLabel="Search this conversation"
              accessibilityRole="button"
              onPress={() => router.push({ params: { id: chatId }, pathname: '/chat/[id]/search' } as never)}
              style={({ pressed }) => [styles.headerIcon, pressed && styles.pressed]}
            >
              <Ionicons color="#8D929C" name="search" size={18} />
            </Pressable>
            {/* Mute used to be here too. It is on the room's settings screen, which this header already
                reaches in one tap, and four buttons in this row is what squeezed the name out of
                existence on a narrow phone. */}
            {/* Both call buttons are behind the chatCalls flag. They were rendered unconditionally while the flag
                existed and was read nowhere, so they led to a call screen that could only report
                `no-token-service` -- a dead end presented as a working feature. `openCall`, the
                `/call/[id]` routes and src/lib/agora-call.ts stay exactly where they are, so turning the
                flag on once AGORA_APP_CERTIFICATE is configured brings both back with nothing else to do. */}
            {chatCallsEnabled ? (
              <>
                <Pressable
                  accessibilityLabel="Start phone call"
                  accessibilityRole="button"
                  onPress={() => openCall('audio')}
                  style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
                >
                  {/* Ionicons rather than SymbolView: expo-symbols renders through the Material
                      Symbols font, which does not come up on Android here, so those two glyphs
                      were drawing nothing and left the buttons blank. */}
                  <Ionicons color="#FFFFFF" name="call-outline" size={19} />
                </Pressable>
                <Pressable
                  accessibilityLabel="Start video call"
                  accessibilityRole="button"
                  onPress={() => openCall('video')}
                  style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
                >
                  <Ionicons color="#FFFFFF" name="videocam-outline" size={20} />
                </Pressable>
              </>
            ) : null}
          </View>
        </View>

        {/* `translate-with-padding` rather than `padding`: the composer moves up out of the
            keyboard's way and the padding is applied once per animation, which is the mode meant
            for a chat layout. The platform branch that used to be here was not styling the two
            platforms differently on purpose, it was React Native's KeyboardAvoidingView standing
            in for a resize that Android 16 no longer does. `automaticOffset` measures where this
            view actually sits, which matters because the header is drawn above it rather than by a
            navigator. */}
        <KeyboardAvoidingView
          automaticOffset
          behavior="translate-with-padding"
          style={styles.conversation}
        >
          {loadError ? <Text style={styles.loadError}>{loadError}</Text> : null}

          {/* Pinned messages, as a line rather than a screen. The point of pinning is that somebody
              who was not there when it was said can still find it, and the cheapest way to be findable
              is to be one tap from the top of the room instead of behind a menu. */}
          {pinnedMessages.length > 0 ? (
            <Pressable
              accessibilityLabel="Pinned messages"
              accessibilityRole="button"
              onPress={() => router.push({ params: { id: chatId }, pathname: '/chat/[id]/pinned' } as never)}
              style={styles.pinnedBar}
            >
              <Ionicons color="#2FBF71" name="bookmark" size={14} />
              <Text numberOfLines={1} style={styles.pinnedText}>
                {pinnedMessages.length === 1
                  ? summarizeMessage(pinnedMessages[0])
                  : `${pinnedMessages.length} pinned messages`}
              </Text>
            </Pressable>
          ) : null}

          {/*
            The press that leaves reply and edit mode. It wraps the list rather than sitting over it, so
            it only receives a press that nothing else wanted: the bubbles keep their own long press, and
            scrolling the list is still scrolling. Only offered while one of those modes is on, because a
            tap on a conversation is more often somebody trying to read the message they pressed.
          */}
          <Pressable
            onPress={replyTarget || editTarget ? dismissComposerMode : undefined}
            style={styles.messageArea}
          >
            <FlatList
              ref={flatListRef}
              contentContainerStyle={messages.length ? styles.messageList : styles.emptyList}
              data={messages}
              keyExtractor={(item) => item.id}
              ListEmptyComponent={(
                <View style={styles.emptyState}>
                  <Text style={styles.emptyTitle}>Start a conversation</Text>
                  <Text style={styles.emptySubtitle}>Send a message to start the conversation.</Text>
                </View>
              )}
              onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
              renderItem={renderMessage}
            />
          </Pressable>

          {/* In place of the composer rather than disabled under it. A channel member can read
              everything in the room and cannot add to it, and an input they cannot use is a question
              they have to ask rather than an answer. Says who can, because "only the owner can post"
              without saying who the owner is is not much use to a reader. */}
          {!mayPost ? (
            <View style={styles.readOnlyBar}>
              <Ionicons color="#8D929C" name="megaphone" size={16} />
              <Text style={styles.readOnlyText}>
                {roomOwnerId === ''
                  ? 'Nobody can post in this channel.'
                  : 'Only the channel owner can post here.'}
              </Text>
            </View>
          ) : isRecording ? (
            <View style={styles.recordingBar}>
              <View style={styles.recordingIndicator} />
              <Text style={styles.recordingText}>
                Recording {recorderDurationSeconds}s
              </Text>
              <Pressable
                accessibilityLabel="Cancel recording"
                onPress={() => void cancelAudioRecording()}
                style={styles.cancelRecordingButton}
              >
                <Text style={styles.cancelRecordingText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityLabel="Stop and send audio"
                onPress={() => void stopAndSendAudio()}
                style={styles.sendAudioButton}
              >
                <Ionicons color="#FFFFFF" name="arrow-up" size={18} />
              </Pressable>
            </View>
          ) : (
            <View>
              {/* What the box is currently for, said above it. Replying and editing both put something in
                  the composer's place that has to be dismissible, because the alternative is typing a
                  reply and sending it as a new message without noticing. */}
              {editTarget ? (
                <View style={styles.composerContext}>
                  <Ionicons color="#8D929C" name="create" size={14} />
                  <Text numberOfLines={1} style={styles.composerContextText}>Editing message</Text>
                  <Pressable accessibilityLabel="Cancel edit" accessibilityRole="button" onPress={cancelEdit}>
                    <Ionicons color="#8D929C" name="close" size={16} />
                  </Pressable>
                </View>
              ) : replyTarget ? (
                <View style={styles.composerContext}>
                  <Ionicons color="#8D929C" name="return-down-back" size={14} />
                  <Text numberOfLines={1} style={styles.composerContextText}>
                    Replying to {senderNames[replyTarget.senderId] || replyTarget.senderName || 'Someone'}
                  </Text>
                  <Pressable
                    accessibilityLabel="Cancel reply"
                    accessibilityRole="button"
                    onPress={() => setReplyTarget(null)}
                  >
                    <Ionicons color="#8D929C" name="close" size={16} />
                  </Pressable>
                </View>
              ) : null}

              <View style={styles.composer}>
              <Pressable
                accessibilityLabel="Attach media"
                accessibilityRole="button"
                disabled={isBusy}
                onPress={handleAttachmentPress}
                style={({ pressed }) => [styles.attachmentButton, pressed && styles.pressed]}
              >
                <Ionicons color="#363A42" name="add" size={24} />
              </Pressable>
              <TextInput
                editable={!isBusy}
                onChangeText={(text) => {
              setMessageText(text);
              // Only while there is something to send: emptying the composer ends the signal, which
              // is what stops the indicator the moment a message goes out.
              if (text.trim()) {
                noteTyping();
              } else {
                clearTyping();
              }
            }}
                onSubmitEditing={() => void handleSend()}
                placeholder={editTarget ? 'Edit your message...' : 'Write a message...'}
                placeholderTextColor="#8D929C"
                returnKeyType="send"
                style={styles.messageInput}
                value={messageText}
              />
              <Pressable
                accessibilityLabel={editTarget ? 'Save edit' : 'Send message'}
                accessibilityRole="button"
                disabled={isBusy || !messageText.trim()}
                onPress={() => void handleSend()}
                style={({ pressed }) => [styles.sendButton, pressed && styles.pressed, (!messageText.trim() || isBusy) && styles.sendButtonDisabled]}
              >
                {isBusy ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Ionicons color="#FFFFFF" name={editTarget ? 'checkmark' : 'arrow-up'} size={18} />
                )}
              </Pressable>
            </View>

            {/* Says what this account's timer will do to what they are about to send, because a timer
                nobody is told about is indistinguishable from a bug when the message vanishes. */}
            {settings.disappearingAfterSeconds > 0 ? (
              <Text style={styles.timerHint}>
                Messages you send here disappear after {describeDisappearing(settings.disappearingAfterSeconds).toLowerCase()}
              </Text>
            ) : null}
          </View>
        )}
        </KeyboardAvoidingView>

        {/* What can be done to the long-pressed message, as a bar across the bottom of the conversation.
            Laid into this screen rather than put up in a dialog, for the reason given on the dismiss layer
            above: a dialog's backdrop would be over the strip of reactions, and the strip would stop
            working. Two ways out rather than one: a press anywhere on the conversation, and the system
            back gesture. A press on the bar itself does nothing, so reaching for a button never dismisses
            it by accident. */}
        {messageActions !== null ? (
          <Pressable
            accessibilityLabel="Message menu"
            accessibilityRole="none"
            onPress={() => {}}
            style={[styles.actionBar, { paddingBottom: 12 + insets.bottom }]}
          >
            {/* The message the bar belongs to, so a bar of icons is anchored to something. One line and
                dimmed: it identifies the message and is not the thing being read. */}
            <Text numberOfLines={1} style={styles.actionBarTitle}>{messageActions?.title}</Text>

            {/* Scrolls sideways rather than wrapping. Seven buttons wrapped onto a phone are two rows,
                and the second row sits under the system navigation bar on a device with gesture
                navigation, where it cannot be pressed at all. */}
            <ScrollView
              contentContainerStyle={styles.actionBarContent}
              horizontal
              showsHorizontalScrollIndicator={false}
              >
                {messageActions?.actions.map((action) => (
                  <Pressable
                    accessibilityLabel={action.label}
                    accessibilityRole="button"
                    key={action.label}
                    onPress={() => {
                      // Closed first, because each of these either changes the screen underneath or puts
                      // up something of its own, and a bar still on top of either is a layer too many.
                      closeMessageActions();
                      action.onPress();
                    }}
                    style={({ pressed }) => [styles.actionBarButton, pressed && styles.pressed]}
                  >
                    <Ionicons
                      color={action.destructive ? '#E5484D' : '#363A42'}
                      name={action.icon}
                      size={20}
                    />
                    <Text
                      numberOfLines={1}
                      style={[styles.actionBarLabel, action.destructive && styles.actionBarLabelDestructive]}
                    >
                      {action.label}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
          </Pressable>
        ) : null}

        {/* Who reacted, asked by holding a reaction pill. A count on a pill says that three people chose it and
            not which three, and on a group the difference matters: somebody deciding whether to join in
            wants to know whether it was somebody they know. */}
        <Modal
          animationType="fade"
          onRequestClose={() => setReactionPeek(null)}
          transparent
          visible={reactionPeek !== null}
        >
          <Pressable onPress={() => setReactionPeek(null)} style={styles.modalBackdrop}>
            <Pressable
              onPress={(event) => event.stopPropagation()}
              style={[styles.translateSheet, { paddingBottom: 14 + insets.bottom }]}
            >
              <Text style={styles.sheetTitle}>
                {`${reactionPeek?.emoji ?? ''}  Reacted with`}
              </Text>

              {reactionPeekNames.map((entry) => (
                <View key={entry.uid} style={styles.peekRow}>
                  {/* The first letter rather than a picture: names for the people in a room are already
                      loaded for the sender labels, and a row of grey circles would be a row of nothing. */}
                  <View style={styles.peekInitial}>
                    <Text style={styles.peekInitialText}>
                      {(entry.name || '?').charAt(0).toUpperCase()}
                    </Text>
                  </View>
                  <Text numberOfLines={1} style={styles.peekName}>{entry.name}</Text>
                </View>
              ))}

              <Pressable
                accessibilityLabel="Close"
                accessibilityRole="button"
                onPress={() => setReactionPeek(null)}
                style={({ pressed }) => [styles.translateRow, pressed && styles.pressed]}
              >
                <Ionicons color="#8D929C" name="close" size={18} />
                <Text style={[styles.translateRowText, styles.translateRowCancel]}>Close</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>

        {/* Which language to translate into, asked before the request rather than after: the alternative is
            guessing from the device and being wrong for half the readers in a room. */}
        <Modal
          animationType="fade"
          onRequestClose={() => setTranslateTarget(null)}
          transparent
          visible={translateTarget !== null}
        >
          <Pressable onPress={() => setTranslateTarget(null)} style={styles.modalBackdrop}>
            <Pressable
              onPress={(event) => event.stopPropagation()}
              style={[styles.translateSheet, { paddingBottom: 14 + insets.bottom }]}
            >
              <Text style={styles.sheetTitle}>Translate into</Text>

              {/* Only the language this message is not already in, so the one choice that would come back
                  saying "it is already that language" is not offered at all. */}
              {TRANSLATION_LANGUAGES
                .filter((language) => language.code !== detectTranslationLanguage(translateTarget?.text ?? ''))
                .map((language) => (
                  <Pressable
                    accessibilityLabel={`Translate into ${language.label}`}
                    accessibilityRole="button"
                    key={language.code}
                    onPress={() => {
                      const target = translateTarget;

                      setTranslateTarget(null);
                      if (target) {
                        runTranslation(target, language.code);
                      }
                    }}
                    style={({ pressed }) => [styles.translateRow, pressed && styles.pressed]}
                  >
                    <Ionicons color="#2FBF71" name="language" size={18} />
                    <Text style={styles.translateRowText}>{language.label}</Text>
                  </Pressable>
                ))}

              <Pressable
                accessibilityLabel="Cancel"
                accessibilityRole="button"
                onPress={() => setTranslateTarget(null)}
                style={({ pressed }) => [styles.translateRow, pressed && styles.pressed]}
              >
                <Ionicons color="#8D929C" name="close" size={18} />
                <Text style={[styles.translateRowText, styles.translateRowCancel]}>Cancel</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>

        {/* The translation, over the conversation and dismissed by a press anywhere on it. The original is
            kept on screen above the answer, because a translation with nothing to check it against is a
            thing to act on rather than a thing to trust. */}
        <Modal
          animationType="fade"
          onRequestClose={() => setTranslation(null)}
          transparent
          visible={translation !== null || isTranslating}
        >
          <Pressable onPress={() => setTranslation(null)} style={styles.modalBackdrop}>
            <Pressable
              onPress={(event) => event.stopPropagation()}
              style={[styles.translateSheet, { paddingBottom: 14 + insets.bottom }]}
            >
              {isTranslating ? (
                <View style={styles.translateBusy}>
                  <ActivityIndicator color="#2FBF71" />
                  <Text style={styles.translateBusyText}>Translating...</Text>
                </View>
              ) : (
                <>
                  <Text style={styles.sheetTitle}>
                    {languageLabel(translation?.language ?? 'my')}
                  </Text>

                  <ScrollView style={styles.translateScroll}>
                    <Text style={styles.translateOriginal}>{translation?.original}</Text>
                    <Text style={styles.translateText}>{translation?.text}</Text>
                  </ScrollView>

                  <Pressable
                    accessibilityLabel="Copy the translation"
                    accessibilityRole="button"
                    onPress={() => {
                      const text = translation?.text;

                      if (!text) {
                        return;
                      }

                      void Clipboard.setStringAsync(text).then(
                        () => { Alert.alert('Copied', 'The translation is on your clipboard.'); },
                        (error: unknown) => {
                          console.error('Could not copy the translation:', error);
                          Alert.alert('Not copied', 'Your device would not accept the copy.');
                        },
                      );
                    }}
                    style={({ pressed }) => [styles.translateCopy, pressed && styles.pressed]}
                  >
                    <Ionicons color="#FFFFFF" name="copy" size={16} />
                    <Text style={styles.translateCopyText}>Copy translation</Text>
                  </Pressable>
                </>
              )}
            </Pressable>
          </Pressable>
        </Modal>

        {/* The reaction picker. A row of the six rather than the platform keyboard, because choosing a
            reaction is a choice from a fixed set and a keyboard here would be one more thing between a
            long press and a thumbs up. Sits clear of the system navigation bar: this row used to land on
            top of it, and on a device with gesture navigation the lower half of every emoji could not be
            pressed at all. */}
        <Modal
          animationType="fade"
          onRequestClose={() => setReactionTarget(null)}
          transparent
          visible={reactionTarget !== null}
        >
          <Pressable onPress={() => setReactionTarget(null)} style={styles.modalBackdrop}>
            <Pressable
              onPress={(event) => event.stopPropagation()}
              style={[styles.emojiSheet, { marginBottom: insets.bottom }]}
            >
              {REACTION_EMOJI.map((emoji) => (
                <Pressable
                  accessibilityLabel={`React ${emoji}`}
                  accessibilityRole="button"
                  key={emoji}
                  onPress={() => {
                    const target = reactionTarget;

                    setReactionTarget(null);
                    if (target) {
                      handleReactionPress(target, emoji);
                    }
                  }}
                  style={({ pressed }) => [styles.emojiButton, pressed && styles.pressed]}
                >
                  <Text style={styles.emojiGlyph}>{emoji}</Text>
                </Pressable>
              ))}
            </Pressable>
          </Pressable>
        </Modal>

        <Modal
          animationType="fade"
          onRequestClose={() => setIsAttachmentMenuVisible(false)}
          transparent
          visible={isAttachmentMenuVisible}
        >
          <Pressable onPress={() => setIsAttachmentMenuVisible(false)} style={styles.modalBackdrop}>
            <Pressable
            onPress={(event) => event.stopPropagation()}
            style={[styles.attachmentSheet, { paddingBottom: 18 + insets.bottom }]}
          >
              <View style={styles.sheetHandle} />
              <Text style={styles.sheetTitle}>Share something</Text>

              {/* One row that scrolls sideways rather than two rows stacked. Seven options wrapped onto a
                  phone are two rows, and the second row sits under the system navigation bar on a device
                  with gesture navigation: the options at the end of it cannot be pressed at all. Scrolling
                  sideways keeps every option on the same line, where the bottom padding below the row is
                  all that stands between it and the navigation bar. */}
              <ScrollView
                contentContainerStyle={styles.attachmentOptions}
                horizontal
                showsHorizontalScrollIndicator={false}
              >
                <Pressable accessibilityLabel="Send photos from your album" accessibilityRole="button" onPress={() => void pickMedia('album')} style={styles.attachmentOption}>
                  <View style={[styles.optionIcon, styles.albumOptionIcon]}>
                    <Ionicons color="#FFFFFF" name="images" size={21} />
                  </View>
                  <Text style={styles.optionLabel}>Album</Text>
                </Pressable>
                <Pressable accessibilityLabel="Send a video" accessibilityRole="button" onPress={() => void pickMedia('video')} style={styles.attachmentOption}>
                  <View style={[styles.optionIcon, styles.videoOptionIcon]}>
                    <Ionicons color="#FFFFFF" name="videocam" size={22} />
                  </View>
                  <Text style={styles.optionLabel}>Video</Text>
                </Pressable>
                <Pressable accessibilityLabel="Record a voice message" accessibilityRole="button" onPress={() => void startAudioRecording()} style={styles.attachmentOption}>
                  <View style={[styles.optionIcon, styles.audioOptionIcon]}>
                    <Ionicons color="#FFFFFF" name="mic" size={22} />
                  </View>
                  <Text style={styles.optionLabel}>Voice</Text>
                </Pressable>
                {/* A searchable set of gifs rather than the phone's own gallery. Opening the gallery to find an
                    animation means browsing a folder of photographs to find one, which is the wrong
                    tool: nobody keeps their reaction gifs in their camera roll. The device is still
                    there, one row down inside the picker, for anybody whose gif really is in there. */}
                <Pressable
                  accessibilityLabel="Search gifs"
                  accessibilityRole="button"
                  onPress={() => {
                    setIsAttachmentMenuVisible(false);
                    setIsGifPickerVisible(true);
                  }}
                  style={styles.attachmentOption}
                >
                  <View style={[styles.optionIcon, styles.gifOptionIcon]}>
                    <Text style={styles.gifIconText}>Gifs</Text>
                  </View>
                  <Text style={styles.optionLabel}>Gifs</Text>
                </Pressable>
                {/* A file is anything that is not a photo or a video, which is the whole difference
                    between this and the two options above it. */}
                <Pressable accessibilityLabel="Send a file" accessibilityRole="button" onPress={() => void pickMedia('file')} style={styles.attachmentOption}>
                  <View style={[styles.optionIcon, styles.fileOptionIcon]}>
                    <Ionicons color="#FFFFFF" name="document-text" size={21} />
                  </View>
                  <Text style={styles.optionLabel}>File</Text>
                </Pressable>
                {/* Neither of the last two uploads anything, so they work even where Storage is not
                    configured at all. */}
                <Pressable
                  accessibilityLabel="Share your location"
                  accessibilityRole="button"
                  onPress={() => void shareLocation()}
                  style={styles.attachmentOption}
                >
                  <View style={[styles.optionIcon, styles.locationOptionIcon]}>
                    <Ionicons color="#FFFFFF" name="location" size={21} />
                  </View>
                  <Text style={styles.optionLabel}>Place</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel="Share a contact"
                  accessibilityRole="button"
                  onPress={() => {
                    setIsAttachmentMenuVisible(false);
                    router.push({ params: { id: chatId }, pathname: '/chat/[id]/contacts' } as never);
                  }}
                  style={styles.attachmentOption}
                >
                  <View style={[styles.optionIcon, styles.contactOptionIcon]}>
                    <Ionicons color="#FFFFFF" name="person" size={21} />
                  </View>
                  <Text style={styles.optionLabel}>Contact</Text>
                </Pressable>
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>

        {/* The gif search. Opened from the attachment sheet, which closes first: it is one detour to a
            send, and leaving a sheet open underneath the next one is two things to dismiss for one
            choice. The chosen gif goes out through the same upload every other picture goes through,
            so it lands as a message and can be saved, forwarded and deleted like one. */}
        <GifPicker
          onClose={() => setIsGifPickerVisible(false)}
          onSelect={(gif) => {
            void sendGif(gif);
          }}
          onSendFromDevice={() => {
            void pickMedia('gif');
          }}
          visible={isGifPickerVisible}
        />

        {/* The photographs of an album, or the one photograph of a plain picture message. Its own modal
            rather than a sheet, because it has to cover the header, the composer and the keyboard: it is
            the place a reader goes to look at a picture properly, and anything of the conversation left
            showing under it is a distraction from exactly that. */}
        {openAlbum ? (
          <MediaViewer
            items={openAlbum.items}
            messageId={openAlbum.messageId}
            onClose={() => setOpenAlbum(null)}
            startIndex={openAlbum.startIndex}
          />
        ) : null}

      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  // Quieter than the typing line, because presence is background information rather than something
  // happening right now.
  statusLabel: {
    color: '#656A73',
    fontSize: 12,
    fontWeight: '600',
    minHeight: 15,
  },
  statusLabelTyping: {
    color: '#2FBF71',
    fontWeight: '700',
  },
  // Kept in the layout but invisible, so the header does not jump when typing starts and stops.
  typingLabelHidden: {
    opacity: 0,
  },
  container: {
    flex: 1,
    padding: 28,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  // The picture and the name, sharing one press. flex: 1 so it takes the space the buttons leave, and
  // minWidth 0 so the name inside it can shrink below the width of the text, which is what Android needs
  // before an ellipsis appears instead of the row overflowing. gap rather than a margin, so the picture
  // cannot be pressed on the side that belongs to the name.
  headerIdentity: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 10,
    minWidth: 0,
  },
  headerTitle: { flex: 1, minWidth: 0 },
  headerAvatar: {
    borderRadius: 19,
    height: 38,
    width: 38,
  },
  // The pictureless group. Sized to match headerAvatar exactly, so the row does not change height the
  // moment somebody sets a picture on the room.
  headerAvatarFallback: {
    alignItems: 'center',
    backgroundColor: '#E7E2DA',
    borderRadius: 19,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  headerIcon: {
    alignItems: 'center',
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  headerIconActive: {
    backgroundColor: '#E8F7EE',
  },
  pinnedBar: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 6,
    marginHorizontal: 16,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  pinnedText: {
    color: '#363A42',
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
  },
  composerContext: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderBottomLeftRadius: 10,
    borderBottomRightRadius: 10,
    borderColor: '#E7E2DA',
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginHorizontal: 20,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  composerContextText: {
    color: '#6C7079',
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
  },
  timerHint: {
    color: '#8D929C',
    fontSize: 11,
    marginBottom: 6,
    marginTop: 5,
    textAlign: 'center',
  },
  emojiSheet: {
    backgroundColor: '#F7F4EF',
    borderRadius: 20,
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 12,
  },
  emojiButton: {
    alignItems: 'center',
    borderRadius: 20,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  emojiGlyph: {
    fontSize: 26,
  },
  headerActions: {
    alignItems: 'center',
    flexDirection: 'row',
    // Space between the icons, and away from the edge of the screen on top of the
    // container padding, so neither is clipped by a rounded corner or a gesture bar.
    gap: 8,
    marginLeft: 'auto',
    marginRight: 12,
  },
  // Dark so a white icon reads on it. The white circle the phone button used to have made a
  // white glyph invisible on the same white fill.
  headerAction: {
    alignItems: 'center',
    backgroundColor: '#20232A',
    borderColor: '#20232A',
    borderRadius: 21,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  backButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 22,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  backText: {
    color: '#20232A',
    fontSize: 18,
    fontWeight: '800',
  },
  eyebrow: {
    color: '#E56B4C',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.6,
    marginBottom: 4,
  },
  title: {
    color: '#20232A',
    // A shade under the size it used to be: the header has a back button and two call buttons
    // to fit alongside, and a long chat id needs the extra room to stay readable.
    fontSize: 22,
    fontWeight: '800',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
  },
  emptyTitle: {
    color: '#20232A',
    fontSize: 30,
    fontWeight: '800',
    marginBottom: 10,
  },
  emptySubtitle: {
    color: '#656A73',
    fontSize: 16,
    lineHeight: 24,
  },
  conversation: {
    flex: 1,
    marginTop: 20,
  },
  messageList: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    paddingBottom: 16,
  },
  // The pressable around the list, which is what leaves reply and edit mode. Flex rather than a fixed
  // height, so the list still takes the whole conversation rather than whatever the rows happen to need.
  messageArea: {
    flex: 1,
  },
  emptyList: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  readOnlyBar: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
    padding: 12,
  },
  readOnlyText: {
    color: '#8D929C',
    flex: 1,
    fontSize: 13,
  },
  composer: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
    padding: 7,
  },
  attachmentButton: {
    alignItems: 'center',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  messageInput: {
    color: '#20232A',
    flex: 1,
    fontSize: 15,
    maxHeight: 100,
    minHeight: 40,
    paddingHorizontal: 5,
  },
  sendButton: {
    alignItems: 'center',
    backgroundColor: '#E56B4C',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  sendButtonDisabled: {
    opacity: 0.45,
  },
  recordingBar: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginBottom: 8,
    padding: 8,
  },
  recordingIndicator: {
    backgroundColor: '#B84141',
    borderRadius: 5,
    height: 10,
    width: 10,
  },
  recordingText: {
    color: '#363A42',
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
  },
  cancelRecordingButton: {
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  cancelRecordingText: {
    color: '#656A73',
    fontSize: 12,
    fontWeight: '700',
  },
  sendAudioButton: {
    alignItems: 'center',
    backgroundColor: '#E56B4C',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  loadError: {
    color: '#B84141',
    fontSize: 13,
    marginBottom: 8,
  },
  modalBackdrop: {
    backgroundColor: 'rgba(32, 35, 42, 0.35)',
    flex: 1,
    justifyContent: 'flex-end',
  },
  attachmentSheet: {
    backgroundColor: '#FFFDFC',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 22,
    paddingTop: 12,
  },
  // The bar that comes up over a long-pressed message. A strip along the bottom rather than a sheet of
  // rows: it has to fit over a conversation without hiding the message it is about, and six rows of text
  // would hide most of the screen.
  actionBar: {
    backgroundColor: '#FFFDFC',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    bottom: 0,
    elevation: 12,
    left: 0,
    paddingHorizontal: 12,
    paddingTop: 10,
    position: 'absolute',
    right: 0,
    shadowColor: '#10131A',
    shadowOffset: { height: -2, width: 0 },
    shadowOpacity: 0.16,
    shadowRadius: 10,
  },
  // Behind the conversation rather than over it, so the press that closes the menu is a press on the
  // conversation. Nothing draws on it, which is the point: it is a surface, not a layer.
  menuDismissLayer: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  actionBarTitle: {
    color: '#8D929C',
    fontSize: 12,
    marginBottom: 8,
    paddingHorizontal: 6,
  },
  actionBarContent: {
    gap: 4,
    paddingRight: 6,
  },
  actionBarButton: {
    alignItems: 'center',
    gap: 4,
    justifyContent: 'center',
    // A fixed width rather than the label's own, so a row of six is evenly spread and adding one does not
    // move the others.
    minWidth: 68,
    paddingVertical: 6,
  },
  actionBarLabel: {
    color: '#363A42',
    fontSize: 11,
    fontWeight: '600',
  },
  actionBarLabelDestructive: {
    color: '#E5484D',
  },
  // Where the reply, edit and translation answers sit. Two sheets rather than one screen each: both are
  // glances at the conversation underneath, and neither is somewhere to type.
  translateSheet: {
    backgroundColor: '#FFFDFC',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 18,
    paddingTop: 14,
  },
  translateRow: {
    alignItems: 'center',
    borderTopColor: '#E7E2DA',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 11,
    paddingVertical: 13,
  },
  translateRowText: {
    color: '#20232A',
    fontSize: 15,
    fontWeight: '600',
  },
  translateRowCancel: {
    color: '#8D929C',
  },
  peekRow: {
    alignItems: 'center',
    borderTopColor: '#E7E2DA',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 11,
    paddingVertical: 10,
  },
  peekInitial: {
    alignItems: 'center',
    backgroundColor: '#EAF3EE',
    borderRadius: 16,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  peekInitialText: {
    color: '#1F9D5B',
    fontSize: 14,
    fontWeight: '800',
  },
  peekName: {
    color: '#20232A',
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  translateBusy: {
    alignItems: 'center',
    gap: 10,
    paddingVertical: 30,
  },
  translateBusyText: {
    color: '#8D929C',
    fontSize: 14,
  },
  // Bounded rather than grown: a long message translated is a long answer, and the sheet must not push
  // its own copy button off the bottom of the screen.
  translateScroll: {
    maxHeight: 260,
  },
  translateOriginal: {
    color: '#8D929C',
    fontSize: 13,
    lineHeight: 19,
  },
  translateText: {
    color: '#20232A',
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 14,
    marginTop: 10,
  },
  translateCopy: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#2FBF71',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  translateCopyText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  sheetHandle: {
    alignSelf: 'center',
    backgroundColor: '#D3D1CD',
    borderRadius: 2,
    height: 4,
    marginBottom: 18,
    width: 38,
  },
  sheetTitle: {
    color: '#20232A',
    fontSize: 17,
    fontWeight: '800',
    marginBottom: 20,
  },
  attachmentOptions: {
    gap: 14,
    paddingRight: 6,
  },
  attachmentOption: {
    alignItems: 'center',
    gap: 8,
    width: 66,
  },
  optionIcon: {
    alignItems: 'center',
    borderRadius: 23,
    height: 46,
    justifyContent: 'center',
    width: 46,
  },
  imageOptionIcon: {
    backgroundColor: '#3D765B',
  },
  albumOptionIcon: {
    backgroundColor: '#2E7D5B',
  },
  videoOptionIcon: {
    backgroundColor: '#E56B4C',
  },
  audioOptionIcon: {
    backgroundColor: '#20232A',
  },
  gifOptionIcon: {
    backgroundColor: '#D5A32E',
  },
  fileOptionIcon: {
    backgroundColor: '#4A6FA5',
  },
  locationOptionIcon: {
    backgroundColor: '#2E9E6B',
  },
  contactOptionIcon: {
    backgroundColor: '#8A63B8',
  },
  gifIconText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
  },
  optionLabel: {
    color: '#363A42',
    fontSize: 12,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.72,
  },
});
