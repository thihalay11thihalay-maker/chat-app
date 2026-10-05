import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  getAuth,
  initializeAuth,
  getReactNativePersistence,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  updateProfile,
} from 'firebase/auth';
import {
  getFirestore,
  initializeFirestore,
  Timestamp,
  serverTimestamp,
} from 'firebase/firestore';
import { Platform } from 'react-native';

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? '',
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? '',
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ?? '',
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? '',
};

let authInstance: ReturnType<typeof getAuth> | null = null;
let firestoreInstance: ReturnType<typeof getFirestore> | null = null;

export function isFirebaseConfigured(): boolean {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
}

function assertFirebaseConfigured(message: string): void {
  if (!isFirebaseConfigured()) {
    throw new Error(message);
  }
}

function getFirebaseApp() {
  assertFirebaseConfigured('Firebase is not configured. Add EXPO_PUBLIC_FIREBASE_* to .env.');
  return getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
}

export function getFirebaseAuth() {
  if (authInstance) return authInstance;
  const app = getFirebaseApp();

  if (Platform.OS !== 'web' && typeof getReactNativePersistence === 'function') {
    try {
      authInstance = initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) });
    } catch {
      authInstance = getAuth(app);
    }
  } else {
    authInstance = getAuth(app);
  }
  return authInstance;
}

export function getFirebaseDb() {
  if (firestoreInstance) return firestoreInstance;
  const app = getFirebaseApp();
  try {
    firestoreInstance = initializeFirestore(app, { ignoreUndefinedProperties: true });
  } catch {
    firestoreInstance = getFirestore(app);
  }
  return firestoreInstance;
}

export function signUpWithEmail(email: string, password: string) {
  return createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
}

export function signInWithEmail(email: string, password: string) {
  return signInWithEmailAndPassword(getFirebaseAuth(), email, password);
}

export function signOutUser() {
  return firebaseSignOut(getFirebaseAuth());
}

export function resetPasswordWithEmail(email: string) {
  return sendPasswordResetEmail(getFirebaseAuth(), email);
}

export function updateCurrentUserProfile(displayName: string, photoUrl?: string) {
  const auth = getFirebaseAuth();
  return updateProfile(auth.currentUser!, { displayName, photoURL: photoUrl || null });
}

export function onAuthStateChange(callback: (user: ReturnType<typeof getAuth>['currentUser']) => void) {
  return onAuthStateChanged(getFirebaseAuth(), callback);
}

export function authErrorMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code) : '';
  const messages: Record<string, string> = {
    'auth/email-already-in-use': 'အီမေးလ်အသုံးပြုပြီးပါပြီ။',
    'auth/invalid-email': 'အီမေးလ် လိပ်စာ မှန်ကန်မှုရှိမရှိ ပြန်စစ်ဆေးပါ။',
    'auth/operation-not-allowed': 'အီမေးလ်/စကားဝှက် ဝင်ရောက်စနစ်ကို အသုံးမပြုထားပါ။',
    'auth/weak-password': 'စကားဝှက်သည် အနည်းဆုံး အက္ခရာ ၆ လုံးရှိရပါမည်။',
    'auth/user-disabled': 'အကောင့်ကို ဖျက်သိမ်းထားပါသည်။',
    'auth/user-not-found': 'အကောင့်မရှိပါ။',
    'auth/wrong-password': 'စကားဝှက် မှားယွင်းပါသည်။',
    'auth/invalid-credential': 'အီမေးလ် သို့မဟုတ် စကားဝှက် မှားယွင်းပါသည်။',
    default: error instanceof Error ? error.message : 'ဝင်ရောက်ရာတွင် အမှားပေါ်လာပါသည်။',
  };
  return messages[code] ?? messages.default;
}
