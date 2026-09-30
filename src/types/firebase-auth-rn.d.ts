import type { AsyncStorageStatic } from '@react-native-async-storage/async-storage';
import type { Persistence } from 'firebase/auth';

/**
 * getReactNativePersistence ships only in the React Native build of firebase/auth, which
 * TypeScript never picks: @firebase/auth lists a universal "types" entry before its
 * "react-native" one, and TypeScript always resolves "types" first. The runtime import works
 * on a device and the value is there, so only the declaration is missing here.
 *
 * The shape mirrors @firebase/auth/dist/rn: a function taking the AsyncStorage module and
 * returning the Persistence to hand to initializeAuth.
 */
declare module 'firebase/auth' {
  export function getReactNativePersistence(storage: AsyncStorageStatic): Persistence;
}