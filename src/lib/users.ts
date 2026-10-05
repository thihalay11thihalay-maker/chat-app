import {
  collection,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
  QueryDocumentSnapshot,
  DocumentData,
} from 'firebase/firestore';
import { User } from '../types';
import { getFirebaseDb } from './firebase';

const USERS_COLLECTION = 'users';

function toTimestamp(val: any): number {
  if (val === undefined || val === null) return Date.now();
  if (typeof val === 'number') return val;
  if (val && typeof val.toMillis === 'function') return val.toMillis();
  return Date.now();
}

function mapUserSnapshot(snapshot: QueryDocumentSnapshot<DocumentData>): User {
  const data = snapshot.data() ?? {};
  return {
    uid: snapshot.id,
    name: data.name ?? 'Anonymous',
    phone: data.phone ?? '',
    avatarUrl: data.avatarUrl,
    bio: data.bio,
    status: data.status,
    lastSeen: data.lastSeen,
    geohash: data.geohash,
    latitude: data.latitude,
    longitude: data.longitude,
    createdAt: toTimestamp(data.createdAt),
  };
}

export async function createUserProfile(user: Omit<User, 'createdAt'>): Promise<User> {
  const userRef = doc(getFirebaseDb(), USERS_COLLECTION, user.uid);
  const newUser: User = {
    ...user,
    createdAt: Date.now(),
  };
  await setDoc(userRef, {
    name: user.name,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    status: user.status,
    lastSeen: user.lastSeen,
    geohash: user.geohash,
    latitude: user.latitude,
    longitude: user.longitude,
    createdAt: newUser.createdAt,
  });
  return newUser;
}

export async function getUserById(uid: string): Promise<User> {
  const userRef = doc(getFirebaseDb(), USERS_COLLECTION, uid);
  const snapshot = await getDoc(userRef);
  if (!snapshot.exists()) {
    throw new Error('User not found');
  }
  return mapUserSnapshot(snapshot);
}

export async function getCurrentUserProfile(): Promise<User> {
  const { getFirebaseAuth } = await import('./firebase');
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error('Not authenticated');
  return getUserById(user.uid);
}

export async function updateUserProfile(updates: Partial<Pick<User, 'name' | 'avatarUrl' | 'bio' | 'status' | 'latitude' | 'longitude' | 'geohash'>>): Promise<void> {
  const { getFirebaseAuth } = await import('./firebase');
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error('Not authenticated');
  await updateDoc(doc(getFirebaseDb(), USERS_COLLECTION, user.uid), updates);
}

export async function getUserByPhone(phone: string): Promise<User | null> {
  const usersRef = collection(getFirebaseDb(), USERS_COLLECTION);
  const { query, where, getDocs } = await import('firebase/firestore');
  const q = query(usersRef, where('phone', '==', phone));
  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;
  const docSnap = snapshot.docs[0];
  return mapUserSnapshot(docSnap);
}

export async function removeUserProfile(uid: string): Promise<void> {
  await deleteDoc(doc(getFirebaseDb(), USERS_COLLECTION, uid));
}

export async function searchUsersByName(queryText: string, limitCount: number = 20): Promise<User[]> {
  const usersRef = collection(getFirebaseDb(), USERS_COLLECTION);
  const { query, where, orderBy, limit, getDocs } = await import('firebase/firestore');
  const q = query(usersRef, orderBy('name'), limit(limitCount));
  const snapshot = await getDocs(q);
  return snapshot.docs
    .map((docSnap) => {
      const data = docSnap.data();
      return {
        uid: docSnap.id,
        name: data.name ?? '',
        phone: data.phone ?? '',
        avatarUrl: data.avatarUrl,
        bio: data.bio,
        status: data.status,
        lastSeen: data.lastSeen,
        geohash: data.geohash,
        latitude: data.latitude,
        longitude: data.longitude,
        createdAt: data.createdAt?.toMillis() ?? Date.now(),
      };
    })
    .filter((u) => u.name.toLowerCase().includes(queryText.toLowerCase()));
}