import Slider from '@react-native-community/slider';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import {
  collection,
  doc,
  endAt,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAt,
} from 'firebase/firestore';
import {
  distanceBetween,
  geohashForLocation,
  geohashQueryBounds,
} from 'geofire-common';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PersonAvatar } from '@/components/person-avatar';
import { createRoom } from '@/lib/chat-rooms';
import { getFirebaseAuth, getFirebaseDb, isFirestorePermissionError, isRealtimeDatabaseConfigured } from '@/lib/firebase';
import { loadFollowIds, setFollowing } from '@/lib/follow';
import { PresenceMap, subscribeToPresence } from '@/lib/presence';
import { getAge, getCoordinates, getString, UserData } from '@/lib/user-data';

/**
 * Somebody's profile, opened from a row here.
 *
 * The row used to start the conversation instead, in one tap. It opens the profile now, because that
 * is the screen that answers "who is this and what have they posted", and the profile's Message button
 * is the conversation -- one more tap, in exchange for being able to look before you talk.
 */
function openProfile(userId: string, displayName: string) {
  router.push({ params: { name: displayName, uid: userId }, pathname: '/user/[uid]' } as never);
}

type Friend = {
  age: number | null;
  city: string;
  displayName: string;
  id: string;
  photoUrl: string;
  distanceKm: number;
};

const MIN_AGE = 18;
const MAX_AGE = 80;
const SEARCH_RADIUS_KM = 50;
const RESULTS_LIMIT = 20;

// Stands in for "not loaded yet", so the rows keep a stable set between reads instead of a new one on
// every render.
const NO_FOLLOWING = new Set<string>();

async function resolveCurrentCoordinates(): Promise<[number, number] | null> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== 'granted') {
    return null;
  }

  const position = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.Balanced,
  });

  return [position.coords.latitude, position.coords.longitude];
}

async function queryFriendsNearby(
  center: [number, number],
  currentUserId: string,
): Promise<Friend[]> {
  const db = getFirebaseDb();
  const bounds = geohashQueryBounds(center, SEARCH_RADIUS_KM * 1000);
  const snapshots = await Promise.all(bounds.map(([start, end]) => getDocs(query(
    collection(db, 'users'),
    orderBy('geohash'),
    startAt(start),
    endAt(end),
  ))));

  const friendsById = new Map<string, Friend>();

  snapshots.forEach((usersSnapshot) => {
    usersSnapshot.docs.forEach((userDocument) => {
      if (userDocument.id === currentUserId) {
        return;
      }

      const userData = userDocument.data() as UserData;
      const coordinates = getCoordinates(userData);
      if (!coordinates) {
        return;
      }

      const distanceKm = distanceBetween(coordinates, center);
      if (distanceKm > SEARCH_RADIUS_KM) {
        return;
      }

      friendsById.set(userDocument.id, {
        age: getAge(userData),
        city: getString(userData, ['city', 'country']),
          displayName: getString(userData, ['displayName', 'name', 'username'], 'Someone new'),

        distanceKm,
        id: userDocument.id,
        photoUrl: getString(userData, ['profilePictureUrl', 'photoURL', 'photoUrl', 'avatarUrl']),
      });
    });
  });

  return [...friendsById.values()].sort((first, second) => first.distanceKm - second.distanceKm);
}

export default function FindFriendsScreen() {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [minimumAge, setMinimumAge] = useState(MIN_AGE);
  const [maximumAge, setMaximumAge] = useState(MAX_AGE);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingFriendId, setPendingFriendId] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [photoFailures, setPhotoFailures] = useState<string[]>([]);
  const [coordinates, setCoordinates] = useState<[number, number] | null>(null);
  // Group creation is a mode rather than a separate screen, so the list keeps working as it does
  // for one-to-one chats and nothing changes until the mode is explicitly entered.
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Who is online, read from Realtime Database rather than from the profile document: presence is
  // per connection and changes every few seconds, and a value written on a profile would be a
  // snapshot that nothing ever corrects. There is no `isOnline` field on a profile to read, so the
  // row showed "Offline" for everybody, always.
  const [presence, setPresence] = useState<PresenceMap>({});
  // Who this account already follows, so a row says Following rather than offering it again. Read once
  // rather than per row: these are the same people for every row, and one permission failure would
  // otherwise be one failure per row.
  const [followingIds, setFollowingIds] = useState<Set<string>>(NO_FOLLOWING);

  const loadFriends = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage('');

    try {
      const currentUser = getFirebaseAuth().currentUser;
      if (!currentUser) {
        setFriends([]);
        setErrorMessage('Please log in to find people near you.');
        return;
      }

      const center = await resolveCurrentCoordinates();
      if (!center) {
        setFriends([]);
        setErrorMessage('Allow location access to find people within 50 km.');
        return;
      }

      setCoordinates(center);

      // Friends search is geohash based, so this user needs a geohash of their own.
      await setDoc(doc(getFirebaseDb(), 'users', currentUser.uid), {
        geohash: geohashForLocation(center),
        latitude: center[0],
        longitude: center[1],
        locationUpdatedAt: serverTimestamp(),
      }, { merge: true });

      setFriends(await queryFriendsNearby(center, currentUser.uid));
      setFollowingIds(await loadFollowIds(currentUser.uid));
      setPhotoFailures([]);
    } catch (error) {
      console.error('Could not load the people nearby:', error);
      setErrorMessage('Could not load people near you. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void loadFriends(), 0);
    return () => clearTimeout(timer);
  }, [loadFriends]);

  const visibleFriends = friends.filter((friend) => (
    friend.age !== null && friend.age >= minimumAge && friend.age <= maximumAge
  )).slice(0, RESULTS_LIMIT);

  // The visible ids as one string, so the subscription below is not torn down and rebuilt on every
  // render. The list is filtered and sorted the same way every time, so this string only changes when
  // the set of people on screen actually does.
  const visibleFriendIds = visibleFriends.map((friend) => friend.id).join(',');
  const presenceAvailable = isRealtimeDatabaseConfigured();

  useEffect(
    () => subscribeToPresence(visibleFriendIds ? visibleFriendIds.split(',') : [], setPresence),
    [visibleFriendIds],
  );

  /**
   * Follows somebody from the list, so the relationship does not need a detour through their profile.
   *
   * The row is added to the set rather than re-read: this screen already holds the whole list of people
   * it is showing, and one write that succeeded should not cost another read to find out.
   */
  const toggleFollow = async (friendId: string) => {
    const currentUser = getFirebaseAuth().currentUser;
    if (!currentUser || pendingFriendId) {
      return;
    }

    setPendingFriendId(friendId);

    try {
      await setFollowing(currentUser.uid, friendId, true);
      setFollowingIds((current) => new Set(current).add(friendId));
    } catch (error) {
      console.error('Could not follow:', error);
      setErrorMessage(
        isFirestorePermissionError(error)
          ? 'Following is not allowed with the deployed Firestore rules. Deploy firestore.rules and try again.'
          : 'Could not follow. Please check your connection and try again.',
      );
    } finally {
      setPendingFriendId('');
    }
  };

  const toggleSelected = useCallback((friendId: string) => {
    setSelectedIds((current) => (
      current.includes(friendId)
        ? current.filter((id) => id !== friendId)
        : [...current, friendId]
    ));
  }, []);

  const cancelGroupSelection = useCallback(() => {
    setIsSelecting(false);
    setSelectedIds([]);
  }, []);

  /**
   * Creates one room with everybody selected plus this account.
   *
   * A single document with more than two participants, which is what the chat list calls a group and
   * what the security rules allow: the participant list has to have at least two entries in it, and
   * the list cannot be changed afterwards, so a room can never quietly acquire somebody new.
   *
   * No duplicate check, unlike the one-to-one path. "The same group" is not a well defined question
   * once a room has three or more people and any one of them may have started it, so matching
   * exactly would more often block a legitimate second conversation than prevent a real duplicate.
   */
  const startGroupChat = useCallback(async () => {
    const currentUser = getFirebaseAuth().currentUser;

    if (!currentUser || selectedIds.length === 0 || pendingFriendId) {
      return;
    }

    setPendingFriendId('group');

    try {
      // Taken from the visible list rather than from ids alone, because a name is needed and only the
      // row has one. A friend filtered out by the age range since being picked is dropped rather than
      // added nameless.
      const members = visibleFriends.filter((friend) => selectedIds.includes(friend.id));

      if (members.length === 0) {
        setErrorMessage('None of the selected friends are available any more.');

        return;
      }

      await createRoom({
        kind: 'group',
        name: members.map((member) => member.displayName).join(', '),
        participantIds: members.map((member) => member.id),
      });

      cancelGroupSelection();
      // Landed on the list rather than inside the new room: a group opens empty, and the list is where
      // the person goes to see that it was made. The row is at the top because it was just written.
      router.replace('/(tabs)/chat' as never);
    } catch (error) {
      console.error('Could not start a group chat:', error);
      setErrorMessage('Could not start a group chat. Please try again in a moment.');
    } finally {
      setPendingFriendId('');
    }
  }, [cancelGroupSelection, pendingFriendId, selectedIds, visibleFriends]);

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <View style={styles.screen}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>MEET SOMEONE NEW</Text>
            {/* The title doubles as the way out of selection mode, so the mode can always be
                left from the same place it was entered. */}
            <Text onPress={isSelecting ? cancelGroupSelection : undefined} style={styles.title}>
              {isSelecting ? 'Select people' : 'Find people'}
            </Text>
          </View>

          {/* Only offered when there is somebody to add, since a group of one is a conversation with
              yourself and the rules would refuse the write anyway. */}
          {!isSelecting && visibleFriends.length > 0 ? (
            <Pressable
              accessibilityLabel="Start a group chat"
              accessibilityRole="button"
              onPress={() => setIsSelecting(true)}
              style={({ pressed }) => [styles.groupButton, pressed && styles.rowPressed]}
            >
              <Text style={styles.groupButtonText}>New group</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel="Refresh the people nearby"
            accessibilityRole="button"
            onPress={() => void loadFriends()}
            style={styles.iconButton}
          >
            <Text style={styles.refreshText}>{'\u21BB'}</Text>
          </Pressable>
        </View>

        <View style={styles.filterSection}>
          <View style={styles.filterHeader}>
            <Text style={styles.filterTitle}>Age range</Text>
            <Text style={styles.ageRange}>{minimumAge} - {maximumAge}</Text>
          </View>

          <View style={styles.sliderGroup}>
            <Text style={styles.sliderCaption}>Minimum age</Text>
            <Slider
              maximumValue={maximumAge}
              minimumTrackTintColor="#E56B4C"
              minimumValue={MIN_AGE}
              onValueChange={(value) => setMinimumAge(Math.min(Math.round(value), maximumAge))}
              step={1}
              style={styles.slider}
              thumbTintColor="#E56B4C"
              value={minimumAge}
            />
          </View>

          <View style={styles.sliderGroup}>
            <Text style={styles.sliderCaption}>Maximum age</Text>
            <Slider
              maximumValue={MAX_AGE}
              minimumTrackTintColor="#3D765B"
              minimumValue={minimumAge}
              onValueChange={(value) => setMaximumAge(Math.max(Math.round(value), minimumAge))}
              step={1}
              style={styles.slider}
              thumbTintColor="#3D765B"
              value={maximumAge}
            />
          </View>
        </View>

        <View style={styles.resultHeader}>
          <Text style={styles.resultTitle}>People to meet</Text>
          <View style={styles.resultMeta}>
            {coordinates ? (
              <Text style={styles.coordinateText}>
                {coordinates[0].toFixed(3)}, {coordinates[1].toFixed(3)}
              </Text>
            ) : null}
            {!isLoading && !errorMessage ? (
              <Text style={styles.resultCount}>{visibleFriends.length}</Text>
            ) : null}
          </View>
        </View>

        {isLoading ? (
          <View style={styles.stateContainer}>
            <ActivityIndicator color="#E56B4C" size="large" />
            <Text style={styles.stateText}>Looking for people nearby...</Text>
          </View>
        ) : errorMessage ? (
          <View style={styles.stateContainer}>
            <Text style={styles.stateTitle}>Nobody nearby</Text>
            <Text style={styles.stateText}>{errorMessage}</Text>
            <Pressable onPress={() => void loadFriends()} style={styles.retryButton}>
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        ) : visibleFriends.length === 0 ? (
          <View style={styles.stateContainer}>
            <Text style={styles.stateTitle}>
              {friends.length ? 'No matches in this age range' : 'Nobody nearby to show yet'}
            </Text>
            <Text style={styles.stateText}>Widen the age range or come back later.</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
            {visibleFriends.map((friend) => {
              const isPending = pendingFriendId === friend.id;
              const showPhoto = Boolean(friend.photoUrl) && !photoFailures.includes(friend.id);
              const isSelected = selectedIds.includes(friend.id);
              // Presence defaults to false rather than being guessed, so a missing database costs the
              // green dot and not the row.
              const isOnline = presence[friend.id] === true;

              return (
    <Pressable
      accessibilityLabel={
        isSelecting
          ? `${isSelected ? 'Remove' : 'Add'} ${friend.displayName} ${isSelected ? 'from' : 'to'} the group`
          : `Open ${friend.displayName}'s profile`
      }
      accessibilityRole="button"
      accessibilityState={{ checked: isSelecting ? isSelected : undefined }}
      disabled={Boolean(pendingFriendId)}
      key={friend.id}
      // In selection mode a tap picks somebody instead of opening a profile, which is the whole
      // difference between the two modes.
      onPress={() => (isSelecting ? toggleSelected(friend.id) : openProfile(friend.id, friend.displayName))}
      style={({ pressed }) => [
        styles.row,
        isSelecting && isSelected && styles.rowSelected,
        pressed && styles.rowPressed,
      ]}
    >
      <View style={styles.avatarWrap}>
        {/* The light comes from the avatar itself now, and is drawn only when that person is online. There
            used to be a dot here that was grey when they were not, which claimed to know more than the
            build could: a missed heartbeat and a person who has gone out look identical. */}
        <PersonAvatar
          isOnline={isOnline}
          name={friend.displayName}
          onPhotoError={() => setPhotoFailures((current) => [...current, friend.id])}
          photoUrl={showPhoto ? friend.photoUrl : undefined}
          size={58}
        />
      </View>

      <View style={styles.rowCopy}>
        <View style={styles.nameLine}>
          <Text numberOfLines={1} style={styles.rowName}>{friend.displayName}</Text>
          {presenceAvailable ? (
            <Text style={[styles.statusText, isOnline ? styles.online : styles.offline]}>
              {isOnline ? 'Online' : 'Offline'}
            </Text>
          ) : null}
        </View>
        <Text numberOfLines={1} style={styles.rowMeta}>
          {friend.age === null ? 'Age not set' : `${friend.age} years old`}
          {friend.city ? `  ·  ${friend.city}` : ''}
        </Text>
        <Text style={styles.distanceText}>{friend.distanceKm.toFixed(1)} km away</Text>
      </View>

      {/* One slot at the end of the row, three possible things in it: the group's tick while picking
          people, a spinner while a press is being written, and otherwise Follow. Follow is here
          rather than being what the row does, because following somebody and looking at them are two
          different decisions -- the row goes to their profile, this decides whether they appear under
          Friends and in the audience of their restricted posts. It is said rather than pressed once
          they are followed, because a button that only ever says the same word is a status dressed
          as an action. */}
      {isSelecting ? (
        // A tick rather than a follow button, so the row does not look like it is about to change a
        // relationship while it is really a checkbox.
        <View style={[styles.checkbox, isSelected && styles.checkboxOn]}>
          {isSelected ? <Text style={styles.checkboxTick}>✓</Text> : null}
        </View>
      ) : isPending ? (
        <ActivityIndicator color="#E56B4C" size="small" />
      ) : followingIds.has(friend.id) ? (
        // "Friends" rather than "Following": the relationship is the one the inbox calls a friend and
        // the one this screen is for, and saying it two ways was the only place the two names met.
        <Text style={styles.followingLabel}>Friends</Text>
      ) : (
        <Pressable
          accessibilityLabel={`Follow ${friend.displayName}`}
          accessibilityRole="button"
          disabled={Boolean(pendingFriendId)}
          onPress={() => void toggleFollow(friend.id)}
          style={({ pressed }) => [styles.followChip, pressed && styles.rowPressed]}
        >
          <Text style={styles.followChipText}>Follow</Text>
        </Pressable>
      )}
    </Pressable>

              );
            })}
          </ScrollView>
        )}

        {/* Floated over the bottom of the list rather than sitting under it, so the people already
            chosen stay visible while more are picked. Outside the conditional above because it is
            the selection mode's own bar, not part of the results. */}
        {isSelecting ? (
          <View style={styles.groupBar}>
            <Text style={styles.groupBarCount}>
              {selectedIds.length === 0
                ? 'Pick at least one person'
                : `${selectedIds.length} selected`}
            </Text>

            <Pressable
              accessibilityLabel="Cancel group chat"
              accessibilityRole="button"
              onPress={cancelGroupSelection}
              style={({ pressed }) => [styles.groupBarCancel, pressed && styles.rowPressed]}
            >
              <Text style={styles.groupBarCancelText}>Cancel</Text>
            </Pressable>

            {/* Disabled with nobody picked rather than hidden, so the control does not move under
                the thumb between the first tap and the second. */}
            <Pressable
              accessibilityLabel="Start group chat"
              accessibilityRole="button"
              accessibilityState={{ disabled: selectedIds.length === 0 }}
              disabled={selectedIds.length === 0 || Boolean(pendingFriendId)}
              onPress={() => void startGroupChat()}
              style={({ pressed }) => [
                styles.groupBarGo,
                selectedIds.length === 0 && styles.groupBarGoOff,
                pressed && styles.rowPressed,
              ]}
            >
              {pendingFriendId === 'group' ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={styles.groupBarGoText}>Start group</Text>
              )}
            </Pressable>
          </View>
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
  groupButton: {
    borderColor: '#E56B4C',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  groupButtonText: {
    color: '#E56B4C',
    fontSize: 13,
    fontWeight: '800',
  },
  rowSelected: {
    backgroundColor: '#FDEEE9',
  },
  checkbox: {
    alignItems: 'center',
    borderColor: '#C9C3B8',
    borderRadius: 12,
    borderWidth: 2,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  checkboxOn: {
    backgroundColor: '#E56B4C',
    borderColor: '#E56B4C',
  },
  checkboxTick: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  groupBar: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderTopColor: '#E7E2DA',
    borderTopWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    flexDirection: 'row',
    gap: 10,
    left: 0,
    paddingBottom: 26,
    paddingHorizontal: 22,
    paddingTop: 12,
    position: 'absolute',
    right: 0,
  },
  groupBarCount: {
    color: '#656A73',
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
  },
  groupBarCancel: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  groupBarCancelText: {
    color: '#656A73',
    fontSize: 14,
    fontWeight: '700',
  },
  groupBarGo: {
    backgroundColor: '#E56B4C',
    borderRadius: 999,
    minWidth: 116,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  // Dimmed rather than hidden, so the bar does not resize under the thumb once somebody is picked.
  groupBarGoOff: {
    backgroundColor: '#E0B5A5',
  },
  groupBarGoText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'center',
  },
  screen: {
    flex: 1,
    paddingHorizontal: 22,
    paddingTop: 18,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 22,
  },
  headerCopy: {
    flex: 1,
  },
  eyebrow: {
    color: '#E56B4C',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  title: {
    color: '#20232A',
    fontSize: 27,
    fontWeight: '800',
  },
  iconButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 21,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  refreshText: {
    color: '#363A42',
    fontSize: 20,
    lineHeight: 24,
  },
  filterSection: {
    backgroundColor: '#FFFDFC',
    borderColor: '#E7E2DA',
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 22,
    paddingHorizontal: 16,
    paddingVertical: 15,
  },
  filterHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  filterTitle: {
    color: '#363A42',
    fontSize: 14,
    fontWeight: '800',
  },
  ageRange: {
    color: '#E56B4C',
    fontSize: 15,
    fontWeight: '800',
  },
  sliderGroup: {
    marginTop: 2,
  },
  sliderCaption: {
    color: '#777C84',
    fontSize: 11,
    fontWeight: '700',
  },
  slider: {
    height: 36,
    marginHorizontal: -8,
  },
  resultHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
    marginBottom: 8,
  },
  resultTitle: {
    color: '#363A42',
    fontSize: 15,
    fontWeight: '800',
  },
  resultCount: {
    backgroundColor: '#D7E6DF',
    borderRadius: 10,
    color: '#315A49',
    fontSize: 11,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  resultMeta: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  coordinateText: {
    color: '#8D929C',
    fontSize: 10,
  },
  list: {
    paddingBottom: 130,
  },
  row: {
    alignItems: 'center',
    borderBottomColor: '#E7E2DA',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    minHeight: 78,
    paddingVertical: 12,
  },
  rowPressed: {
    opacity: 0.72,
  },
  avatarWrap: {
    height: 58,
    marginRight: 13,
    position: 'relative',
    width: 58,
  },
  rowCopy: {
    flex: 1,
    minWidth: 0,
  },
  nameLine: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  rowName: {
    color: '#20232A',
    flex: 1,
    fontSize: 15,
    fontWeight: '800',
    marginRight: 8,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '700',
  },
  online: {
    color: '#3D765B',
  },
  offline: {
    color: '#8D929C',
  },
  rowMeta: {
    color: '#777C84',
    fontSize: 12,
  },
  distanceText: {
    color: '#E56B4C',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 4,
  },
  // The follow control, sized like the row's other trailing text so the end of the row stays one line
  // tall whatever it is showing.
  followChip: {
    borderColor: '#C9C3B8',
    borderRadius: 999,
    borderWidth: 1,
    marginLeft: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  followChipText: {
    color: '#363A42',
    fontSize: 12,
    fontWeight: '700',
  },
  // Said rather than pressed: there is no unfollow here, because taking a follow back is a decision
  // made on somebody's profile where the reason for it is still on screen.
  followingLabel: {
    color: '#8D929C',
    fontSize: 12,
    marginLeft: 10,
  },
  stateContainer: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingBottom: 30,
    paddingHorizontal: 28,
  },
  stateTitle: {
    color: '#20232A',
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
  },
  stateText: {
    color: '#777C84',
    fontSize: 14,
    lineHeight: 21,
    marginTop: 8,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: '#20232A',
    borderRadius: 10,
    marginTop: 18,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
});
