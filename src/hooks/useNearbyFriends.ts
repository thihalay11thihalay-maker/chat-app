import { useEffect, useState, useCallback } from 'react';
import { User } from '../types';
import {
  collection,
  query,
  where,
  getDocs,
  orderBy,
  limit,
} from 'firebase/firestore';
import { getFirebaseDb } from '../lib/firebase';
import { getCurrentUserProfile, updateUserProfile } from '../lib/users';
import { getCurrentLocation, requestLocationPermission } from '../lib/location';
import { geohashQueryBoundsForRadius, distanceBetweenMeters } from '../lib/geohash';
import { NEARBY_RADIUS_METERS } from '../lib/constants';

export function useNearbyFriends() {
  const [friends, setFriends] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [myLocation, setMyLocation] = useState<{ latitude: number; longitude: number } | null>(null);

  const updateMyLocation = useCallback(async () => {
    const hasPermission = await requestLocationPermission();
    if (!hasPermission) {
      setError('Location permission is required to find nearby friends.');
      setLoading(false);
      return;
    }

    const location = await getCurrentLocation();
    if (!location) {
      setError('Could not get your location.');
      setLoading(false);
      return;
    }

    setMyLocation({ latitude: location.latitude, longitude: location.longitude });

    try {
      await updateUserProfile({
        latitude: location.latitude,
        longitude: location.longitude,
        geohash: location.geohash,
      });
    } catch (err) {
      console.error('Failed to update location:', err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      await updateMyLocation();

      try {
        const profile = await getCurrentUserProfile();
        if (!profile.latitude || !profile.longitude) {
          setFriends([]);
          setLoading(false);
          return;
        }

        const center: [number, number] = [profile.latitude, profile.longitude];
        const bounds = geohashQueryBoundsForRadius(center, NEARBY_RADIUS_METERS);

        const nearby: User[] = [];
        for (const [start, end] of bounds) {
          const usersRef = collection(getFirebaseDb(), 'users');
          const q = query(
            usersRef,
            where('geohash', '>=', start),
            where('geohash', '<=', end),
            limit(50),
          );
          const snapshot = await getDocs(q);
          for (const docSnap of snapshot.docs) {
            const data = docSnap.data() as User;
            if (data.uid === profile.uid) continue;
            if (!data.latitude || !data.longitude) continue;

            const distance = distanceBetweenMeters(
              center,
              [data.latitude, data.longitude],
            );
            if (distance <= NEARBY_RADIUS_METERS) {
              nearby.push({ ...data, uid: docSnap.id });
            }
          }
        }

        if (!cancelled) {
          setFriends(nearby);
          setLoading(false);
        }
      } catch (err) {
        console.error('Failed to load nearby friends:', err);
        if (!cancelled) {
          setError('Failed to load nearby friends.');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [updateMyLocation]);

  return { friends, loading, error, myLocation, refresh: updateMyLocation };
}
