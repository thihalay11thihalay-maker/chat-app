export interface User {
  uid: string;
  name: string;
  phone: string;
  avatarUrl?: string;
  bio?: string;
  status?: 'online' | 'offline' | 'typing';
  lastSeen?: number;
  geohash?: string;
  latitude?: number;
  longitude?: number;
  createdAt: number;
}

export interface Message {
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  type: 'text' | 'voice' | 'image' | 'sticker';
  text?: string;
  mediaUrl?: string;
  durationSeconds?: number;
  stickerName?: string;
  replyTo?: { messageId: string; text: string; senderName: string };
  createdAt: number;
  readBy?: string[];
}

export interface Room {
  id: string;
  kind: 'direct' | 'group';
  participants: string[];
  ownerId: string;
  name?: string;
  avatarUrl?: string;
  about?: string;
  lastMessage?: string;
  lastMessageSenderId?: string;
  lastMessageTime?: number;
  unreadCount?: number;
  createdAt: number;
}

export interface FriendRequest {
  id: string;
  fromUid: string;
  toUid: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
}

export interface Emoji {
  name: string;
  char: string;
  category: 'smileys' | 'people' | 'objects' | 'symbols';
}

export interface Sticker {
  id: string;
  name: string;
  url: string;
  category: 'default';
}
