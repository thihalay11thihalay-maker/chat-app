import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApp, getApps, initializeApp } from 'firebase/app';
import {
    Auth,
    ConfirmationResult,
    createUserWithEmailAndPassword,
    signInWithPhoneNumber as firebaseSignInWithPhoneNumber,
    getAuth,
    getReactNativePersistence,
    GoogleAuthProvider,
    initializeAuth,
    RecaptchaVerifier,
    signInWithEmailAndPassword,
    signInWithPopup,
} from 'firebase/auth';
import { Database, getDatabase } from 'firebase/database';
import { Firestore, getFirestore, initializeFirestore } from 'firebase/firestore';
import { FirebaseStorage, getStorage } from 'firebase/storage';
import { Platform } from 'react-native';

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? '',
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? '',
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ?? '',
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? '',
    // Realtime Database is a separate product from Firestore and is not switched on by being
    // configured here, only by having an instance created for the project. Project chat-app-2d28f has
    // one: chat-app-2d28f-default-rtdb, in asia-southeast1. The url is read from the environment
    // rather than built from the project id, because the instance name is chosen when the database is
    // created and the region is part of the hostname, so neither can be guessed from the project id.
    // Without it, presence and typing are switched off and everything else still works.
    databaseURL: process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL ?? '',
};

let auth: Auth | null = null;
let firestore: Firestore | null = null;
let realtimeDb: Database | null = null;
let storage: FirebaseStorage | null = null;
let recaptchaVerifier: RecaptchaVerifier | null = null;

export function isFirebaseConfigured() {
  return Boolean(
    firebaseConfig.apiKey
      && firebaseConfig.authDomain
      && firebaseConfig.projectId
      && firebaseConfig.messagingSenderId
      && firebaseConfig.appId,
  );
}

export function isFirebaseStorageConfigured() {
    return Boolean(firebaseConfig.storageBucket);
}

/**
 * Whether a Realtime Database url has been provided at all.
 *
 * Separate from getFirebaseRealtimeDb because a screen needs to tell "this person is offline" apart
 * from "presence is switched off for this build". The second must not be reported as the first: an
 * honest blank is better than a confident wrong answer next to somebody's name.
 */
export function isRealtimeDatabaseConfigured() {
    return Boolean(firebaseConfig.databaseURL);
}

function assertFirebaseConfigured(message: string) {
  if (!isFirebaseConfigured()) {
    throw new Error(message);
  }
}

function getFirebaseApp() {
  assertFirebaseConfigured('Firebase is not configured. Add the EXPO_PUBLIC_FIREBASE values to .env.');

  return getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
}

export function getFirebaseAuth() {
  if (auth) return auth;

  const app = getFirebaseApp();

  // React Native has no localStorage for the auth SDK to fall back on. getAuth would then
  // start in memory, so every app restart looked like a sign-out and warned about it, so the
  // session is written to AsyncStorage instead.
  //
  // Two ways this is skipped. On the web the browser build of the SDK already persists
  // through localStorage and IndexedDB, and it does not ship this helper at all. The runtime
  // check covers a bundle built against the browser build, where calling it would throw.
  const canPersistOnDevice = Platform.OS !== 'web' && typeof getReactNativePersistence === 'function';

  if (!canPersistOnDevice) {
    auth = getAuth(app);
    return auth;
  }

  // initializeAuth throws if this app already has an auth instance, which happens when
  // something reached for getAuth before this module did. The existing instance is the same
  // one, so it is kept rather than crashing the screen.
  try {
    auth = initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) });
  } catch (error) {
    console.warn('Falling back to the default auth persistence:', error);
    auth = getAuth(app);
  }

  return auth;
}

export function getFirebaseDb() {
  if (firestore) return firestore;

  const app = getFirebaseApp();

  try {
    // `ignoreUndefinedProperties` because this codebase writes optional fields by spreading a value that
    // may be absent, and the SDK's default is to refuse the whole write rather than leave that one field
    // out: one `expiresAt: undefined` on a room with the disappearing timer off was enough to stop every
    // message from being sent, with an error that named nothing the reader could act on. Fields that are
    // genuinely meant to be cleared use `deleteField`, which this does not affect.
    firestore = initializeFirestore(app, { ignoreUndefinedProperties: true });
  } catch (error) {
    // Thrown when something already created the instance for this app, which is how the web build gets
    // here: `getFirestore` hands back the instance it made rather than a second one.
    console.warn('Firestore was already initialised; using the existing instance:', error);

    firestore = getFirestore(app);
  }

  return firestore;
}

/**
 * Realtime Database handle, or null when there is nothing to connect to.
 *
 * Null rather than a throw, because presence is decoration on the chat list: a missing database
 * must cost the green dots, not the conversation list. The url is read from the environment rather
 * than guessed from the project id, because the instance name is chosen when the database is
 * created and the two usual shapes are not both correct.
 */
export function getFirebaseRealtimeDb(): Database | null {
  const url = firebaseConfig.databaseURL;

  if (!url) {
    return null;
  }

  try {
    realtimeDb ??= getDatabase(getFirebaseApp(), url);
    return realtimeDb;
  } catch (error) {
    console.warn('Realtime Database is unavailable:', error);
    return null;
  }
}

export function getFirebaseStorage() {
  if (storage) return storage;

  if (!isFirebaseStorageConfigured()) {
    throw new Error('Firebase Storage is not configured.');
  }

  storage = getStorage(getFirebaseApp());
  return storage;
}

export function signUpWithEmail(email: string, password: string) {
  return createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
}

export function signInWithEmail(email: string, password: string) {
  return signInWithEmailAndPassword(getFirebaseAuth(), email, password);
}

export function signInWithGoogle() {
  if (Platform.OS !== 'web') {
    throw new Error('Google sign-in on iOS and Android needs native Google credentials first.');
  }

  return signInWithPopup(getFirebaseAuth(), new GoogleAuthProvider());
}

export function signInWithPhoneNumber(phoneNumber: string) {
  if (Platform.OS !== 'web') {
    throw new Error('Phone sign-in on iOS and Android needs a native Firebase auth setup.');
  }

  if (typeof document === 'undefined') {
    throw new Error('Phone sign-in is only available in a browser.');
  }

  recaptchaVerifier ??= new RecaptchaVerifier(getFirebaseAuth(), 'recaptcha-container', {
    size: 'normal',
  });

  return firebaseSignInWithPhoneNumber(getFirebaseAuth(), phoneNumber, recaptchaVerifier).catch((error) => {
    recaptchaVerifier?.clear();
    recaptchaVerifier = null;
    throw error;
  });
}

export function confirmPhoneSignIn(
  confirmationResult: ConfirmationResult,
  verificationCode: string,
) {
  return confirmationResult.confirm(verificationCode);
}

// Firestore reports a rule that closed a path as permission-denied and a missing session as
// unauthenticated. Both are permanent for the current session, so callers remember them
// instead of retrying and raising the same message again.
export function isFirestorePermissionError(error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : '';

    return code === 'permission-denied' || code === 'unauthenticated';
}

export function getAuthErrorMessage(error: unknown) {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : '';

  switch (code) {
    case 'auth/invalid-email':
      return 'Enter a valid email address.';
    case 'auth/missing-password':
      return 'Enter your password.';
    case 'auth/invalid-credential':
      return 'The email or password is incorrect.';
    case 'auth/email-already-in-use':
      return 'An account already exists with this email.';
    case 'auth/weak-password':
      return 'Use a password with at least 6 characters.';
    case 'auth/invalid-phone-number':
      return 'Enter a valid phone number with its country code.';
    case 'auth/invalid-verification-code':
      return 'The verification code is incorrect.';
    case 'auth/code-expired':
      return 'That verification code has expired. Request a new one.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please try again later.';
    case 'auth/captcha-check-failed':
      return 'reCAPTCHA verification failed. Complete the checkbox and try again.';
    case 'auth/invalid-app-credential':
      return 'reCAPTCHA is not configured for this web domain.';
    case 'auth/missing-phone-number':
      return 'Enter your phone number with its country code.';
    case 'auth/quota-exceeded':
      return 'SMS quota exceeded. Try again later or use a Firebase test number.';
    case 'auth/operation-not-allowed':
      return 'Enable Phone sign-in in the Firebase Console.';
    case 'auth/popup-closed-by-user':
      return 'Google sign-in was cancelled.';
    default:
      return error instanceof Error ? error.message : 'Authentication failed. Try again.';
  }
}