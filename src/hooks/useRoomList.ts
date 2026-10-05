import { useEffect, useState, useCallback, useRef } from 'react';
import { Room, User } from '../types';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  updateDoc,
  getDoc,
} from 'firebase/firestore';
import { getFirebaseDb } from '../lib/firebase';
import { getUserById } from '../lib/users';
import { sortByLastMessageTime } from '../lib/utils';

function mapRoom(docSnap: any): Room {
  const data = docSnap.data();
  return {
    id: docSnap.id,
    kind: data.kind ?? 'direct',
    participants: data.participants ?? [],
    ownerId: data.ownerId ?? '',
    name: data.name,
    avatarUrl: data.avatarUrl,
    about: data.about,
    lastMessage: data.lastMessage,
    lastMessageSenderId: data.lastMessageSenderId,
    lastMessageTime: data.lastMessageTime?.toMillis() ?? data.lastMessageTime ?? 0,
    unreadCount: data.unreadCount ?? 0,
    createdAt: data.createdAt?.toMillis() ?? Date.now(),
  };
}

export function useRoomList(myUid: string) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [participants, setParticipants] = useState<Record<string, User>>({});
  const [loading, setLoading] = useState(true);
  const myUidRef = useRef(myUid);
  myUidRef.current = myUid;

  // Load rooms with a realtime listener
  useEffect(() => {
    if (!myUid) {
      setRooms([]);
      setLoading(false);
      return;
    }

    const roomsRef = collection(getFirebaseDb(), 'rooms');
    const q = query(roomsRef, orderBy('lastMessageTime', 'desc'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const loaded: Room[] = snapshot.docs
          .map(mapRoom)
          .filter((r) => r.participants.includes(myUidRef.current));

        loaded.sort(sortByLastMessageTime);
        setRooms(loaded);
        setLoading(false);
      },
      (error) => {
        console.error('Failed to load rooms:', error);
        setLoading(false);
      },
    );

    return unsubscribe;
  }, [myUid]);

  // Load participant profiles for all rooms
  useEffect(() => {
    const participantIds = Array.from(
      new Set(rooms.flatMap((r) => r.participants)),
    ).filter((uid) => uid !== myUid);

    if (participantIds.length === 0) {
      setParticipants({});
      return;
    }

    let cancelled = false;

    (async () => {
      const loaded: Record<string, User> = {};
      for (const uid of participantIds) {
        try {
          const user = await getUserById(uid);
          if (!cancelled) {
            loaded[uid] = user;
          }
        } catch {
          // skip users that cannot be read
        }
      }
      if (!cancelled) {
        setParticipants(loaded);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rooms, myUid]);

  const markRoomUnread = useCallback(async (roomId: string, count: number) => {
    try {
      await updateDoc(doc(getFirebaseDb(), 'rooms', roomId), {
        unreadCount: count,
      });
    } catch (error) {
      console.error('Failed to mark room unread:', error);
    }
  }, []);

  return { rooms, participants, loading, markRoomUnread };
}

export function useRoom(roomId: string | null) {
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!roomId) {
      setRoom(null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const docSnap = await getDoc(doc(getFirebaseDb(), 'rooms', roomId));
        if (!cancelled && docSnap.exists()) {
          setRoom(mapRoom(docSnap));
        }
      } catch (error) {
        console.error('Failed to load room:', error);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  return { room, loading };
}