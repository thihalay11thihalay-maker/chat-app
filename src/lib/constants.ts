import { Emoji, Sticker } from '../types';
import { distanceBetweenMeters } from './geohash';

export const COLORS = {
  primary: '#0088CC',
  primaryLight: '#E6F4FE',
  background: '#F2F4F7',
  surface: '#FFFFFF',
  border: '#E4E7EB',
  text: '#1F242C',
  textSecondary: '#6B7482',
  divider: '#EEEEEE',
  messageMine: '#DBEEFE',
  messageOther: '#FFFFFF',
  error: '#E02020',
  success: '#33B47C',
  accent: '#E95C9D',
  online: '#33B47C',
  placeholder: '#A1A9B4',
};

export const FONTS = {
  size: { xs: 11, sm: 12, md: 14, lg: 16, xl: 20 },
  fontWeight: { regular: '400' as const, medium: '500' as const, bold: '700' as const },
};

export const EMOJIS: Emoji[] = [
  ...['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖','😺','😸','😹','😻','😼','😽','🙀','😿','😾'].map((char) => ({ name: char, char, category: 'smileys' as const })),
  ...['👍','👎','👊','✊','🤛','🤜','🤞','✌️','🤟','🤘','🤙','👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✍️','🙌','👐','🤲','🤝','🙏','💅','👄','👅','👂','🦻','👃','🧠','🦷','🦴','👀','👁️','👣','👁️‍🗨️','🫀','🫁'].map((char) => ({ name: char, char, category: 'people' as const })),
  ...['💖','💗','💓','💞','💕','💘','💝','❤️','🧡','💛','💚','💙','💜','🤎','🤍','💔','❣️','💕','💟','☮️','✝️','☪️','🕉️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚓','🏰','🗝️','🏹','🛡️','⛓️','🧿','🎦','💠','🔱','📿','🏺','🔬','🔭','📡','💉','🩸','💊','💰','💴','💵','💳','💎'].map((char) => ({ name: char, char, category: 'symbols' as const })),
];

export const STICKERS: Sticker[] = [
  { id: 'st_1', name: 'Love', url: 'https://raw.githubusercontent.com/pichillilorenzo/FlutterWhatsappUI/master/app/src/main/res/drawable-hdpi/loved.png', category: 'default' as const },
  { id: 'st_2', name: 'Happy', url: 'https://raw.githubusercontent.com/pichillilorenzo/FlutterWhatsappUI/master/app/src/main/res/drawable-hdpi/happy.png', category: 'default' as const },
  { id: 'st_3', name: 'Laugh', url: 'https://raw.githubusercontent.com/pichillilorenzo/FlutterWhatsappUI/master/app/src/main/res/drawable-hdpi/laughing.png', category: 'default' as const },
  { id: 'st_4', name: 'Sad', url: 'https://raw.githubusercontent.com/pichillilorenzo/FlutterWhatsappUI/master/app/src/main/res/drawable-hdpi/sad.png', category: 'default' as const },
  { id: 'st_5', name: 'Mad', url: 'https://raw.githubusercontent.com/pichillilorenzo/FlutterWhatsappUI/master/app/src/main/res/drawable-hdpi/angry.png', category: 'default' as const },
  { id: 'st_6', name: 'Shy', url: 'https://raw.githubusercontent.com/pichillilorenzo/FlutterWhatsappUI/master/app/src/main/res/drawable-hdpi/shy.png', category: 'default' as const },
  { id: 'st_7', name: 'Cool', url: 'https://raw.githubusercontent.com/pichillilorenzo/FlutterWhatsappUI/master/app/src/main/res/drawable-hdpi/cool.png', category: 'default' as const },
  { id: 'st_8', name: 'Thanks', url: 'https://raw.githubusercontent.com/pichillilorenzo/FlutterWhatsappUI/master/app/src/main/res/drawable-hdpi/cool.png', category: 'default' as const },
];

export const MESSAGES_PER_PAGE = 50;
export const NEARBY_RADIUS_METERS = 10000;
export const LOCATION_UPDATE_INTERVAL_MS = 60000;

export { distanceBetweenMeters };

export const AVATAR_COLORS = [
  '#FFD174', '#FF9B55', '#F66A5B', '#EE567D', '#CC5DE8',
  '#9559E0', '#595BCF', '#3FA8D7', '#228B6B', '#76A06B',
];

export function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function formatTime(timestamp: number | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (days > 0) return date.toLocaleDateString();
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'Just now';
}

export function formatMessageTime(timestamp: number | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}