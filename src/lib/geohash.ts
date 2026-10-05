import {
  GEOHASH_PRECISION,
  geohashForLocation,
  geohashQueryBounds,
  distanceBetween,
  validateLocation,
  validateGeohash,
} from 'geofire-common';

export type GeoLocation = [number, number]; // [latitude, longitude]

export const GEOHASH_PRECISION_WRITE = GEOHASH_PRECISION;

export function coordsToGeohash(latitude: number, longitude: number, precision: number = GEOHASH_PRECISION): string {
  validateLocation([latitude, longitude]);
  return geohashForLocation([latitude, longitude], precision);
}

export function distanceBetweenMeters(a: GeoLocation, b: GeoLocation): number {
  validateLocation(a);
  validateLocation(b);
  return distanceBetween(a, b) * 1000;
}

export function geohashQueryBoundsForRadius(center: GeoLocation, radiusMeters: number): Array<[string, string]> {
  validateLocation(center);
  return geohashQueryBounds(center, radiusMeters);
}

export function isValidUserGeohash(geohash: unknown): boolean {
  if (typeof geohash !== 'string') return false;
  try {
    validateGeohash(geohash);
    return geohash.length <= GEOHASH_PRECISION_WRITE;
  } catch {
    return false;
  }
}
