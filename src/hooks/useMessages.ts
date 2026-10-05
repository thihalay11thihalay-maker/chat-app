import { useEffect, useState, useCallback, useRef } from 'react';
import { Message } from '../types';
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  addDoc,
  serverTimestamp,
  doc,
  updateDoc,
  arrayUnion,
} from 'firebase/firestore';
import { getFirebaseDb } from '../lib/firebase';
import { getCurrentUserProfile } from '../lib/users';
import { updateRoomLastMessage } from '../lib/rooms';

function mapMessage(docSnap: any): Message {
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
}

export function useMessages(roomId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const myUidRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const profile = await getCurrentUserProfile();
        myUidRef.current = profile.uid;
      } catch {
        // not authenticated
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!roomId) {
      setMessages([]);
      setLoading(false);
      return;
    }

    const messagesRef = collection(getFirebaseDb(), 'rooms', roomId, 'messages');
    const q = query(messagesRef, orderBy('createdAt', 'asc'), limit(200));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const loaded: Message[] = snapshot.docs.map(mapMessage);
        setMessages(loaded);
        setLoading(false);
      },
      (error) => {
        console.error('Failed to load messages:', error);
        setLoading(false);
      },
    );

    return unsubscribe;
  }, [roomId]);

  const sendMessage = useCallback(
    async (type: Message['type'], data: { text?: string; mediaUrl?: string; durationSeconds?: number; stickerName?: string }) => {
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
    },
    [roomId],
  );

  const markAsRead = useCallback(
    async (messageId: string) => {
      if (!myUidRef.current) return;
      const messageRef = doc(getFirebaseDb(), 'rooms', roomId, 'messages', messageId);
      await updateDoc(messageRef, { readBy: arrayUnion(myUidRef.current) });
    },
    [roomId],
  );

  return { messages, loading, sendMessage, markAsRead };
}