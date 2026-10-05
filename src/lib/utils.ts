export function getRoomOtherUser(room: { participants: string[]; ownerId: string }, currentUid: string): string {
  return room.participants.find((uid) => uid !== currentUid) ?? '';
}

export function getRoomDisplayName(room: { kind: string; participants: string[]; name?: string; ownerId: string }): string {
  if (room.kind === 'group') {
    return room.name ?? 'Group chat';
  }
  return '';
}

export function sortByLastMessageTime(a: { lastMessageTime?: number }, b: { lastMessageTime?: number }): number {
  const timeA = a.lastMessageTime ?? 0;
  const timeB = b.lastMessageTime ?? 0;
  return timeB - timeA;
}

export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func(...args), wait);
  };
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

export function isToday(timestamp: number): boolean {
  const today = new Date();
  const date = new Date(timestamp);
  return date.getDate() === today.getDate()
    && date.getMonth() === today.getMonth()
    && date.getFullYear() === today.getFullYear();
}

export function isYesterday(timestamp: number): boolean {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const date = new Date(timestamp);
  return date.getDate() === yesterday.getDate()
    && date.getMonth() === yesterday.getMonth()
    && date.getFullYear() === yesterday.getFullYear();
}
