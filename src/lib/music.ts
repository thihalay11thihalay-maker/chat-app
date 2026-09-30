// Songs come from Audius, which needs no API key: the public gateway at api.audius.co serves
// search and track data to any app, and the audio itself streams from a creator node.
//
// A track is referenced by id, never by audio URL. Audius signs stream URLs with a timestamp,
// so a URL taken from a search result expires and would leave the post with dead audio. The
// current link is fetched again whenever a track is about to be played.
const API_BASE = 'https://api.audius.co/v1';

// Audius asks apps to identify themselves so it can attribute the traffic.
const APP_NAME = 'convo';

// Enough for a scroll of results without pulling a bigger page.
const RESULT_LIMIT = 20;

export interface MusicTrack {
  artist: string;
  /** Seconds, as Audius reports it. */
  duration: number;
  id: string;
  imageUrl: string;
  /** False when the artist has not made the track streamable, so it cannot be played. */
  isStreamable: boolean;
  /** Path on audius.co, kept so a post can credit where the track came from. */
  permalink: string;
  title: string;
}

// The sound as it is stored on a post document.
export type PostSound = MusicTrack;

function toStringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function toPositiveNumber(value: unknown) {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function toTrack(raw: Record<string, unknown>): MusicTrack | null {
  const id = toStringValue(raw.id);

  if (!id) {
    return null;
  }

  const artwork = (raw.artwork ?? {}) as Record<string, unknown>;
  const user = (raw.user ?? {}) as Record<string, unknown>;

  return {
    artist: toStringValue(user.name) || 'Unknown artist',
    duration: toPositiveNumber(raw.duration),
    id,
    // The small size is the one the picker draws; the larger one is the fallback when a
    // track only has the big artwork.
    imageUrl: toStringValue(artwork['150x150']) || toStringValue(artwork['480x480']),
    isStreamable: raw.is_streamable === true,
    permalink: toStringValue(raw.permalink),
    title: toStringValue(raw.title) || 'Untitled',
  };
}

/**
 * Searches Audius for tracks. An empty query is rejected here rather than sent, because
 * Audius answers it with an arbitrary page of tracks that has nothing to do with the box.
 */
export async function searchTracks(query: string, signal?: AbortSignal): Promise<MusicTrack[]> {
  const trimmed = query.trim();

  if (!trimmed) {
    return [];
  }

  const url = new URL(`${API_BASE}/tracks/search`);
  url.searchParams.set('query', trimmed);
  url.searchParams.set('limit', `${RESULT_LIMIT}`);
  url.searchParams.set('app_name', APP_NAME);

  const response = await fetch(url.toString(), { signal });

  if (!response.ok) {
    throw new Error(`Audius returned ${response.status}. Try again in a moment.`);
  }

  const payload = (await response.json()) as { data?: unknown };
  const data = Array.isArray(payload?.data) ? payload.data : [];

  return data
    .map((entry) => toTrack((entry ?? {}) as Record<string, unknown>))
    .filter((track): track is MusicTrack => track !== null);
}

// Resolved links are kept for the session: the search and the feed both ask for the same few
// tracks, and a cached lookup saves another round trip.
const streamUrlCache = new Map<string, string>();

/**
 * Fetches a playable URL for a track. Audius only returns one on the single-track endpoint,
 * signed for a limited time, so this has to run again for a post viewed much later.
 */
export async function resolveStreamUrl(trackId: string): Promise<string> {
  const cached = streamUrlCache.get(trackId);

  if (cached) {
    return cached;
  }

  const url = new URL(`${API_BASE}/tracks/${encodeURIComponent(trackId)}`);
  url.searchParams.set('app_name', APP_NAME);

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Audius returned ${response.status} for that track.`);
  }

  const payload = (await response.json()) as { data?: { stream?: { url?: unknown } | null } };
  const streamUrl = toStringValue(payload?.data?.stream?.url);

  if (!streamUrl) {
    throw new Error('That track is not streamable right now. Try another one.');
  }

  streamUrlCache.set(trackId, streamUrl);

  return streamUrl;
}

// Only the fields a post actually needs are copied, so a search result can never smuggle an
// unexpected value into Firestore.
export function toPostSound(track: MusicTrack): PostSound {
  return {
    artist: track.artist,
    duration: track.duration,
    id: track.id,
    imageUrl: track.imageUrl,
    isStreamable: track.isStreamable,
    permalink: track.permalink,
    title: track.title,
  };
}

// A post document is untrusted input: a hand-edited or older document can be missing fields,
// so every one is read defensively and an unusable sound is treated as no sound at all.
export function toPostSoundValue(value: unknown): PostSound | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const id = toStringValue(raw.id);

  if (!id) {
    return null;
  }

  return {
    artist: toStringValue(raw.artist) || 'Unknown artist',
    duration: toPositiveNumber(raw.duration),
    id,
    imageUrl: toStringValue(raw.imageUrl),
    // Older posts carry no flag, and a track that cannot stream is not worth offering, so an
    // absent flag is read as unplayable rather than playable.
    isStreamable: raw.isStreamable === true,
    permalink: toStringValue(raw.permalink),
    title: toStringValue(raw.title) || 'Untitled',
  };
}
