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
    setDoc,
    startAt,
} from 'firebase/firestore';
import { distanceBetween, geohashForLocation, geohashQueryBounds } from 'geofire-common';
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

import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';

type NearbyUser = {
  id: string;
  displayName: string;
  age: number;
  city: string;
  isOnline: boolean;
  distanceKm: number;
  profilePictureUrl?: string;
};

type UserProfile = Record<string, unknown>;

const SEARCH_RADIUS_KM = 50;
const MIN_AGE = 18;
const MAX_AGE = 80;

function readNumber(profile: UserProfile, ...keys: string[]) {
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }

  return null;
}

function readString(profile: UserProfile, key: string, fallback: string) {
  return typeof profile[key] === 'string' && profile[key]
    ? String(profile[key])
    : fallback;
}

function getCoordinates(profile: UserProfile) {
  const latitude = readNumber(profile, 'latitude', 'lat');
  const longitude = readNumber(profile, 'longitude', 'lng', 'lon');

  return latitude !== null && longitude !== null ? [latitude, longitude] as [number, number] : null;
}

export default function NearbyScreen() {
  const [nearbyUsers, setNearbyUsers] = useState<NearbyUser[]>([]);
  const [age, setAge] = useState(18);
  const [location, setLocation] = useState<[number, number] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');

  const searchNearbyUsers = useCallback(async (currentLocation: [number, number], minimumAge: number) => {
    const bounds = geohashQueryBounds(currentLocation, SEARCH_RADIUS_KM * 1000);
    const userCollection = collection(getFirebaseDb(), 'users');
    const snapshots = await Promise.all(
      bounds.map(([start, end]) => getDocs(query(
        userCollection,
        orderBy('geohash'),
        startAt(start),
        endAt(end),
      ))),
    );
    const usersById = new Map<string, NearbyUser>();

    snapshots.forEach((snapshot) => {
      snapshot.docs.forEach((userDocument) => {
        if (userDocument.id === getFirebaseAuth().currentUser?.uid) {
          return;
        }

        const profile = userDocument.data() as UserProfile;
        const coordinates = getCoordinates(profile);
        const userAge = readNumber(profile, 'age');

        if (!coordinates || userAge === null || userAge < minimumAge || userAge > MAX_AGE) {
          return;
        }

        const distanceKm = distanceBetween(coordinates, currentLocation);
        if (distanceKm > SEARCH_RADIUS_KM) {
          return;
        }

        usersById.set(userDocument.id, {
          age: userAge,
          city: readString(profile, 'city', 'Location unavailable'),
          distanceKm,
          displayName: readString(profile, 'displayName', 'Nearby friend'),
          id: userDocument.id,
          isOnline: profile.isOnline === true,
          profilePictureUrl: typeof profile.profilePictureUrl === 'string'
            ? profile.profilePictureUrl
            : undefined,
        });
      });
    });

    setNearbyUsers([...usersById.values()].sort((first, second) => first.distanceKm - second.distanceKm));
  }, []);

  const loadNearbyUsers = useCallback(async (minimumAge = age) => {
    setIsLoading(true);
    setErrorMessage('');

    try {
      let currentLocation = location;
      if (!currentLocation) {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (permission.status !== 'granted') {
          setErrorMessage('Location permission is required to find nearby friends.');
          return;
        }

        const position = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        currentLocation = [position.coords.latitude, position.coords.longitude];
        setLocation(currentLocation);

        const user = getFirebaseAuth().currentUser;
        if (user) {
          await setDoc(doc(getFirebaseDb(), 'users', user.uid), {
            geohash: geohashForLocation(currentLocation),
            latitude: currentLocation[0],
            longitude: currentLocation[1],
          }, { merge: true });
        }
      }

      await searchNearbyUsers(currentLocation, minimumAge);
    } catch (error) {
      console.error('Failed to load nearby users:', error);
      setErrorMessage('Could not load nearby friends. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [age, location, searchNearbyUsers]);

  useEffect(() => {
    const initialLoad = setTimeout(() => void loadNearbyUsers(), 0);
    return () => clearTimeout(initialLoad);
  }, [loadNearbyUsers]);

  const handleAgeChange = (value: number) => {
    setAge(Math.round(value));
  };

  const handleAgeComplete = (value: number) => {
    const minimumAge = Math.round(value);
    if (location) {
      void loadNearbyUsers(minimumAge);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.eyebrow}>DISCOVER</Text>
            <Text style={styles.title}>Nearby friends</Text>
            <Text style={styles.subtitle}>People within {SEARCH_RADIUS_KM} km of you.</Text>
          </View>
          <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.closeButton}>
            <Text style={styles.closeButtonText}>X</Text>
          </Pressable>
        </View>

        <View style={styles.locationCard}>
          <View style={styles.locationIcon}>
            <Text style={styles.locationIconText}>+</Text>
          </View>
          <View style={styles.locationCopy}>
            <Text style={styles.cardLabel}>YOUR LOCATION</Text>
            <Text style={styles.coordinatesText}>
              {location ? `${location[0].toFixed(4)}, ${location[1].toFixed(4)}` : 'Finding your location...'}
            </Text>
          </View>
          <Pressable accessibilityRole="button" onPress={() => void loadNearbyUsers()} style={styles.refreshButton}>
            <Text style={styles.refreshButtonText}>Refresh</Text>
          </Pressable>
        </View>

        <View style={styles.filterSection}>
          <View style={styles.filterHeader}>
            <Text style={styles.sectionTitle}>Minimum age</Text>
            <Text style={styles.ageValue}>{age}</Text>
          </View>
          <Slider
            maximumValue={MAX_AGE}
            minimumTrackTintColor="#E56B4C"
            minimumValue={MIN_AGE}
            onValueChange={handleAgeChange}
            onSlidingComplete={handleAgeComplete}
            step={1}
            style={styles.slider}
            thumbTintColor="#E56B4C"
            value={age}
          />
          <View style={styles.sliderLabels}>
            <Text style={styles.sliderLabel}>{MIN_AGE}</Text>
            <Text style={styles.sliderLabel}>{MAX_AGE}</Text>
          </View>
        </View>

        <View style={styles.resultsHeader}>
          <Text style={styles.sectionTitle}>People near you</Text>
          <Text style={styles.resultCount}>{nearbyUsers.length} found</Text>
        </View>

        {isLoading ? (
          <View style={styles.feedbackState}>
            <ActivityIndicator color="#E56B4C" size="large" />
            <Text style={styles.feedbackText}>Finding nearby friends...</Text>
          </View>
        ) : errorMessage ? (
          <View style={styles.feedbackState}>
            <Text style={styles.feedbackText}>{errorMessage}</Text>
            <Pressable accessibilityRole="button" onPress={() => void loadNearbyUsers()} style={styles.retryButton}>
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        ) : nearbyUsers.length === 0 ? (
          <View style={styles.feedbackState}>
            <Text style={styles.emptyTitle}>No friends found yet</Text>
            <Text style={styles.feedbackText}>Try a lower minimum age or refresh your location.</Text>
          </View>
        ) : (
          <View style={styles.resultsList}>
            {nearbyUsers.map((nearbyUser) => (
              <View key={nearbyUser.id} style={styles.userCard}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{nearbyUser.displayName.charAt(0).toUpperCase()}</Text>
                </View>
                <View style={styles.userCopy}>
                  <View style={styles.nameRow}>
                    <Text style={styles.userName}>{nearbyUser.displayName}</Text>
                    <View style={[styles.statusDot, nearbyUser.isOnline && styles.statusDotOnline]} />
                  </View>
                  <Text style={styles.userMeta}>{nearbyUser.age} years old  |  {nearbyUser.city}</Text>
                  <Text style={styles.distanceText}>{nearbyUser.distanceKm.toFixed(1)} km away</Text>
                </View>
                <Text style={[styles.statusText, nearbyUser.isOnline ? styles.onlineText : styles.offlineText]}>
                  {nearbyUser.isOnline ? 'Online' : 'Offline'}
                </Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  scrollContent: {
    padding: 28,
  },
  headerRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 28,
  },
  eyebrow: {
    color: '#E56B4C',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.8,
    marginBottom: 8,
  },
  title: {
    color: '#20232A',
    fontSize: 34,
    fontWeight: '800',
    lineHeight: 40,
    marginBottom: 7,
  },
  subtitle: {
    color: '#656A73',
    fontSize: 15,
  },
  closeButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 22,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  closeButtonText: {
    color: '#363A42',
    fontSize: 16,
    fontWeight: '800',
  },
  locationCard: {
    alignItems: 'center',
    backgroundColor: '#20232A',
    borderRadius: 16,
    flexDirection: 'row',
    marginBottom: 22,
    padding: 16,
  },
  locationIcon: {
    alignItems: 'center',
    backgroundColor: '#E56B4C',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  locationIconText: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
  },
  locationCopy: {
    flex: 1,
    marginLeft: 12,
  },
  cardLabel: {
    color: '#B9BBC0',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    marginBottom: 4,
  },
  coordinatesText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  refreshButton: {
    paddingHorizontal: 4,
    paddingVertical: 8,
  },
  refreshButtonText: {
    color: '#F5B09D',
    fontSize: 13,
    fontWeight: '800',
  },
  filterSection: {
    backgroundColor: '#FFFDFC',
    borderColor: '#E7E2DA',
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 28,
    padding: 18,
  },
  filterHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    color: '#363A42',
    fontSize: 15,
    fontWeight: '800',
  },
  ageValue: {
    color: '#E56B4C',
    fontSize: 22,
    fontWeight: '800',
  },
  slider: {
    height: 40,
    marginHorizontal: -8,
  },
  sliderLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sliderLabel: {
    color: '#8D929C',
    fontSize: 12,
  },
  resultsHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  resultCount: {
    color: '#8D929C',
    fontSize: 13,
  },
  resultsList: {
    gap: 10,
  },
  userCard: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    padding: 14,
  },
  avatar: {
    alignItems: 'center',
    backgroundColor: '#F5B09D',
    borderRadius: 25,
    height: 50,
    justifyContent: 'center',
    width: 50,
  },
  avatarText: {
    color: '#20232A',
    fontSize: 20,
    fontWeight: '800',
  },
  userCopy: {
    flex: 1,
    marginLeft: 12,
  },
  nameRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  userName: {
    color: '#20232A',
    fontSize: 16,
    fontWeight: '800',
  },
  statusDot: {
    backgroundColor: '#B9BBC0',
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  statusDotOnline: {
    backgroundColor: '#3D765B',
  },
  userMeta: {
    color: '#656A73',
    fontSize: 12,
    marginTop: 4,
  },
  distanceText: {
    color: '#E56B4C',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 5,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '800',
  },
  onlineText: {
    color: '#3D765B',
  },
  offlineText: {
    color: '#8D929C',
  },
  feedbackState: {
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 44,
  },
  feedbackText: {
    color: '#656A73',
    fontSize: 14,
    lineHeight: 21,
    marginTop: 12,
    textAlign: 'center',
  },
  emptyTitle: {
    color: '#20232A',
    fontSize: 17,
    fontWeight: '800',
  },
  retryButton: {
    backgroundColor: '#E56B4C',
    borderRadius: 10,
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
});
