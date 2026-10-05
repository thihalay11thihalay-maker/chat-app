import * as Location from 'expo-location';
import { GEOHASH_PRECISION_WRITE, coordsToGeohash } from './geohash';

export interface LocationResult {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  geohash: string;
}

export async function requestLocationPermission(): Promise<boolean> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    return status === 'granted';
  } catch {
    return false;
  }
}

export async function getCurrentLocation(): Promise<LocationResult | null> {
  const hasPermission = await requestLocationPermission();
  if (!hasPermission) return null;

  try {
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });
    const { latitude, longitude, accuracy } = position.coords;
    const geohash = coordsToGeohash(latitude, longitude, GEOHASH_PRECISION_WRITE);
    return { latitude, longitude, accuracy: accuracy ?? null, geohash };
  } catch (error) {
    console.error('Error getting current location:', error);
    return null;
  }
}

export function watchLocation(
  callback: (result: LocationResult) => void,
  intervalMs: number = 60000,
): (() => void) | null {
  if (!Location.watchPositionAsync) {
    console.warn('watchPositionAsync not available on this platform');
    return null;
  }

  let subscription: Location.LocationSubscription | null = null;

  (async () => {
    subscription = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: intervalMs,
        distanceInterval: 10,
      },
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        const geohash = coordsToGeohash(latitude, longitude, GEOHASH_PRECISION_WRITE);
        callback({ latitude, longitude, accuracy: accuracy ?? null, geohash });
      },
    );
  })();

  return () => {
    if (subscription) {
      subscription.remove();
    }
  };
}