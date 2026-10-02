import { Ionicons } from '@expo/vector-icons';
import { getDocs, limit, query, collection } from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { getFirebaseDb } from '@/lib/firebase';
import { getString, UserData } from '@/lib/user-data';

const MUTED = '#8E8E93';
const DIVIDER = '#EFEFF0';
const POST_RED = '#FE2C55';

// How many user documents are pulled for the picker. Firestore has no partial text search, so the
// list has to be fetched and filtered on the device, and a hard ceiling is what stops that from
// turning into a download of the entire user table on a large account. Someone past the ceiling is
// not findable here, which is a real limit and worth saying out loud rather than hanging.
const MAX_USERS = 200;

export interface MentionUser {
  /** The user document id, which is what gets stored on the post. */
  id: string;
  name: string;
  photoUrl: string;
}

interface MentionSheetProps {
  currentUserId: string;
  onClose: () => void;
  /** Called on every tap. The sheet stays open so several people can be picked in one go. */
  onToggle: (user: MentionUser) => void;
  selectedIds: string[];
  visible: boolean;
}

/**
 * Picks people to mention in a post.
 *
 * A sheet rather than a screen because the caption being written has to stay visible: the whole
 * point of a mention is that it lands in a sentence. No blur, in line with every other sheet in
 * the app: a solid white surface over a dimmed backdrop, which costs no extra native view.
 */
export function MentionSheet({
  currentUserId,
  onClose,
  onToggle,
  selectedIds,
  visible,
}: MentionSheetProps) {
  const [users, setUsers] = useState<MentionUser[]>([]);
  // 'loading' is the initial value rather than something set when the effect runs, so there is no
  // state written during the effect itself. Reopening the sheet refetches quietly over the list
  // that is already on screen, which beats flashing a spinner at someone who reopened it a second
  // later to change their mind about one person.
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [search, setSearch] = useState('');
  const [photoFailures, setPhotoFailures] = useState<Record<string, boolean>>({});

  // Loaded when the sheet opens rather than with the screen: a post that is never mentioned should
  // not pay for the query, and reopening the sheet re-reads so a name changed elsewhere shows up.
  useEffect(() => {
    if (!visible) {
      return undefined;
    }

    let isCancelled = false;

    void (async () => {
      try {
        const snapshot = await getDocs(
          query(collection(getFirebaseDb(), 'users'), limit(MAX_USERS)),
        );
        const loaded: MentionUser[] = [];

        snapshot.forEach((userDocument) => {
          // Mentioning yourself is never what the tap meant, and the row would otherwise sit at the
          // top of your own search results.
          if (userDocument.id === currentUserId) {
            return;
          }

          const data = userDocument.data() as UserData;

          loaded.push({
            id: userDocument.id,
            name: getString(data, ['displayName', 'name', 'username'], 'Unknown user'),
            photoUrl: getString(data, ['profilePictureUrl', 'photoURL', 'photoUrl', 'avatarUrl']),
          });
        });

        // Alphabetical, so the list is in a predictable order before anything is typed. The search
        // below then reorders it to put the matches first.
        loaded.sort((first, second) => first.name.localeCompare(second.name));

        if (!isCancelled) {
          setUsers(loaded);
          setErrorMessage('');
          setStatus('ready');
        }
      } catch (error) {
        console.error('Could not load the people to mention:', error);
        if (!isCancelled) {
          setErrorMessage('Could not load people. Please try again in a moment.');
          setStatus('error');
        }
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [currentUserId, visible]);

  // The search runs on the device against the fetched list, which is why MAX_USERS is a ceiling
  // rather than a suggestion. A prefix match is tried first so typing the start of a name puts the
  // people you mean at the top, with a contains match after it for anything in the middle.
  const visibleUsers = useMemo(() => {
    const term = search.trim().toLowerCase();

    if (!term) {
      return users;
    }

    const startsWith: MentionUser[] = [];
    const contains: MentionUser[] = [];

    users.forEach((user) => {
      const name = user.name.toLowerCase();

      if (name.startsWith(term)) {
        startsWith.push(user);
      } else if (name.includes(term)) {
        contains.push(user);
      }
    });

    return [...startsWith, ...contains];
  }, [search, users]);

  const onClearSearch = useCallback(() => setSearch(''), []);

  const isLoading = status === 'loading';

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.root}>
        <Pressable accessibilityLabel="Close mentions" onPress={onClose} style={styles.backdrop} />

        <View style={styles.sheet}>
          <View style={styles.handle} />

          <View style={styles.headerRow}>
            <Text style={styles.title}>Mention people</Text>

            {/* Closes without discarding: the taps have already been applied to the caption as
                they were made, so this is only getting out of the way. */}
            <Pressable
              accessibilityLabel="Done mentioning"
              accessibilityRole="button"
              onPress={onClose}
              style={({ pressed }) => [styles.doneButton, pressed && styles.pressed]}
            >
              <Text style={styles.doneLabel}>Done</Text>
            </Pressable>
          </View>

          <View style={styles.searchRow}>
            <Ionicons color={MUTED} name="search" size={17} />
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setSearch}
              placeholder="Search by name"
              placeholderTextColor={MUTED}
              returnKeyType="search"
              style={styles.searchInput}
              value={search}
            />
            {search ? (
              <Pressable
                accessibilityLabel="Clear search"
                hitSlop={8}
                onPress={onClearSearch}
                style={styles.clearSearch}
              >
                <Ionicons color={MUTED} name="close-circle" size={17} />
              </Pressable>
            ) : null}
          </View>

          {isLoading ? (
            <View style={styles.statusRow}>
              <ActivityIndicator color={POST_RED} />
            </View>
          ) : (
            <FlatList
              data={visibleUsers}
              keyboardShouldPersistTaps="handled"
              // The rows are a fixed height, so telling the list so up front keeps it from
              // measuring every one of them on the way to the viewport.
              getItemLayout={(_, index) => ({ index, length: 64, offset: 64 * index })}
              keyExtractor={(user) => user.id}
              ListEmptyComponent={
                <Text style={styles.emptyText}>
                  {errorMessage || (search ? 'Nobody matches that name.' : 'No one to mention yet.')}
                </Text>
              }
              renderItem={({ item }) => {
                const isSelected = selectedIds.includes(item.id);
                const hasPhoto = Boolean(item.photoUrl) && !photoFailures[item.id];

                return (
                  <Pressable
                    accessibilityLabel={`Mention ${item.name}`}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: isSelected }}
                    onPress={() => onToggle(item)}
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  >
                    <View style={styles.avatar}>
                      {hasPhoto ? (
                        <Image
                          onError={() => setPhotoFailures((current) => ({ ...current, [item.id]: true }))}
                          source={{ uri: item.photoUrl }}
                          style={styles.avatarImage}
                        />
                      ) : (
                        // The initial stands in for a missing or broken avatar, so a row is never
                        // just an empty circle with a name beside it.
                        <Text style={styles.avatarInitial}>{item.name.trim().charAt(0).toUpperCase()}</Text>
                      )}
                    </View>

                    <Text numberOfLines={1} style={styles.rowName}>
                      {item.name}
                    </Text>

                    <Ionicons
                      color={isSelected ? POST_RED : '#D1D1D6'}
                      name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                      size={22}
                    />
                  </Pressable>
                );
              }}
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { backgroundColor: 'rgba(0, 0, 0, 0.35)', flex: 1 },
  // Tall enough to be a list rather than a dialog, and short of the full screen so the caption
  // being mentioned stays visible above it.
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    height: '72%',
    overflow: 'hidden',
    paddingTop: 8,
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: '#D1D1D6',
    borderRadius: 2,
    height: 4,
    marginBottom: 10,
    width: 40,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  title: { color: '#111111', fontSize: 16, fontWeight: '800' },
  doneButton: { padding: 4 },
  doneLabel: { color: POST_RED, fontSize: 15, fontWeight: '700' },
  searchRow: {
    alignItems: 'center',
    backgroundColor: '#F2F2F4',
    borderRadius: 10,
    flexDirection: 'row',
    gap: 8,
    marginHorizontal: 16,
    marginVertical: 12,
    paddingHorizontal: 12,
  },
  searchInput: {
    color: '#111111',
    flex: 1,
    fontSize: 15,
    minHeight: 42,
    paddingVertical: 0,
  },
  clearSearch: { padding: 2 },
  statusRow: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  row: {
    alignItems: 'center',
    borderBottomColor: DIVIDER,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    height: 64,
    paddingHorizontal: 16,
  },
  rowPressed: { backgroundColor: '#F7F7F8' },
  avatar: {
    alignItems: 'center',
    backgroundColor: '#E5E5EA',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 40,
  },
  avatarImage: { height: '100%', width: '100%' },
  avatarInitial: { color: '#6B6B70', fontSize: 16, fontWeight: '700' },
  rowName: { color: '#111111', flex: 1, fontSize: 15, fontWeight: '600' },
  emptyText: { color: MUTED, fontSize: 13, padding: 24, textAlign: 'center' },
  pressed: { opacity: 0.6 },
});
