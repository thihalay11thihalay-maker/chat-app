import { getFirebaseAuth } from '@/lib/firebase';

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
 * Where to ask for a call token.
 *
 * A token is signed with the project's App Certificate, and a certificate in the app bundle is a
 * certificate every reader of the bundle can sign with. So the certificate lives in a Node process
 * (scripts/agora-token.js) and the app asks it for a token per call, which is also how this has to work
 * once there is a real server rather than a laptop.
 *
 * Has to be the machine's LAN address on a phone: `localhost` on the device is the device.
 */
export const AGORA_TOKEN_SERVER = process.env.EXPO_PUBLIC_AGORA_TOKEN_SERVER ?? '';

/**
 * How long a token request may take before it is given up on.
 *
 * Short, because it is a signature on a piece of text rather than a video stream: the token comes from a
 * process on the same network, and anything slower than this means the address in
 * EXPO_PUBLIC_AGORA_TOKEN_SERVER is wrong rather than slow. Waiting thirty seconds would only delay the
 * message that says so.
 */
const TOKEN_TIMEOUT_MS = 8_000;

/** The two ways a call can fail before the SDK is even reached, plus a third for the token service. */
export type CallSetupError = 'no-app-id' | 'no-token-service' | 'permission-denied' | 'token-refused';

/**
 * A token for one channel, from the token service.
 *
 * `uid` is not sent: the service takes it from the Firebase ID token in the `Authorization` header and
 * ignores anything in the query string. That is the point -- a caller who can choose its own uid can mint a
 * token as somebody else, so the uid is something the service reads off a credential it verified.
 *
 * The ID token is this account's own, refreshed on demand, which is also why the service can tell a
 * signed-in caller from an anonymous one.
 */
export async function requestCallToken(channel: string) {
  if (!AGORA_TOKEN_SERVER) {
    throw new Error('no-token-service');
  }

  // A search the reader walked away from is still in flight otherwise, and its answer lands on a call
  // screen that has gone.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);

  try {
    const url = `${AGORA_TOKEN_SERVER.replace(/\/+$/, '')}/token?channel=${encodeURIComponent(channel)}`;
    const idToken = await getFirebaseAuth().currentUser?.getIdToken();
    const response = await fetch(url, {
      headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      // The service answered and said no, which is a different thing from not answering: this is a
      // configuration problem on the server rather than a phone that cannot see it.
      throw new Error('token-refused');
    }

    const body = await response.json() as { token?: unknown };

    if (typeof body.token !== 'string' || body.token === '') {
      throw new Error('token-refused');
    }

    return body.token;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('no-token-service');
    }

    // Anything else -- a wrong address, the service not running, a phone with no route to the laptop --
    // is the same problem from the reader's side: there was no answer, so say which one it was.
    throw error instanceof Error && error.message === 'token-refused' ? error : new Error('no-token-service');
  } finally {
    clearTimeout(timer);
  }
}