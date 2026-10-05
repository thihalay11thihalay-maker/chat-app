import { User } from '../types';
import {
  getFirebaseAuth,
  isFirebaseConfigured,
  onAuthStateChange,
  signUpWithEmail,
  signInWithEmail,
  signOutUser,
  updateCurrentUserProfile,
  authErrorMessage,
} from './firebase';
import { createUserProfile, getUserById } from './users';

export function useAuth() {
  const isAuthenticated = isFirebaseConfigured();
  return { isAuthenticated };
}

export async function registerUser(email: string, password: string, name: string): Promise<User> {
  if (!isFirebaseConfigured()) {
    throw new Error('Firebase is not configured.');
  }
  try {
    const userCredential = await signUpWithEmail(email, password);
    const user = userCredential.user;
    if (!user) throw new Error('Registration failed: no user returned.');
    await updateCurrentUserProfile(name, undefined);
    const newUser = await createUserProfile({
      uid: user.uid,
      name,
      phone: user.phoneNumber ?? '',
      avatarUrl: user.photoURL ?? undefined,
    });
    return newUser;
  } catch (error) {
    throw new Error(authErrorMessage(error));
  }
}

export async function loginUser(email: string, password: string): Promise<User> {
  if (!isFirebaseConfigured()) {
    throw new Error('Firebase is not configured.');
  }
  try {
    await signInWithEmail(email, password);
    const user = getFirebaseAuth().currentUser;
    if (!user) throw new Error('Login failed: no user returned.');
    return getUserById(user.uid);
  } catch (error) {
    throw new Error(authErrorMessage(error));
  }
}

export function logoutUser(): Promise<void> {
  return signOutUser();
}

export function getCurrentUser(): User | null {
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) return null;
  try {
    return {
      uid: user.uid,
      name: user.displayName ?? 'Anonymous',
      phone: user.phoneNumber ?? '',
      avatarUrl: user.photoURL ?? undefined,
      status: 'online',
      lastSeen: Date.now(),
      createdAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export function onAuthState(callback: (user: User | null) => void) {
  const auth = getFirebaseAuth();
  return onAuthStateChange((firebaseUser) => {
    if (!firebaseUser) {
      callback(null);
      return;
    }
    callback({
      uid: firebaseUser.uid,
      name: firebaseUser.displayName ?? 'Anonymous',
      phone: firebaseUser.phoneNumber ?? '',
      avatarUrl: firebaseUser.photoURL ?? undefined,
      status: 'online',
      lastSeen: Date.now(),
      createdAt: Date.now(),
    });
  });
}
