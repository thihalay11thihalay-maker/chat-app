export type CallType = 'audio' | 'video';

export const CALL_TYPES: CallType[] = ['audio', 'video'];

/** Narrows a route param. A hand-edited deep link can put anything in `callType`. */
export function isCallType(value: unknown): value is CallType {
  return value === 'audio' || value === 'video';
}

/**
 * The Agora channel name for a conversation.
 *
 * Agora accepts letters, digits, underscores, dashes and a few punctuation marks, and rejects
 * anything else. A chat id reaches us as a raw route param and a Firestore document id can hold
 * characters outside that set, so they are folded to underscores rather than handed to the SDK to
 * fail on.
 */
export function callChannelName(chatId: string) {
  const safeId = chatId.replace(/[^A-Za-z0-9_-]/g, '_');

  // Agora caps the channel name at 64 bytes.
  return `channel_${safeId}`.slice(0, 64);
}

/** The Agora App ID from .env.local. Empty when the variable is absent, which the screen reports. */
export const AGORA_APP_ID = process.env.EXPO_PUBLIC_AGORA_APP_ID ?? '';

/**
 * TEMPORARY. A real Agora App Certificate must never ship in a client, so this placeholder is
 * deliberately not a valid token: the call screen checks for it and refuses to join with an
 * actionable message instead of failing silently inside the native SDK.
 *
 * Replace the body with a short-lived token from your token server once that exists.
 */
export const TEMP_AGORA_TOKEN = 'REPLACE_WITH_TEMP_AGORA_TOKEN';

export const PLACEHOLDER_TOKEN = 'REPLACE_WITH_TEMP_AGORA_TOKEN';

/** The two ways a call can fail before the SDK is even reached. */
export type CallSetupError = 'no-app-id' | 'placeholder-token' | 'permission-denied';
