import { ChatMessage } from '@/components/chat-message-bubble';

export type MockChat = {
  id: string;
  name: string;
  avatar: string;
  snippet: string;
  time: string;
  unread: number;
  online: boolean;
  kind: 'direct' | 'group';
  /**
   * Whether this person is a friend, as opposed to merely someone you have a thread with. Absent on
   * a group, which has no single person to be friends with.
   *
   * This is a separate flag from `online` on purpose. The inbox used to treat "friend" as "direct
   * chat with someone currently online", which made the two filters the same list and meant
   * unfollowing somebody or their going offline silently moved them between tabs.
   */
  isFriend?: boolean;
  age?: number;
  gender?: 'male' | 'female';
  distance?: string;
  messages: ChatMessage[];
};

// Stand-in for the inbox while the list is still mock data. The ids are the contract with the
// conversation screen: a row pushes /chat/<id>, and chat/[id].tsx looks the id up here before
// it reaches for Firestore. A real chat id is a Firestore document id and is absent from this
// list, so the lookup miss is what tells the two apart.
const ME = 'me';

function message(id: string, senderId: string, text: string, minutesAgo: number): ChatMessage {
  return {
    createdAt: new Date(Date.now() - minutesAgo * 60_000),
    id,
    senderId,
    text,
    type: 'text',
  };
}

// Avatars are a public placeholder service, not real people.
export const MOCK_CHATS: MockChat[] = [
  {
    age: 24,
    avatar: 'https://i.pravatar.cc/150?img=12',
    distance: '3 km away',
    gender: 'female',
    id: 'mock-1',
    isFriend: true,
    kind: 'direct',
    messages: [
      message('mock-1-m1', 'mock-1', 'Hey! Are you free this evening?', 24),
      message('mock-1-m2', ME, 'Maybe, what did you have in mind?', 21),
      message('mock-1-m3', 'mock-1', 'Coffee and then a walk? 🌿', 10),
    ],
    name: 'HninKyaing',
    online: true,
    snippet: 'Coffee and then a walk? 🌿',
    time: '10m ago',
    unread: 3,
  },
  {
    age: 29,
    avatar: 'https://i.pravatar.cc/150?img=32',
    distance: '1.2 km away',
    gender: 'female',
    id: 'mock-2',
    isFriend: true,
    kind: 'direct',
    messages: [
      message('mock-2-m1', ME, 'Did you get the photos I sent?', 140),
      message('mock-2-m2', 'mock-2', 'Yes, thank you!', 19),
    ],
    name: 'Nwe Lay',
    online: false,
    snippet: 'Sent a voice message',
    time: '19m ago',
    unread: 0,
  },
  {
    avatar: 'https://i.pravatar.cc/150?img=45',
    id: 'mock-3',
    kind: 'group',
    messages: [
      message('mock-3-m1', 'mock-3', 'Does anyone still need a ride?', 62),
      message('mock-3-m2', ME, 'I can take two people', 58),
      message('mock-3-m3', 'mock-3', 'Perfect, see you at 7', 55),
    ],
    name: 'Weekend Trip Group',
    online: true,
    snippet: 'Mon: does anyone still need a ride?',
    time: '1h ago',
    unread: 12,
  },
  {
    age: 31,
    avatar: 'https://i.pravatar.cc/150?img=5',
    distance: '8 km away',
    gender: 'male',
    id: 'mock-4',
    isFriend: false,
    kind: 'direct',
    messages: [
      message('mock-4-m1', 'mock-4', 'That sounds good to me 👍', 118),
    ],
    name: 'Mon',
    online: true,
    snippet: 'That sounds good to me 👍',
    time: '2h ago',
    unread: 1,
  },
  {
    avatar: 'https://i.pravatar.cc/150?img=20',
    id: 'mock-5',
    kind: 'group',
    messages: [
      message('mock-5-m1', 'mock-5', 'Chapter 4 discussion at 7?', 400),
    ],
    name: 'Book Club',
    online: false,
    snippet: 'Aye: chapter 4 discussion at 7?',
    time: 'Yesterday',
    unread: 0,
  },
  {
    age: 27,
    avatar: 'https://i.pravatar.cc/150?img=68',
    distance: '450 m away',
    gender: 'female',
    id: 'mock-6',
    isFriend: true,
    kind: 'direct',
    messages: [
      message('mock-6-m1', 'mock-6', 'Haha, okay you win', 900),
    ],
    name: 'Thiri Aung',
    online: false,
    snippet: 'Haha, okay you win',
    time: 'Yesterday',
    unread: 0,
  },
];

/** The mock conversation behind an id, or undefined when the id is a real Firestore chat. */
export function findMockChat(id: string) {
  return MOCK_CHATS.find((chat) => chat.id === id);
}