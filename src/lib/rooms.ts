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
import { Room } from '../types';
import { getFirebaseDb } from './firebase';
import { getCurrentUserProfile } from './users';

const ROOMS_COLLECTION = 'rooms';

export function roomKey(uid1: string, uid2: string): string {
  return [uid1, uid2].sort().join('_');
}

export async function createDirectRoom(participantA: string, participantB: string): Promise<Room> {
  const roomId = roomKey(participantA, participantB);
  const room: Room = {
    id: roomId,
    kind: 'direct',
    participants: [participantA, participantB],
    ownerId: participantA,
    createdAt: Date.now(),
  };
  await setDoc(doc(getFirebaseDb(), ROOMS_COLLECTION, roomId), room);
  return room;
}

export async function createGroupRoom(ownerId: string, name: string, participantIds: string[]): Promise<Room> {
  const participantIdsUnique = Array.from(new Set([ownerId, ...participantIds]));
  const roomId = `group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const room: Room = {
    id: roomId,
    kind: 'group',
    participants: participantIdsUnique,
    ownerId,
    name,
    createdAt: Date.now(),
  };
  await setDoc(doc(getFirebaseDb(), ROOMS_COLLECTION, roomId), room);
  return room;
}

export async function getRoom(roomId: string): Promise<Room | null> {
  const snapshot = await getDoc(doc(getFirebaseDb(), ROOMS_COLLECTION, roomId));
  if (!snapshot.exists()) return null;
  return mapRoomSnapshot(snapshot);
}

export async function getOrCreateDirectRoom(otherUid: string): Promise<Room> {
  const { getCurrentUserProfile } = await import('./users');
  const myProfile = await getCurrentUserProfile();
  const roomId = roomKey(myProfile.uid, otherUid);
  const existing = await getDoc(doc(getFirebaseDb(), ROOMS_COLLECTION, roomId));
  if (existing.exists()) {
    return mapRoomSnapshot(existing);
  }
  return createDirectRoom(myProfile.uid, otherUid);
}

export async function updateRoomLastMessage(
  roomId: string,
  text: string,
  senderId: string,
  timestamp: number,
): Promise<void> {
  await updateDoc(doc(getFirebaseDb(), ROOMS_COLLECTION, roomId), {
    lastMessage: text,
    lastMessageSenderId: senderId,
    lastMessageTime: timestamp,
  });
}

export async function deleteRoom(roomId: string): Promise<void> {
  await deleteDoc(doc(getFirebaseDb(), ROOMS_COLLECTION, roomId));
}

function toTimestamp(val: any): number {
  if (val === undefined || val === null) return Date.now();
  if (typeof val === 'number') return val;
  if (val && typeof val.toMillis === 'function') return val.toMillis();
  return Date.now();
}

export function mapRoomSnapshot(snapshot: QueryDocumentSnapshot<DocumentData>): Room {
  const data = snapshot.data() ?? {};
  return {
    id: snapshot.id,
    kind: data.kind ?? 'direct',
    participants: Array.isArray(data.participants) ? data.participants : [],
    ownerId: data.ownerId ?? '',
    name: data.name,
    avatarUrl: data.avatarUrl,
    about: data.about,
    lastMessage: data.lastMessage,
    lastMessageSenderId: data.lastMessageSenderId,
    lastMessageTime: toTimestamp(data.lastMessageTime),
    unreadCount: data.unreadCount ?? 0,
    createdAt: toTimestamp(data.createdAt),
  };
}