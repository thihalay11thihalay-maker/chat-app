import { createContext, ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';

export interface CapturedMedia {
  /** Raw base64 of a photo, without a data: prefix. Empty for a clip. */
  base64: string;
  mediaType: 'image' | 'video';
  /** The permanent file uri, which is what gets uploaded. */
  uri: string;
}

interface CaptureContextValue {
  /** The shot on its way to the editor, or null when there is none. */
  capture: CapturedMedia | null;
  /** Synchronous getter for the latest capture (for timing-sensitive reads). */
  getCapture: () => CapturedMedia | null;
  clearCapture: () => void;
  setCapture: (value: CapturedMedia | null) => void;
}

const CaptureContext = createContext<CaptureContextValue>({
  capture: null,
  getCapture: () => null,
  clearCapture: () => {},
  setCapture: () => {},
});

/**
 * Carries a shot's base64 between the screens that handle one, for as long as it is in flight.
 *
 * The base64 is megabytes, so it cannot ride in a route param, and a file uri alone is not enough:
 * the camera hands back a path into a cache that can stop resolving while the user is still
 * looking at the shot. Holding the base64 above the navigator means the editor can render the
 * photo straight out of memory, with the file uri kept only as the fallback and as the thing that
 * gets uploaded.
 */
export function CaptureProvider({ children }: { children: ReactNode }) {
  const [capture, setCaptureState] = useState<CapturedMedia | null>(null);
  const captureRef = useRef<CapturedMedia | null>(null);
  
  const clearCapture = useCallback(() => {
    captureRef.current = null;
    setCaptureState(null);
  }, []);
  
  const setCapture = useCallback((value: CapturedMedia | null) => {
    captureRef.current = value;
    setCaptureState(value);
  }, []);
  
  const getCapture = useCallback(() => captureRef.current, []);
  
  const value = useMemo<CaptureContextValue>(
    () => ({ capture, getCapture, clearCapture, setCapture }),
    [capture, getCapture, clearCapture, setCapture],
  );

  return <CaptureContext.Provider value={value}>{children}</CaptureContext.Provider>;
}

export function useCapture(): CaptureContextValue {
  return useContext(CaptureContext);
}

/**
 * Whether a held capture is the *same shot* as a uri.
 *
 * The capture context and the `imageUri` route param are two independent records of one photo, and
 * they are written by different screens at different times: the param is frozen when Next is
 * tapped, while the context keeps being updated by later reads. Anything that reads one while
 * holding the other has to check they agree, or it will pair photo A's bytes with photo B's path.
 */
export function captureMatchesUri(capture: CapturedMedia | null, uri: string | undefined) {
  return Boolean(capture?.base64) && capture?.uri === uri;
}

/**
 * An image source for a captured photo: the base64 as a data uri, but only when the capture in hand
 * is genuinely the photo at `uri`. Otherwise the file uri, which is always the shot that was
 * navigated with.
 *
 * The uri is the fallback on purpose rather than a lesser option. Base64 exists here to skip the
 * file system, and a wrong answer from it is worse than a slow right one: a mismatch used to be
 * papered over by preferring the base64 regardless of which photo it held, which put a previous
 * capture's image under the photo just taken.
 */
export function toDisplaySource(capture: CapturedMedia | null, uri: string) {
  if (capture?.base64 && capture.uri === uri) {
    return { uri: `data:image/jpeg;base64,${capture.base64}` };
  }

  return { uri };
}