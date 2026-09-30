import { Ionicons } from '@expo/vector-icons';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  addComment,
  deleteComment,
  formatCommentTime,
  listenToComments,
  MAX_COMMENT_LENGTH,
  PostComment,
} from '@/lib/comments';
import { getFirebaseAuth, getFirebaseDb, isFirestorePermissionError } from '@/lib/firebase';
import { getString } from '@/lib/user-data';

interface CommentSheetProps {
  onClose: () => void;
  postId: string;
  // The counter the feed keeps on the post document, which stays right even when the list
  // below only holds the newest page of a long thread.
  totalCount: number;
  visible: boolean;
}

// The viewer name is read from the profile once per session and reused, because every sheet
// opens over a post the viewer already knows they are.
let cachedViewerName = '';
let pendingViewerName: Promise<string> | null = null;

function readViewerName(uid: string) {
  if (cachedViewerName) {
    return Promise.resolve(cachedViewerName);
  }

  pendingViewerName ??= (async () => {
    try {
      const snapshot = await getDoc(doc(getFirebaseDb(), 'users', uid));
      const data = snapshot.exists() ? snapshot.data() : {};
      const name = getString(data, ['displayName', 'name', 'username']);

      if (name) {
        cachedViewerName = name;
      }

      return cachedViewerName;
    } catch (error) {
      console.error('Could not load the profile name:', error);
      return '';
    } finally {
      pendingViewerName = null;
    }
  })();

  return pendingViewerName;
}

// Nothing is mounted while the sheet is closed, so the listener, the draft and the list all
// start fresh every time it opens and nothing has to be reset when it closes.
export function CommentSheet({ onClose, postId, totalCount, visible }: CommentSheetProps) {
  if (!visible || !postId) {
    return null;
  }

  return <CommentSheetModal onClose={onClose} postId={postId} totalCount={totalCount} />;
}

function CommentSheetModal({
  onClose,
  postId,
  totalCount,
}: {
  onClose: () => void;
  postId: string;
  totalCount: number;
}) {
  const insets = useSafeAreaInsets();
  const [viewer, setViewer] = useState<User | null>(null);
  const [comments, setComments] = useState<PostComment[]>([]);
  const [draft, setDraft] = useState('');
  const [replyToName, setReplyToName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isDenied, setIsDenied] = useState(false);
  const listRef = useRef<FlatList<PostComment>>(null);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    let unsubscribe = () => {};

    try {
      unsubscribe = onAuthStateChanged(getFirebaseAuth(), setViewer);
    } catch (error) {
      console.error('Firebase auth is unavailable:', error);
    }

    return unsubscribe;
  }, []);

  // The listener only lives as long as the sheet, so a feed that is never commented on never
  // pays for a comments query per post.
  useEffect(() => listenToComments(
    postId,
    (next) => {
      setComments(next);
      setIsLoading(false);
      setIsDenied(false);
    },
    (error) => {
      setIsLoading(false);

      if (isFirestorePermissionError(error)) {
        setIsDenied(true);
        console.warn(
          `Reading posts/${postId}/comments was denied. Add a match for that path in `
          + 'firestore.rules, then redeploy with: firebase deploy --only firestore:rules',
        );
        return;
      }

      console.error('Could not watch comments:', error);
      Alert.alert('Comments unavailable', 'Please try again in a moment.');
    },
  ), [postId]);

  const startReply = useCallback((comment: PostComment) => {
    setReplyToName(comment.displayName);
    // The keyboard opens straight away, so a reply is one tap from being typed.
    inputRef.current?.focus();
  }, []);

  const cancelReply = useCallback(() => {
    setReplyToName(null);
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();

    if (!text || !viewer || isSending) {
      return;
    }

    setIsSending(true);

    try {
      const displayName = (await readViewerName(viewer.uid))
        || viewer.displayName
        || viewer.uid.slice(0, 8);

      await addComment(postId, {
        displayName,
        replyToName: replyToName ?? undefined,
        text,
        userId: viewer.uid,
      });

      // The counter on the post document is written in the same transaction, so the count
      // next to the comment icon follows on its own through the feed listener.
      setDraft('');
      setReplyToName(null);
      // Newest first, so the comment just sent is already the top row; scrolling is only
      // needed when the list was not at the top yet.
      listRef.current?.scrollToOffset({ animated: true, offset: 0 });
    } catch (error) {
      if (isFirestorePermissionError(error)) {
        setIsDenied(true);
        Alert.alert(
          'Not allowed yet',
          'The deployed Firestore rules do not allow posts/{postId}/comments. Add a match for that path in firestore.rules, redeploy, and try again.',
        );
        return;
      }

      console.error('Could not send the comment:', error);
      Alert.alert('Comment not sent', 'Please check your connection and try again.');
    } finally {
      setIsSending(false);
    }
  }, [draft, isSending, postId, replyToName, viewer]);

  const remove = useCallback(async (comment: PostComment) => {
    if (comment.userId !== viewer?.uid) {
      return;
    }

    try {
      await deleteComment(postId, comment.id);
    } catch (error) {
      if (isFirestorePermissionError(error)) {
        Alert.alert(
          'Not allowed yet',
          'The deployed Firestore rules do not allow deleting comments. Deploy the updated firestore.rules and try again.',
        );
        return;
      }

      console.error('Could not delete the comment:', error);
      Alert.alert('Could not delete', 'Please try again in a moment.');
    }
  }, [postId, viewer?.uid]);

  const renderComment = useCallback(({ item }: { item: PostComment }) => (
    <View style={styles.row}>
      <View style={styles.avatar}>
        <Text style={styles.avatarLetter}>{item.displayName.charAt(0).toUpperCase()}</Text>
      </View>

      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={styles.rowName}>{item.displayName}</Text>

        {item.replyToName ? (
          <Text numberOfLines={2} style={styles.rowText}>
            {`@${item.replyToName} `}
            <Text style={styles.rowTextPlain}>{item.text}</Text>
          </Text>
        ) : (
          <Text style={styles.rowTextPlain}>{item.text}</Text>
        )}

        <View style={styles.rowMeta}>
          <Text style={styles.rowTime}>{formatCommentTime(item.createdAt)}</Text>
          {item.userId === viewer?.uid ? (
            <Pressable
              accessibilityLabel="Delete comment"
              accessibilityRole="button"
              onPress={() => void remove(item)}
              style={styles.rowAction}
            >
              <Text style={styles.rowActionText}>Delete</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityLabel={`Reply to ${item.displayName}`}
              accessibilityRole="button"
              onPress={() => startReply(item)}
              style={styles.rowAction}
            >
              <Text style={styles.rowActionText}>Reply</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  ), [remove, startReply, viewer?.uid]);

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      // The video or photo stays visible above the sheet, so the backdrop only dims it
      // lightly instead of covering the post.
      statusBarTranslucent
      transparent
      visible
    >
      <View style={styles.root}>
        <Pressable accessibilityLabel="Close comments" onPress={onClose} style={styles.backdrop} />

        <View style={styles.sheet}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={0}
            style={styles.sheetInner}
          >
            <View style={styles.header}>
              <View style={styles.handle} />
              <View style={styles.headerRow}>
                <Text style={styles.title}>
                  {totalCount > 0 ? `${totalCount} ${totalCount === 1 ? 'comment' : 'comments'}` : 'Comments'}
                </Text>
                <Pressable
                  accessibilityLabel="Close comments"
                  accessibilityRole="button"
                  onPress={onClose}
                  style={styles.closeButton}
                >
                  <Ionicons color="#FFFFFF" name="close" size={22} />
                </Pressable>
              </View>
            </View>

            {isDenied ? (
              <View style={styles.notice}>
                <Text style={styles.noticeText}>
                  Comments are not available with the deployed Firestore rules. Add a match for posts/{'{'}postId{'}'}/comments, then redeploy.
                </Text>
              </View>
            ) : null}

            {isLoading ? (
              <View style={styles.notice}>
                <ActivityIndicator color="#FFFFFF" />
              </View>
            ) : comments.length === 0 ? (
              <View style={styles.notice}>
                <Text style={styles.noticeText}>No comments yet. Be the first.</Text>
              </View>
            ) : (
              <FlatList
                contentContainerStyle={styles.listContent}
                data={comments}
                keyboardShouldPersistTaps="handled"
                keyExtractor={(item) => item.id}
                ListFooterComponent={<View style={styles.listFooter} />}
                ref={listRef}
                renderItem={renderComment}
              />
            )}

            <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
              {replyToName ? (
                <View style={styles.replyBanner}>
                  <Text numberOfLines={1} style={styles.replyBannerText}>
                    {`Replying to @${replyToName}`}
                  </Text>
                  <Pressable
                    accessibilityLabel="Cancel reply"
                    accessibilityRole="button"
                    onPress={cancelReply}
                    style={styles.replyCancel}
                  >
                    <Ionicons color="#FFFFFF" name="close" size={16} />
                  </Pressable>
                </View>
              ) : null}

              <View style={styles.composerRow}>
                <TextInput
                  editable={!isSending}
                  maxLength={MAX_COMMENT_LENGTH}
                  onChangeText={setDraft}
                  onSubmitEditing={() => void send()}
                  placeholder="Add a comment..."
                  placeholderTextColor="#9CA3AF"
                  ref={inputRef}
                  returnKeyType="send"
                  style={styles.input}
                  value={draft}
                />

                <Pressable
                  accessibilityLabel="Send comment"
                  accessibilityRole="button"
                  disabled={isSending || !draft.trim() || isDenied}
                  onPress={() => void send()}
                  style={({ pressed }) => [
                    styles.sendButton,
                    pressed && styles.sendButtonPressed,
                    (!draft.trim() || isSending || isDenied) && styles.sendButtonDisabled,
                  ]}
                >
                  {isSending ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Ionicons color="#FFFFFF" name="arrow-up" size={20} />
                  )}
                </Pressable>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  // The pressable only covers the area above the sheet, so a tap on the list is not read as
  // a dismissal and the list scrolls like any other flat list.
  backdrop: { backgroundColor: 'rgba(0, 0, 0, 0.35)', flex: 1 },
  sheet: {
    backgroundColor: '#111827',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    maxHeight: '72%',
    overflow: 'hidden',
  },
  sheetInner: { flexShrink: 1 },
  header: { paddingTop: 8, paddingHorizontal: 16 },
  handle: {
    alignSelf: 'center',
    backgroundColor: '#4B5563',
    borderRadius: 2,
    height: 4,
    marginBottom: 10,
    width: 40,
  },
  headerRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  title: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  closeButton: { padding: 4 },
  notice: { alignItems: 'center', paddingHorizontal: 20, paddingVertical: 28 },
  noticeText: { color: '#9CA3AF', fontSize: 13, textAlign: 'center' },
  listContent: { paddingHorizontal: 16, paddingTop: 12 },
  listFooter: { height: 8 },
  row: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  avatar: {
    alignItems: 'center',
    backgroundColor: '#1E3A8A',
    borderRadius: 16,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  avatarLetter: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  rowBody: { flex: 1, minWidth: 0 },
  rowName: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  rowText: { color: '#60A5FA', fontSize: 14, lineHeight: 19 },
  rowTextPlain: { color: '#E5E7EB', fontSize: 14, lineHeight: 19 },
  rowMeta: { alignItems: 'center', flexDirection: 'row', gap: 12, marginTop: 4 },
  rowTime: { color: '#6B7280', fontSize: 12 },
  rowAction: { paddingVertical: 2 },
  rowActionText: { color: '#9CA3AF', fontSize: 12, fontWeight: '700' },
  composer: {
    backgroundColor: '#0B1220',
    borderTopColor: '#1F2937',
    borderTopWidth: 1,
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  replyBanner: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 8,
  },
  replyBannerText: { color: '#60A5FA', flex: 1, fontSize: 12, fontWeight: '700' },
  replyCancel: { padding: 2 },
  composerRow: { alignItems: 'flex-end', flexDirection: 'row', gap: 8 },
  input: {
    backgroundColor: '#1F2937',
    borderRadius: 20,
    color: '#FFFFFF',
    flex: 1,
    fontSize: 14,
    maxHeight: 96,
    minHeight: 42,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  sendButton: {
    alignItems: 'center',
    backgroundColor: '#2563EB',
    borderRadius: 21,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  sendButtonPressed: { opacity: 0.72 },
  sendButtonDisabled: { opacity: 0.4 },
});
