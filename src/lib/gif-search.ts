/**
 * Finding a GIF to send.
 *
 * Backed by GifSnap's public API, which needs no account and no key: the app can offer a searchable
 * picker on a fresh install without anybody having to sign up for a GIF provider first. It is a
 * best-effort service with no published uptime promise, so every failure below comes back as a sentence
 * a reader can be shown, and the picker treats a failed request as an empty result with a line of
 * explanation rather than as an error screen.
 *
 * The service is a third party, and that matters in one way worth stating: the words somebody searches
 * for leave the device. A GIF picker is not the place for a private search, and nobody is asked to send
 * anything -- the request goes out when somebody types, and the picture they choose is uploaded to this
 * app's own storage like any other photo.
 */

/** One GIF, in the shape this app wants rather than the shape the service sends. */
export type GifResult = {
  /** The small animation meant for a grid, when the service has one. WebP and at most 512 KiB. */
  animatedPreviewUrl?: string;
  height: number;
  id: string;
  /** A still, used while the animation loads and for anything that cannot play one. */
  previewUrl: string;
  title: string;
  /** The full file. This is what gets sent. */
  url: string;
  width: number;
};

const BASE_URL = 'https://gifsnap.com/api/v1';

/**
 * How long a search may take before it is given up on.
 *
 * Fifteen seconds, which is the service's own default. Longer than that and a reader is looking at a
 * spinner for a search they have already given up on; much shorter and a slow connection reports failure
 * for a request that was about to succeed.
 */
const TIMEOUT_MS = 15_000;

/** How many a page holds. The service allows fifty; three rows of three is what fits a phone. */
const PAGE_SIZE = 12;

type MediaItem = {
  animated_preview?: { animated?: boolean; url?: string };
  height?: unknown;
  id?: unknown;
  preview_url?: unknown;
  title?: unknown;
  url?: unknown;
  width?: unknown;
};

/** The extension the service served, which is not always `.gif`. */
export function gifExtension(url: string) {
  const path = url.split('?')[0];
  const match = /\.[a-z0-9]{2,5}$/i.exec(path);

  return match ? match[0].toLowerCase() : '.gif';
}

/** The content type that goes with it, for the upload and for the message that points at the file. */
export function gifContentType(url: string) {
  if (url.toLowerCase().split('?')[0].endsWith('.webp')) {
    return 'image/webp';
  }

  if (url.toLowerCase().split('?')[0].endsWith('.png')) {
    return 'image/png';
  }

  return 'image/gif';
}

/** A file name that keeps the extension the service actually served. */
export function gifFileName(gif: GifResult) {
  return `gif-${gif.id}${gifExtension(gif.url)}`;
}

/**
 * One result, or nothing.
 *
 * An item without a usable url is dropped rather than shown as an empty cell: the grid would carry a
 * hole, and a hole in a grid of pictures reads as a mistake in the app rather than as something the
 * service did not send.
 */
function toResult(item: MediaItem): GifResult | null {
  if (typeof item?.url !== 'string' || item.url === '') {
    return null;
  }

  const animated = typeof item.animated_preview?.url === 'string' && item.animated_preview.url !== ''
    ? item.animated_preview.url
    : undefined;

  return {
    animatedPreviewUrl: animated,
    height: typeof item.height === 'number' && item.height > 0 ? item.height : 400,
    id: typeof item.id === 'string' ? item.id : item.url,
    previewUrl: typeof item.preview_url === 'string' ? item.preview_url : item.url,
    title: typeof item.title === 'string' && item.title !== '' ? item.title : 'GIF',
    url: item.url,
    width: typeof item.width === 'number' && item.width > 0 ? item.width : 400,
  };
}

async function request(path: string, params: Record<string, string | number>) {
  const url = new URL(`${BASE_URL}${path}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  // A search the reader has already moved on from is still in flight otherwise, and its answer lands on
  // a grid they are no longer looking at.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), { signal: controller.signal });

    if (!response.ok) {
      throw new Error(response.status === 404
        ? 'That search found nothing.'
        : 'The GIF service could not answer. Please try again.');
    }

    const payload = await response.json() as { data?: unknown };

    if (!Array.isArray(payload?.data)) {
      throw new Error('The GIF service sent something this app could not read.');
    }

    return (payload.data as MediaItem[])
      .map(toResult)
      .filter((item): item is GifResult => item !== null);
  } catch (error) {
    // An abort here is the timeout above, and a reader waiting fifteen seconds needs to be told, not
    // left with a grid that never filled.
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('The GIF search took too long. Please try again.');
    }

    throw error instanceof Error
      ? error
      : new Error('No connection to the GIF service.');
  } finally {
    clearTimeout(timer);
  }
}

/** GIFs matching what somebody typed. */
export function searchGifs(query: string, page = 1) {
  return request('/gifs/search', { limit: PAGE_SIZE, page, q: query.trim() });
}

/**
 * What the picker shows before anybody searches.
 *
 * A blank search box with an empty grid below it reads as a broken screen, so an empty query browses what
 * people are actually sending today rather than asking for a search to begin with.
 */
export function trendingGifs(page = 1) {
  return request('/gifs/trending', { limit: PAGE_SIZE, page });
}

/** Which one to call, so the picker does not have to decide for itself. */
export function findGifs(query: string, page = 1) {
  return query.trim() === '' ? trendingGifs(page) : searchGifs(query, page);
}