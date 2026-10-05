import {
  collection,
  doc,
  setDoc,
  getDocs,
  query,
  where,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp,
  QueryDocumentSnapshot,
} from 'firebase/firestore';
import { FriendRequest, User } from '../types';
import { getFirebaseDb } from './firebase';
import { getCurrentUserProfile } from './users';

const FRIEND_REQUESTS_COLLECTION = 'friendRequests';

export async function sendFriendRequest(toUid: string): Promise<void> {
  const fromProfile = await getCurrentUserProfile();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const request: FriendRequest = {
    id: requestId,
    fromUid: fromProfile.uid,
    toUid,
    status: 'pending',
    createdAt: Date.now(),
  };

  await setDoc(doc(getFirebaseDb(), FRIEND_REQUESTS_COLLECTION, requestId), request);
}

export async function acceptFriendRequest(requestId: string): Promise<void> {
  await updateDoc(doc(getFirebaseDb(), FRIEND_REQUESTS_COLLECTION, requestId), {
    status: 'accepted',
  });
}

export async function rejectFriendRequest(requestId: string): Promise<void> {
  await updateDoc(doc(getFirebaseDb(), FRIEND_REQUESTS_COLLECTION, requestId), {
    status: 'rejected',
  });
}

function mapFriendRequest(docSnap: QueryDocumentSnapshot): FriendRequest {
  const data = docSnap.data();
  return {
    id: docSnap.id,
    fromUid: data.fromUid ?? '',
    toUid: data.toUid ?? '',
    status: data.status ?? 'pending',
    createdAt: data.createdAt?.toMillis() ?? Date.now(),
  };
}

export async function getFriendRequests(): Promise<FriendRequest[]> {
  const profile = await getCurrentUserProfile();
  const requestsRef = collection(getFirebaseDb(), FRIEND_REQUESTS_COLLECTION);
  const q = query(requestsRef, where('toUid', '==', profile.uid));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(mapFriendRequest);
}

export async function getSentFriendRequests(): Promise<FriendRequest[]> {
  const profile = await getCurrentUserProfile();
  const requestsRef = collection(getFirebaseDb(), FRIEND_REQUESTS_COLLECTION);
  const q = query(requestsRef, where('fromUid', '==', profile.uid));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(mapFriendRequest);
}

function mapUser(docSnap: QueryDocumentSnapshot): User {
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
}

export async function searchUsersByName(name: string): Promise<User[]> {
  const usersRef = collection(getFirebaseDb(), 'users');
  const q = query(usersRef, where('name', '>=', name), where('name', '<=', name + '\uf8ff'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(mapUser);
}

export async function getUserByPhone(phone: string): Promise<User | null> {
  const usersRef = collection(getFirebaseDb(), 'users');
  const q = query(usersRef, where('phone', '==', phone));
  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;
  return mapUser(snapshot.docs[0]);
}