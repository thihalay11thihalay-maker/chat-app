import Slider from '@react-native-community/slider';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import {
  addDoc,
  collection,
  doc,
  endAt,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAt,
  where,
} from 'firebase/firestore';
import {
  distanceBetween,
  geohashForLocation,
  geohashQueryBounds,
} from 'geofire-common';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';
import { getAge, getCoordinates, getParticipants, getString, UserData } from '@/lib/user-data';

type Friend = {
  age: number | null;
  city: string;
  displayName: string;
  id: string;
  isOnline: boolean;
  photoUrl: string;
  distanceKm: number;
};

const MIN_AGE = 18;
const MAX_AGE = 80;
const SEARCH_RADIUS_KM = 50;
const RESULTS_LIMIT = 20;

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
        displayName: getString(userData, ['displayName', 'name', 'username'], 'New friend'),
        distanceKm,
        id: userDocument.id,
        isOnline: userData.isOnline === true,
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

  const loadFriends = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage('');

    try {
      const currentUser = getFirebaseAuth().currentUser;
      if (!currentUser) {
        setFriends([]);
        setErrorMessage('Please log in to find friends.');
        return;
      }

      const center = await resolveCurrentCoordinates();
      if (!center) {
        setFriends([]);
        setErrorMessage('Allow location access to find friends within 50 km.');
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
      setPhotoFailures([]);
    } catch (error) {
      console.error('Could not load friends:', error);
      setErrorMessage('Could not load friends. Please check your connection and try again.');
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

  const startChat = async (friend: Friend) => {
    const currentUser = getFirebaseAuth().currentUser;
    if (!currentUser || pendingFriendId) {
      return;
    }

    setPendingFriendId(friend.id);

    try {
      const db = getFirebaseDb();
      const existingChats = await getDocs(query(
        collection(db, 'chats'),
        where('participants', 'array-contains', currentUser.uid),
      ));
      const existingChat = existingChats.docs.find((chatDocument) => {
        const participants = getParticipants(chatDocument.data().participants);
        return participants.length === 2 && participants.includes(friend.id);
      });

      if (existingChat) {
        router.push(`/chat/${existingChat.id}` as never);
        return;
      }

      const [ownSnapshot, friendSnapshot] = await Promise.all([
        getDoc(doc(db, 'users', currentUser.uid)),
        getDoc(doc(db, 'users', friend.id)),
      ]);
      const ownProfile = (ownSnapshot.exists() ? ownSnapshot.data() : {}) as UserData;
      const friendProfile = (friendSnapshot.exists() ? friendSnapshot.data() : {}) as UserData;
      const ownName = getString(ownProfile, ['displayName', 'name'], currentUser.displayName || 'Friend');
      const ownPhoto = getString(ownProfile, ['profilePictureUrl', 'photoURL'], currentUser.photoURL || '');
      const friendName = getString(friendProfile, ['displayName', 'name', 'username'], friend.displayName);
      const friendPhoto = getString(friendProfile, ['profilePictureUrl', 'photoURL', 'photoUrl'], friend.photoUrl);

      const chat = await addDoc(collection(db, 'chats'), {
        createdAt: serverTimestamp(),
        lastMessage: 'Say hello',
        lastMessageAt: serverTimestamp(),
        participants: [currentUser.uid, friend.id].sort(),
        participantProfiles: {
          [currentUser.uid]: { displayName: ownName, profilePictureUrl: ownPhoto },
          [friend.id]: { displayName: friendName, profilePictureUrl: friendPhoto },
        },
        updatedAt: serverTimestamp(),
      });

      router.push(`/chat/${chat.id}` as never);
    } catch (error) {
      console.error('Could not start a chat:', error);
      setErrorMessage('Could not start a chat. Please try again in a moment.');
    } finally {
      setPendingFriendId('');
    }
  };

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <View style={styles.screen}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>MEET SOMEONE NEW</Text>
            <Text style={styles.title}>Find friends</Text>
          </View>
          <Pressable
            accessibilityLabel="Refresh friends"
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
            <Text style={styles.stateText}>Finding friends...</Text>
          </View>
        ) : errorMessage ? (
          <View style={styles.stateContainer}>
            <Text style={styles.stateTitle}>Friends unavailable</Text>
            <Text style={styles.stateText}>{errorMessage}</Text>
            <Pressable onPress={() => void loadFriends()} style={styles.retryButton}>
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        ) : visibleFriends.length === 0 ? (
          <View style={styles.stateContainer}>
            <Text style={styles.stateTitle}>
              {friends.length ? 'No matches in this age range' : 'No friends to show yet'}
            </Text>
            <Text style={styles.stateText}>Widen the age range or come back later.</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
            {visibleFriends.map((friend) => {
              const isPending = pendingFriendId === friend.id;
              const showPhoto = Boolean(friend.photoUrl) && !photoFailures.includes(friend.id);

              return (
                <Pressable
                  accessibilityLabel={`Start a chat with ${friend.displayName}`}
                  accessibilityRole="button"
                  disabled={Boolean(pendingFriendId)}
                  key={friend.id}
                  onPress={() => void startChat(friend)}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                >
                  <View style={styles.avatarWrap}>
                    {showPhoto ? (
                      <Image
                        onError={() => setPhotoFailures((current) => [...current, friend.id])}
                        source={{ uri: friend.photoUrl }}
                        style={styles.avatar}
                      />
                    ) : (
                      <View style={styles.avatarFallback}>
                        <Text style={styles.avatarLetter}>
                          {friend.displayName.charAt(0).toUpperCase()}
                        </Text>
                      </View>
                    )}
                    <View style={[styles.onlineDot, friend.isOnline && styles.onlineDotActive]} />
                  </View>

                  <View style={styles.rowCopy}>
                    <View style={styles.nameLine}>
                      <Text numberOfLines={1} style={styles.rowName}>{friend.displayName}</Text>
                      <Text style={[styles.statusText, friend.isOnline ? styles.online : styles.offline]}>
                        {friend.isOnline ? 'Online' : 'Offline'}
                      </Text>
                    </View>
                    <Text numberOfLines={1} style={styles.rowMeta}>
                      {friend.age === null ? 'Age not set' : `${friend.age} years old`}
                      {friend.city ? `  \u00B7  ${friend.city}` : ''}
                    </Text>
                    <Text style={styles.distanceText}>{friend.distanceKm.toFixed(1)} km away</Text>
                  </View>

                  {isPending ? (
                    <ActivityIndicator color="#E56B4C" size="small" />
                  ) : (
                    <Text style={styles.rowArrow}>{'>'}</Text>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
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
    height: 52,
    marginRight: 13,
    position: 'relative',
    width: 52,
  },
  avatar: {
    backgroundColor: '#E7E2DA',
    borderRadius: 26,
    height: 52,
    width: 52,
  },
  avatarFallback: {
    alignItems: 'center',
    backgroundColor: '#F2C6B8',
    borderRadius: 26,
    flex: 1,
    justifyContent: 'center',
  },
  avatarLetter: {
    color: '#6E3D31',
    fontSize: 19,
    fontWeight: '800',
  },
  onlineDot: {
    backgroundColor: '#A6A9AF',
    borderColor: '#F7F4EF',
    borderRadius: 7,
    borderWidth: 2,
    bottom: 0,
    height: 14,
    position: 'absolute',
    right: 0,
    width: 14,
  },
  onlineDotActive: {
    backgroundColor: '#3D765B',
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
  rowArrow: {
    color: '#B3B4B7',
    fontSize: 21,
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
