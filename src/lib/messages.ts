import {
  collection,
  doc,
  addDoc,
  getDocs,
  getDoc,
  query,
  orderBy,
  limit,
  onSnapshot,
  updateDoc,
  serverTimestamp,
  deleteDoc,
  arrayUnion,
} from 'firebase/firestore';
import { Message } from '../types';
import { getFirebaseDb } from './firebase';
import { getCurrentUserProfile } from './users';
import { updateRoomLastMessage } from './rooms';

const MESSAGES_SUBSCRIPTIONS = new Map<string, () => void>();

export async function sendMessage(roomId: string, type: Message['type'], data: { text?: string; mediaUrl?: string; durationSeconds?: number; stickerName?: string }): Promise<Message> {
  const profile = await getCurrentUserProfile();
  const message: Message = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    roomId,
    senderId: profile.uid,
    senderName: profile.name,
    type,
    ...data,
    createdAt: Date.now(),
    readBy: [profile.uid],
  };
  await addDoc(collection(getFirebaseDb(), 'rooms', roomId, 'messages'), message);
  await updateRoomLastMessage(roomId, data.text ?? 'Sent a message', profile.uid, message.createdAt);
  return message;
}

export function subscribeToMessages(roomId: string, callback: (messages: Message[]) => void) {
  const messagesRef = collection(getFirebaseDb(), 'rooms', roomId, 'messages');
  const q = query(messagesRef, orderBy('createdAt', 'asc'), limit(1000));

  const unsubscribe = onSnapshot(
    q,
    (snapshot) => {
      const messages: Message[] = snapshot.docs.map((docSnap) => {
        const data = docSnap.data();
        return {
          id: docSnap.id,
          roomId: data.roomId ?? '',
          senderId: data.senderId ?? '',
          senderName: data.senderName ?? '',
          type: data.type ?? 'text',
          text: data.text,
          mediaUrl: data.mediaUrl,
          durationSeconds: data.durationSeconds,
          stickerName: data.stickerName,
          replyTo: data.replyTo,
          createdAt: data.createdAt?.toMillis() ?? Date.now(),
          readBy: data.readBy,
        };
      });
      callback(messages);
    },
    (error) => {
      console.error('Error subscribing to messages:', error);
    },
  );

  MESSAGES_SUBSCRIPTIONS.set(roomId, unsubscribe);
  return unsubscribe;
}

export function unsubscribeFromMessages(roomId: string): void {
  const unsubscribe = MESSAGES_SUBSCRIPTIONS.get(roomId);
  if (unsubscribe) {
    unsubscribe();
    MESSAGES_SUBSCRIPTIONS.delete(roomId);
  }
}

export async function fetchMessages(roomId: string, limitCount: number = 50): Promise<Message[]> {
  const messagesRef = collection(getFirebaseDb(), 'rooms', roomId, 'messages');
  const q = query(messagesRef, orderBy('createdAt', 'desc'), limit(limitCount));
  const snapshot = await getDocs(q);
  return snapshot.docs
    .map((docSnap) => {
      const data = docSnap.data();
      return {
        id: docSnap.id,
        roomId: data.roomId ?? '',
        senderId: data.senderId ?? '',
        senderName: data.senderName ?? '',
        type: data.type ?? 'text',
        text: data.text,
        mediaUrl: data.mediaUrl,
        durationSeconds: data.durationSeconds,
        stickerName: data.stickerName,
        replyTo: data.replyTo,
        createdAt: data.createdAt?.toMillis() ?? Date.now(),
        readBy: data.readBy,
      };
    })
    .reverse();
}

export async function markMessagesAsRead(roomId: string, messageId: string): Promise<void> {
  const messageRef = doc(getFirebaseDb(), 'rooms', roomId, 'messages', messageId);
  const message = await getDoc(messageRef);
  if (!message.exists()) return;
  const profile = await getCurrentUserProfile();
  const readBy = message.data().readBy ?? [];
  await updateDoc(messageRef, { readBy: [...new Set([...readBy, profile.uid])] });
}

export async function deleteMessage(roomId: string, messageId: string): Promise<void> {
  await deleteDoc(doc(getFirebaseDb(), 'rooms', roomId, 'messages', messageId));
}

export async function replyToMessage(roomId: string, replyTo: { messageId: string; text: string; senderName: string }, text: string): Promise<Message> {
  return sendMessage(roomId, 'text', { text, replyTo } as any);
}