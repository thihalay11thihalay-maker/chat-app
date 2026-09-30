import { Ionicons } from '@expo/vector-icons';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { decode } from 'base64-arraybuffer';
import { CameraType, CameraView, FlashMode, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { onAuthStateChanged, User } from 'firebase/auth';
import { addDoc, collection, doc, getDoc, serverTimestamp } from 'firebase/firestore';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MusicSearchSheet } from '@/components/music-search-sheet';
import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';
import { MusicTrack, toPostSound } from '@/lib/music';
import { getString } from '@/lib/user-data';

const IMAGE_CONTENT_TYPE = 'image/jpeg';
const VIDEO_CONTENT_TYPE = 'video/mp4';
const UPLOAD_ATTEMPTS = 3;

const CLIP_LENGTHS = ['15s', '60s', '3m'] as const;

// Recording stops at whichever of these the user picked, in seconds. expo-camera takes the
// limit in seconds and stops on its own when it is reached.
const CLIP_SECONDS: Record<(typeof CLIP_LENGTHS)[number], number> = {
  '15s': 15,
  '3m': 180,
  '60s': 60,
};

// expo-camera takes zoom as a 0 to 1 fraction of the device's maximum, and it clamps
// anything outside that itself. The bar steps through it in tenths.
const MIN_ZOOM = 0;
const MAX_ZOOM = 1;
const ZOOM_STEP = 0.1;

// The flash cycles through these in order when its tool is tapped.
const FLASH_CYCLE = ['off', 'on', 'auto'] as const;

// The self timer cycles through these, in seconds, where 0 means no delay at all.
const TIMER_CYCLE = [0, 3, 10] as const;

function timerLabel(seconds: number) {
  return seconds === 0 ? 'Off' : `${seconds}s`;
}

const FLASH_ICONS: Record<(typeof FLASH_CYCLE)[number], keyof typeof Ionicons.glyphMap> = {
  // Ionicons has no flash-auto glyph, checked against the shipped glyphmap, so auto borrows
  // sunny as the closest distinct one. The label below carries the exact mode either way.
  auto: 'sunny-outline',
  off: 'flash-off-outline',
  on: 'flash-outline',
};

const FLASH_LABELS: Record<(typeof FLASH_CYCLE)[number], string> = {
  auto: 'Auto',
  off: 'Off',
  on: 'On',
};

const TOOLS: { label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { label: 'Flash', icon: 'flash-off-outline' },
  { label: 'Timer', icon: 'timer-outline' },
  { label: 'Layout', icon: 'grid-outline' },
  { label: 'Crop', icon: 'crop-outline' },
  { label: 'Filter', icon: 'color-filter-outline' },
  { label: 'AI', icon: 'color-wand-outline' },
];

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
const supabaseAccessToken = process.env.EXPO_PUBLIC_SUPABASE_ACCESS_TOKEN || '';
const supabaseBucket = process.env.EXPO_PUBLIC_SUPABASE_BUCKET || 'media';

let supabaseClient: SupabaseClient | null = null;

function isSupabaseConfigured() {
  return Boolean(supabaseUrl && supabaseAnonKey);
}

function getSupabase(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error(
      'Supabase is not configured. Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to .env.local, then restart the dev server.',
    );
  }

  supabaseClient ??= createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: supabaseAccessToken
      ? { headers: { Authorization: `Bearer ${supabaseAccessToken}` } }
      : undefined,
  });

  return supabaseClient;
}

function toErrorDetails(error: unknown) {
  return typeof error === 'object' && error !== null
    ? error as { name?: unknown; message?: unknown; status?: unknown; statusCode?: unknown }
    : {};
}

function errorText(error: unknown) {
  const details = toErrorDetails(error);
  const name = typeof details.name === 'string' ? details.name : '';
  const message = typeof details.message === 'string' ? details.message : '';

  return `${name} ${message}`.toLowerCase();
}

// Android reports connection problems as "fetch failed" plus a nested java.io
// exception, so the string has to be checked instead of the error name.
function isNetworkError(error: unknown) {
  const text = errorText(error);

  return /fetch failed|failed to fetch|network ?request ?failed|networkerror|connectexception|connection ?refused|unable to resolve host|econnreset|econnrefused|etimedout|timeout|socket|load failed|not found/.test(text);
}

function isUnknownHostError(error: unknown) {
  return /unable to resolve host|enotfound|name not resolved|nxdomain|getaddrinfo/.test(errorText(error));
}

function describeError(error: unknown) {
  const details = toErrorDetails(error);
  const message = typeof details.message === 'string' ? details.message : '';
  const statusCode = typeof details.statusCode === 'number'
    ? details.statusCode
    : typeof details.status === 'number'
      ? details.status
      : 0;
  const combined = `${typeof details.name === 'string' ? details.name : ''} ${message}`.toLowerCase();

  if (isUnknownHostError(error)) {
    return `Could not resolve "${supabaseUrl}". Check the Project URL and publishable key in .env.local (Dashboard -> Project Settings -> API), then restart the dev server.`;
  }
  if (isNetworkError(error)) {
    return `This device could not reach Supabase. Your connection dropped while uploading, so the upload was retried ${UPLOAD_ATTEMPTS} times. Check mobile data or Wi-Fi (some networks block Supabase's CDN) and try again.`;
  }
  if (statusCode === 401 || statusCode === 403) {
    return 'Supabase rejected the upload token. Check EXPO_PUBLIC_SUPABASE_ACCESS_TOKEN.';
  }
  if (statusCode === 404 || combined.includes('bucket')) {
    return `Bucket "${supabaseBucket}" was not found. Create it in Supabase Storage, or set EXPO_PUBLIC_SUPABASE_BUCKET.`;
  }
  if (combined.includes('row-level security') || combined.includes('policy')) {
    return 'Supabase Storage policies blocked this upload. Add an INSERT policy for anon and authenticated on the bucket.';
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  return 'Something went wrong.';
}

// Large videos over mobile data drop the connection often enough that a single failed
// request is not enough to call the upload a failure.
async function uploadWithRetry(fileName: string, fileBody: ArrayBuffer | Blob, contentType: string) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      const { error } = await getSupabase()
        .storage.from(supabaseBucket)
        .upload(fileName, fileBody, {
          contentType,
          upsert: true,
        });

      if (!error) {
        return;
      }

      lastError = error;

      if (!isNetworkError(error)) {
        throw error;
      }
    } catch (error) {
      lastError = error;

      if (!isNetworkError(error)) {
        throw error;
      }
    }

    if (attempt < UPLOAD_ATTEMPTS) {
      await new Promise((resolve) => {
        setTimeout(resolve, 800 * attempt);
      });
    }
  }

  throw lastError;
}

export default function UploadScreen() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [media, setMedia] = useState<{
    base64: string;
    contentType: string;
    mediaType: 'image' | 'video';
    uri: string;
  } | null>(null);
  const [caption, setCaption] = useState('');
  const [sound, setSound] = useState<MusicTrack | null>(null);
  const [isPickingSound, setIsPickingSound] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  // Camera state. The mode pills drive the camera itself: PHOTO takes a picture, the
  // durations record a video capped at the chosen length.
  const [mediaMode, setMediaMode] = useState<'video' | 'photo'>('video');
  const [clipLength, setClipLength] = useState<'15s' | '60s' | '3m'>('15s');
  // The caption is a second step: POST opens this, and DONE in the caption bar is what runs
  // the upload. Keeps the camera view clear of a keyboard-eating text field.
  const [showCaptionInput, setShowCaptionInput] = useState(false);

  const [facing, setFacing] = useState<CameraType>('back');
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [flash, setFlash] = useState<FlashMode>(FLASH_CYCLE[0]);
  const [timer, setTimer] = useState<number>(TIMER_CYCLE[0]);
  const [showGrid, setShowGrid] = useState(false);
  // Seconds left on the countdown, or null when nothing is counting. It reaches 0 for one
  // tick before the capture runs, so the number never shows a 0.
  const [countdown, setCountdown] = useState<number | null>(null);
  // Mirrors the zoom level, so a burst of taps always steps from the level that is on screen
  // rather than from a value captured in an older render.
  const zoomRef = useRef(zoom);
  const [isRecording, setIsRecording] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const cameraRef = useRef<CameraView>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
  // Plays back a captured or picked clip. The source follows the selected media, so the
  // player is empty while a photo is showing rather than holding the last clip.
  const previewPlayer = useVideoPlayer(media?.mediaType === 'video' ? media.uri : null, (player) => {
    player.loop = true;
  });

  useEffect(() => {
    let unsubscribe = () => {};

    try {
      unsubscribe = onAuthStateChanged(getFirebaseAuth(), setCurrentUser);
    } catch (error) {
      console.error('Firebase auth is unavailable:', error);
    }

    return unsubscribe;
  }, []);

  useEffect(() => {
    const uid = currentUser?.uid;
    if (!uid) {
      return undefined;
    }

    let isCancelled = false;

    void (async () => {
      try {
        const snapshot = await getDoc(doc(getFirebaseDb(), 'users', uid));
        const data = snapshot.exists() ? snapshot.data() : {};
        const name = getString(data, ['displayName', 'name', 'username']);
        if (!isCancelled) {
          setDisplayName(name || currentUser?.displayName || uid.slice(0, 8));
        }
      } catch (error) {
        console.error('Could not load the profile name:', error);
        if (!isCancelled) {
          setDisplayName(currentUser?.displayName || uid.slice(0, 8));
        }
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [currentUser]);

  // 1. Pick a photo or video. Images come back as base64; videos do not on every
  // platform, so videos are uploaded from the uri with fetch + blob().
  const pickMedia = useCallback(async () => {
    setErrorMessage('');
    setIsPicking(true);

    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission required', 'Allow access to your photos and videos.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: false,
        base64: true,
        mediaTypes: mediaMode === 'photo' ? ['images'] : ['images', 'videos'],
        quality: 1,
      });

      if (result.canceled) {
        return;
      }

      const asset = result.assets[0];
      const mediaType = asset.type === 'video' ? 'video' : 'image';
      const base64 = asset.base64 ?? '';

      if (mediaType === 'image' && !base64) {
        setErrorMessage('Could not get file info. Please try again.');
        return;
      }

      setMedia({
        base64,
        contentType: mediaType === 'video' ? VIDEO_CONTENT_TYPE : IMAGE_CONTENT_TYPE,
        mediaType,
        uri: asset.uri,
      });
    } catch (error) {
      console.error('Could not pick media:', error);
      setErrorMessage('Could not get file info. Please try again.');
    } finally {
      setIsPicking(false);
    }
  }, [mediaMode]);

  // Asks for the camera, and the microphone too when a clip is about to be recorded with
  // sound. Resolves false when a permission was refused, so the caller can say so instead of
  // starting a capture that is guaranteed to fail.
  const ensureCameraPermissions = useCallback(
    async (needsMicrophone: boolean) => {
      if (!cameraPermission?.granted) {
        const result = await requestCameraPermission();
        if (!result.granted) {
          Alert.alert(
            'Camera permission needed',
            'Allow camera access in your device settings to shoot a post.'
          );
          return false;
        }
      }

      if (needsMicrophone && !microphonePermission?.granted) {
        const result = await requestMicrophonePermission();
        if (!result.granted) {
          Alert.alert(
            'Microphone permission needed',
            'Allow microphone access in your device settings to record a clip with sound.'
          );
          return false;
        }
      }

      return true;
    },
    [cameraPermission, microphonePermission, requestCameraPermission, requestMicrophonePermission]
  );

  // Photo mode: one shot, straight into the same media state the gallery fills, so the
  // preview and the upload path are shared with a picked file.
  const capturePhoto = useCallback(async () => {
    if (isCapturing || !cameraRef.current) {
      return;
    }

    setErrorMessage('');

    if (!(await ensureCameraPermissions(false))) {
      return;
    }

    setIsCapturing(true);

    try {
      const picture = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.9 });

      if (!picture) {
        return;
      }

      if (!picture.base64) {
        setErrorMessage('Could not read the photo. Please try again.');
        return;
      }

      setMedia({
        base64: picture.base64,
        contentType: IMAGE_CONTENT_TYPE,
        mediaType: 'image',
        uri: picture.uri,
      });
    } catch (error) {
      console.error('Could not take a photo:', error);
      setErrorMessage('Could not take a photo. Please try again.');
    } finally {
      setIsCapturing(false);
    }
  }, [ensureCameraPermissions, isCapturing]);

  // Video mode: the button starts the recording and the same button stops it, the way a
  // camera app behaves. recordAsync only settles once the recording ends, so it is started
  // without await and the stop is what completes it.
  const toggleRecording = useCallback(async () => {
    if (!cameraRef.current || isCapturing) {
      return;
    }

    setErrorMessage('');

    if (isRecording) {
      cameraRef.current.stopRecording();
      return;
    }

    if (!(await ensureCameraPermissions(true))) {
      return;
    }

    setIsRecording(true);

    try {
      const recording = cameraRef.current.recordAsync({ maxDuration: CLIP_SECONDS[clipLength] });
      const result = await recording;

      // Undefined means the camera was stopped without producing a file, for example by
      // flipping the camera mid recording. Nothing to keep in that case.
      if (!result?.uri) {
        return;
      }

      setMedia({
        // Videos are uploaded from the uri, so no base64 is needed here.
        base64: '',
        contentType: VIDEO_CONTENT_TYPE,
        mediaType: 'video',
        uri: result.uri,
      });
    } catch (error) {
      console.error('Could not record a video:', error);
      setErrorMessage('Could not record a video. Please try again.');
    } finally {
      setIsRecording(false);
    }
  }, [clipLength, ensureCameraPermissions, isCapturing, isRecording]);

  // What the shutter actually does once any countdown is out of the way.
  const startCapture = useCallback(() => {
    if (mediaMode === 'photo') {
      void capturePhoto();
      return;
    }

    void toggleRecording();
  }, [capturePhoto, mediaMode, toggleRecording]);

  const onShutterPress = useCallback(() => {
    // With something already captured the shutter starts over, which is how a camera app
    // behaves: the first press drops back to the viewfinder, the next one shoots.
    if (media) {
      setMedia(null);
      return;
    }

    // A second press mid countdown would start a second one, so it does nothing.
    if (countdown !== null) {
      return;
    }

    if (timer > 0) {
      setCountdown(timer);
      return;
    }

    startCapture();
  }, [countdown, media, startCapture, timer]);

  // Off, on, auto, then back to off.
  const cycleFlash = useCallback(() => {
    setFlash((current) => {
      const next = FLASH_CYCLE.indexOf(current as (typeof FLASH_CYCLE)[number]) + 1;
      return FLASH_CYCLE[next % FLASH_CYCLE.length];
    });
  }, []);

  // No delay, 3 seconds, 10 seconds, then back to no delay.
  const cycleTimer = useCallback(() => {
    setTimer((current) => {
      const next = TIMER_CYCLE.indexOf(current as (typeof TIMER_CYCLE)[number]) + 1;
      return TIMER_CYCLE[next % TIMER_CYCLE.length];
    });
  }, []);

  // Drives the countdown one second at a time, then runs the capture. Both state updates sit
  // inside the timeout rather than in the effect body, and the timeout is cleared on every
  // change and on unmount, so leaving the screen or changing the timer mid countdown never
  // fires a capture in the background.
  useEffect(() => {
    if (countdown === null) {
      return undefined;
    }

    const timeout = setTimeout(() => {
      if (countdown <= 1) {
        setCountdown(null);
        startCapture();
        return;
      }

      setCountdown(countdown - 1);
    }, 1000);

    return () => clearTimeout(timeout);
  }, [countdown, startCapture]);

  // One entry point for every zoom change, so the ref the buttons read can never drift from
  // the state the camera is given.
  const applyZoom = useCallback((value: number) => {
    const next = Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
    zoomRef.current = next;
    setZoom(next);
  }, []);

  // Flipping while recording would stop the recording halfway, so it is ignored until the
  // clip is saved. Zoom goes back to 1x with the flip, because the front and back cameras
  // reach different magnifications and a level carried over would look wrong on one of them.
  const flipCamera = useCallback(() => {
    if (isRecording) {
      return;
    }

    setFacing((current) => (current === 'back' ? 'front' : 'back'));
    applyZoom(MIN_ZOOM);
  }, [applyZoom, isRecording]);

  // Rounded to a tenth on the way in, so repeated taps cannot drift into 0.30000000000000004
  // and leave the bar sitting a hair off the level it claims.
  const stepZoom = useCallback(
    (delta: number) => {
      applyZoom(Math.round((zoomRef.current + delta) / ZOOM_STEP) * ZOOM_STEP);
    },
    [applyZoom]
  );

  const uploadPost = useCallback(async () => {
    if (!currentUser) {
      Alert.alert('Login required', 'You need to be logged in.');
      return;
    }
    if (!media || !caption.trim()) {
      Alert.alert('Missing details', 'Please add a photo/video and a caption.');
      return;
    }

    setIsUploading(true);
    setErrorMessage('');

    const extension = media.mediaType === 'video' ? 'mp4' : 'jpg';
    const fileName = `${currentUser.uid}_${Date.now()}.${extension}`;
    const contentType = media.mediaType === 'video' ? VIDEO_CONTENT_TYPE : IMAGE_CONTENT_TYPE;
    let byteLength = 0;

    try {
      let fileBody: ArrayBuffer | Blob;

      if (media.mediaType === 'video') {
        // 2. Video: base64 is not available, so read the file with fetch and take a blob.
        const response = await fetch(media.uri);

        if (!response.ok) {
          throw new Error(`Could not read the video file (status ${response.status}).`);
        }

        const blob = await response.blob();
        byteLength = blob.size;
        // supabase-js ignores options.contentType for Blob bodies and uses the blob type
        // for the multipart part, so the blob type is set explicitly.
        fileBody = blob.type.startsWith('video/')
          ? blob
          : new Blob([blob], { type: VIDEO_CONTENT_TYPE });
      } else {
        // 1. Image: convert the base64 string into an ArrayBuffer.
        if (!media.base64) {
          throw new Error('Could not get file info. Please try again.');
        }

        const arrayBuffer = decode(media.base64);
        byteLength = arrayBuffer.byteLength;
        fileBody = arrayBuffer;
      }

      // 3. Upload to Supabase Storage. Without contentType it is stored as text/plain.
      await uploadWithRetry(fileName, fileBody, contentType);

      const { data } = getSupabase().storage.from(supabaseBucket).getPublicUrl(fileName);
      const mediaUrl = data.publicUrl;

      // 4. Save the post in the Firestore posts collection.
      await addDoc(collection(getFirebaseDb(), 'posts'), {
        // Started at zero so the comment counter on the post is a real number from the
        // first moment, which is what the transaction in lib/comments.ts reads.
        caption: caption.trim(),
        commentsCount: 0,
        createdAt: serverTimestamp(),
        displayName: displayName || currentUser.displayName || 'User',
        mediaType: media.mediaType,
        mediaUrl,
        // Only copied field by field rather than spreading the search result, so a post can
        // never carry anything the feed does not expect. The attribution fields come along
        // because a CC BY track has to name the artist and the licence.
        ...(sound ? { sound: toPostSound(sound) } : {}),
        userId: currentUser.uid,
      });
    } catch (error) {
      // 5. Detailed error logging
      console.error('Upload failed', {
        bucket: supabaseBucket,
        bytes: byteLength,
        caption: caption.trim(),
        contentType,
        error,
        errorMessage: describeError(error),
        fileName,
        mediaType: media.mediaType,
        source: media.mediaType === 'video' ? 'fetch-blob' : 'base64-arraybuffer',
        supabaseUrl,
        userId: currentUser.uid,
      });
      setErrorMessage(describeError(error));
      setIsUploading(false);
      return;
    }

    setIsUploading(false);
    setCaption('');
    setMedia(null);
    setSound(null);
    setShowCaptionInput(false);
    Alert.alert('Success', 'Post uploaded successfully.');
    router.replace('/home');
  }, [caption, currentUser, displayName, media, sound]);

  const isBusy = isUploading || isPicking;

  const comingSoon = useCallback((label: string) => {
    Alert.alert(label, 'This control is part of the new camera UI. Capture and editing are not wired up yet.');
  }, []);

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.container}
      >
        <View style={styles.topBar}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => router.back()}
          style={styles.circleButton}
        >
          <Ionicons color="#FFFFFF" name="close" size={26} />
        </Pressable>

        <Pressable
          accessibilityLabel={sound ? 'Change sound' : 'Add sound'}
          accessibilityRole="button"
          disabled={isBusy}
          onPress={() => setIsPickingSound(true)}
          style={styles.addSoundButton}
        >
          <Ionicons color="#FFFFFF" name="musical-note" size={18} />
          <Text numberOfLines={1} style={styles.addSoundText}>
            {sound ? sound.title : 'Add sound'}
          </Text>
        </Pressable>

        <Pressable
          accessibilityLabel="Flip camera"
          accessibilityRole="button"
          onPress={flipCamera}
          style={styles.circleButton}
        >
          <Ionicons color="#FFFFFF" name="camera-reverse-outline" size={24} />
        </Pressable>
      </View>

      <View pointerEvents="box-none" style={styles.stage}>
        {/* box-none on both this and the stage: the containers themselves never take a touch,
            only what is inside them does, so an overlay can never swallow the pinch meant
            for the viewfinder underneath. */}
        <View pointerEvents="box-none" style={styles.preview}>
          {media ? (
            <>
              {media.mediaType === 'image' ? (
                <Image contentFit="cover" source={{ uri: media.uri }} style={styles.previewMedia} />
              ) : (
                <VideoView contentFit="cover" nativeControls={false} player={previewPlayer} style={styles.previewMedia} />
              )}
              <Pressable onPress={() => setMedia(null)} style={styles.changeTag}>
                <Text style={styles.changeTagText}>Retake</Text>
              </Pressable>
            </>
          ) : cameraPermission?.granted ? (
            <CameraView
              facing={facing}
              flash={flash}
              mode={mediaMode === 'photo' ? 'picture' : 'video'}
              onCameraReady={() => setIsCameraReady(true)}
              onMountError={(event) => {
                setIsCameraReady(false);
                setErrorMessage(`Camera unavailable: ${event.message}`);
              }}
              ref={cameraRef}
              style={styles.previewMedia}
              zoom={zoom}
            />
          ) : (
            <View style={styles.previewEmpty}>
              {cameraPermission === null ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <>
                  <Ionicons color="rgba(255, 255, 255, 0.45)" name="videocam-outline" size={44} />
                  <Text style={styles.previewEmptyText}>Camera access is off</Text>
                  <Pressable
                    accessibilityLabel="Allow camera access"
                    accessibilityRole="button"
                    onPress={() => void requestCameraPermission()}
                    style={styles.permissionButton}
                  >
                    <Text style={styles.permissionButtonText}>Allow camera</Text>
                  </Pressable>
                </>
              )}
            </View>
          )}

          {showGrid ? (
            <View pointerEvents="none" style={styles.gridOverlay}>
              <View style={styles.gridLineVertical} />
              <View style={styles.gridColumnRight} />
              <View style={styles.gridLineHorizontal} />
              <View style={styles.gridRowBottom} />
            </View>
          ) : null}

          {countdown !== null && countdown > 0 ? (
            <View pointerEvents="none" style={styles.countdownOverlay}>
              <Text style={styles.countdownText}>{countdown}</Text>
            </View>
          ) : null}

          {zoom > 0 ? (
            <View pointerEvents="none" style={styles.zoomBadge}>
              <Text style={styles.zoomBadgeText}>{`${(1 + zoom).toFixed(1)}x`}</Text>
            </View>
          ) : null}

          {isRecording ? (
            <View pointerEvents="none" style={styles.recordingBadge}>
              <View style={styles.recordingDot} />
              <Text style={styles.recordingText}>{`Recording, up to ${clipLength}`}</Text>
            </View>
          ) : null}

          {!isSupabaseConfigured() ? (
            <View pointerEvents="none" style={styles.supabaseNotice}>
              <Text style={styles.supabaseNoticeText}>
                Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to .env.local, then restart the dev
                server.
              </Text>
            </View>
          ) : null}
        </View>

        <ScrollView
          contentContainerStyle={styles.toolRailContent}
          showsVerticalScrollIndicator={false}
          style={styles.toolRail}
        >
          {TOOLS.map((tool) => {
            // Flash drives the camera, so it shows the live mode and its own label. Everything
            // else is still a placeholder.
            if (tool.label === 'Flash') {
              const mode = flash as (typeof FLASH_CYCLE)[number];

              return (
                <Pressable
                  key={tool.label}
                  accessibilityLabel={`Flash, currently ${FLASH_LABELS[mode]}`}
                  accessibilityRole="button"
                  onPress={cycleFlash}
                  style={styles.toolItem}
                >
                  <View style={styles.toolButton}>
                    <Ionicons color="#FFFFFF" name={FLASH_ICONS[mode]} size={20} />
                  </View>
                  <Text style={styles.toolLabel}>{FLASH_LABELS[mode]}</Text>
                </Pressable>
              );
            }

            if (tool.label === 'Timer') {
              return (
                <Pressable
                  key={tool.label}
                  accessibilityLabel={`Self timer, currently ${timerLabel(timer)}`}
                  accessibilityRole="button"
                  onPress={cycleTimer}
                  style={styles.toolItem}
                >
                  <View style={styles.toolButton}>
                    <Ionicons
                      color={timer > 0 ? '#FE2C55' : '#FFFFFF'}
                      name={tool.icon}
                      size={20}
                    />
                  </View>
                  <Text style={styles.toolLabel}>{timerLabel(timer)}</Text>
                </Pressable>
              );
            }

            if (tool.label === 'Layout') {
              return (
                <Pressable
                  key={tool.label}
                  accessibilityLabel={`Composition grid, ${showGrid ? 'on' : 'off'}`}
                  accessibilityRole="button"
                  onPress={() => setShowGrid((current) => !current)}
                  style={styles.toolItem}
                >
                  <View style={styles.toolButton}>
                    <Ionicons color={showGrid ? '#FE2C55' : '#FFFFFF'} name={tool.icon} size={20} />
                  </View>
                  <Text style={styles.toolLabel}>{tool.label}</Text>
                </Pressable>
              );
            }

            return (
              <Pressable
                key={tool.label}
                accessibilityLabel={tool.label}
                accessibilityRole="button"
                onPress={() => comingSoon(tool.label === 'AI' ? 'AI Features' : tool.label)}
                style={styles.toolItem}
              >
                <View style={styles.toolButton}>
                  <Ionicons color="#FFFFFF" name={tool.icon} size={20} />
                </View>
                <Text style={styles.toolLabel}>{tool.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {errorMessage ? (
        <Text numberOfLines={2} style={styles.errorText}>
          {errorMessage}
        </Text>
      ) : null}

      {/* Bottom cluster, in normal flow from here down: mode row, shutter row, caption bar,
          then the POST and CREATE row. Absolute offsets kept colliding with the shutter row
          because every number had to be measured against the screen bottom. */}
      <View style={styles.modeRow}>
        {CLIP_LENGTHS.map((length) => (
          <Pressable
            key={length}
            accessibilityRole="button"
            onPress={() => setClipLength(length)}
            style={[styles.modePill, clipLength === length && styles.modePillActive]}
          >
            <Text style={[styles.modePillText, clipLength === length && styles.modePillTextActive]}>
              {length}
            </Text>
          </Pressable>
        ))}

        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setMediaMode(mediaMode === 'photo' ? 'video' : 'photo');
            setMedia(null);
          }}
          style={[styles.modePill, mediaMode === 'photo' && styles.modePillActive]}
        >
          <Text style={[styles.modePillText, mediaMode === 'photo' && styles.modePillTextActive]}>PHOTO</Text>
        </Pressable>

        <Pressable accessibilityRole="button" onPress={() => comingSoon('Text')} style={styles.modePill}>
          <Text style={styles.modePillText}>TEXT</Text>
        </Pressable>
      </View>

      {/* Zoom bar, directly above the shutter row. Only rendered while the viewfinder is up:
          with a photo or clip already captured there is no camera for it to move. */}
      {!media && cameraPermission?.granted ? (
        <View style={styles.zoomRow}>
          <Pressable
            accessibilityLabel="Zoom out"
            accessibilityRole="button"
            disabled={zoom <= MIN_ZOOM}
            hitSlop={8}
            onPress={() => stepZoom(-ZOOM_STEP)}
            style={styles.zoomButton}
          >
            <Ionicons
              color={zoom <= MIN_ZOOM ? 'rgba(255, 255, 255, 0.3)' : '#FFFFFF'}
              name="remove-circle-outline"
              size={28}
            />
          </Pressable>

          <View style={styles.zoomTrack}>
            <View style={[styles.zoomFill, { width: `${zoom * 100}%` }]} />
          </View>

          <Pressable
            accessibilityLabel="Zoom in"
            accessibilityRole="button"
            disabled={zoom >= MAX_ZOOM}
            hitSlop={8}
            onPress={() => stepZoom(ZOOM_STEP)}
            style={styles.zoomButton}
          >
            <Ionicons
              color={zoom >= MAX_ZOOM ? 'rgba(255, 255, 255, 0.3)' : '#FFFFFF'}
              name="add-circle-outline"
              size={28}
            />
          </Pressable>
        </View>
      ) : null}

      <View style={styles.shutterRow}>
        <Pressable
          accessibilityLabel="Open gallery"
          accessibilityRole="button"
          disabled={isBusy}
          onPress={() => void pickMedia()}
          style={[styles.galleryButton, isBusy && styles.disabled]}
        >
          {media ? (
            <Image contentFit="cover" source={{ uri: media.uri }} style={styles.galleryImage} />
          ) : (
            <Ionicons color="#FFFFFF" name="images-outline" size={22} />
          )}
        </Pressable>

        <Pressable
          accessibilityLabel={isRecording ? 'Stop recording' : countdown !== null ? 'Cancel countdown' : media ? 'Retake' : 'Record'}
          accessibilityRole="button"
          disabled={!media && (!isCameraReady || countdown !== null)}
          onPress={onShutterPress}
          style={({ pressed }) => [styles.shutterOuter, pressed && styles.pressed]}
        >
          <View style={[styles.shutterInner, isRecording && styles.shutterInnerRecording]} />
        </Pressable>

        <Pressable
          accessibilityLabel="Effects"
          accessibilityRole="button"
          onPress={() => comingSoon('Effects')}
          style={styles.galleryButton}
        >
          <Ionicons color="#FFFFFF" name="sparkles-outline" size={22} />
        </Pressable>
      </View>

      {showCaptionInput ? (
        <View style={styles.captionBar}>
          <TextInput
            editable={!isUploading}
            maxLength={220}
            onChangeText={setCaption}
            placeholder="Write a caption..."
            placeholderTextColor="rgba(255, 255, 255, 0.5)"
            style={styles.captionField}
            value={caption}
          />
          <Pressable
            accessibilityLabel="Upload post"
            accessibilityRole="button"
            disabled={isBusy}
            onPress={() => void uploadPost()}
            style={({ pressed }) => [styles.captionDone, pressed && styles.pressed, isBusy && styles.disabled]}
          >
            {isUploading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.captionDoneText}>DONE</Text>
            )}
          </Pressable>
        </View>
      ) : null}

      <View style={styles.bottomBar}>
        <Pressable
          accessibilityLabel="Add a caption and continue"
          accessibilityRole="button"
          onPress={() => setShowCaptionInput(true)}
          style={({ pressed }) => [styles.postButton, pressed && styles.pressed]}
        >
          <Text style={styles.postButtonText}>POST</Text>
        </Pressable>

        <Pressable
          accessibilityLabel="Start over"
          accessibilityRole="button"
          disabled={isBusy}
          onPress={() => {
            setMedia(null);
            setCaption('');
            setSound(null);
            setShowCaptionInput(false);
          }}
          style={({ pressed }) => [styles.createButton, pressed && styles.pressed, isBusy && styles.disabled]}
        >
          <Text style={styles.createButtonText}>CREATE</Text>
        </Pressable>
      </View>
      </KeyboardAvoidingView>

      <MusicSearchSheet
        onClose={() => setIsPickingSound(false)}
        onSelect={(track) => {
          setSound(track);
          setIsPickingSound(false);
        }}
        selectedId={sound?.id}
        visible={isPickingSound}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#000000',
    flex: 1,
  },
  container: {
    flex: 1,
  },
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    // X hard left, Add sound centred, flip camera hard right.
    justifyContent: 'space-between',
    paddingHorizontal: 15,
  },
  circleButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  addSoundButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 6,
    maxWidth: '52%',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  addSoundText: {
    color: '#FFFFFF',
    flexShrink: 1,
    fontSize: 14,
    fontWeight: '700',
  },
  stage: {
    flex: 1,
    marginTop: 10,
  },
  preview: {
    backgroundColor: '#0C0C0F',
    bottom: 0,
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    // Stops short of the tool rail, which now occupies 12 to 52 from the right edge.
    right: 56,
    top: 0,
  },
  previewMedia: {
    height: '100%',
    width: '100%',
  },
  changeTag: {
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    position: 'absolute',
    right: 12,
    top: 12,
  },
  changeTagText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  previewEmpty: {
    alignItems: 'center',
    flex: 1,
    gap: 12,
    justifyContent: 'center',
  },
  previewEmptyText: {
    color: 'rgba(255, 255, 255, 0.45)',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  supabaseNotice: {
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    borderRadius: 10,
    left: 12,
    padding: 10,
    position: 'absolute',
    right: 12,
    top: 12,
  },
  supabaseNoticeText: {
    color: '#F2D9B4',
    fontSize: 11,
    lineHeight: 16,
  },
  // Sits under the selected media, above the POST and CREATE row, and only exists once the
  // user has asked for the caption step.
  captionBar: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 15,
    paddingVertical: 10,
  },
  captionField: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderColor: 'rgba(255, 255, 255, 0.28)',
    borderRadius: 999,
    borderWidth: 1,
    color: '#FFFFFF',
    flex: 1,
    fontSize: 14,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  captionDone: {
    alignItems: 'center',
    backgroundColor: '#FE2C55',
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 20,
  },
  captionDoneText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 1,
  },
  toolRail: {
    // Pinned inside the stage, which ends above the mode row and the shutter row, so the
    // stack can no longer grow out of it and land on TEXT or on the effects button. The 12
    // below keeps the last tool off the stage edge and off the row underneath.
    bottom: 12,
    position: 'absolute',
    right: 12,
    top: 0,
  },
  toolRailContent: {
    alignItems: 'center',
    // Centres the tools in the space available, and scrolls instead of overflowing when a
    // short screen cannot fit all six. Six tools are about 400 tall, which does not fit the
    // stage on a small phone.
    flexGrow: 1,
    gap: 15,
    justifyContent: 'center',
  },
  toolItem: {
    alignItems: 'center',
    gap: 3,
  },
  toolButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.42)',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  toolLabel: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '600',
  },
  modeRow: {
    alignItems: 'center',
    // In normal flow, directly above the shutter row. The 12 below is the clear gap: the two
    // rows can never overlap now, whatever height the shutter or the caption bar takes.
    flexDirection: 'row',
    // Spreads the five pills across the width instead of measuring a fixed gap that clipped
    // on a 360dp screen. The pills keep their own size, so the space goes between them.
    justifyContent: 'space-between',
    paddingBottom: 12,
    paddingHorizontal: 15,
    paddingTop: 10,
    width: '100%',
  },
  modePill: {
    borderColor: 'rgba(255, 255, 255, 0.4)',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  modePillActive: {
    backgroundColor: '#FFFFFF',
    borderColor: '#FFFFFF',
  },
  modePillText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  modePillTextActive: {
    color: '#000000',
  },
  zoomRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
    paddingBottom: 10,
    width: '100%',
  },
  zoomButton: {
    alignItems: 'center',
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  zoomTrack: {
    backgroundColor: 'rgba(255, 255, 255, 0.22)',
    borderRadius: 999,
    flex: 1,
    height: 5,
    justifyContent: 'center',
    maxWidth: 190,
    overflow: 'hidden',
  },
  zoomFill: {
    backgroundColor: '#FFFFFF',
    borderRadius: 999,
    height: '100%',
  },
  shutterRow: {
    alignItems: 'center',
    // space-around rather than space-between: the record button lands in the middle of the
    // screen with the gallery and effects sitting the same distance out on either side, and
    // no side padding is needed to keep them off the edges.
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingBottom: 12,
    paddingTop: 2,
    width: '100%',
  },
  galleryButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    borderColor: 'rgba(255, 255, 255, 0.5)',
    borderRadius: 10,
    borderWidth: 1,
    height: 46,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 46,
  },
  galleryImage: {
    height: '100%',
    width: '100%',
  },
  permissionButton: {
    backgroundColor: '#FE2C55',
    borderRadius: 999,
    marginTop: 6,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  permissionButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  // Two vertical and two horizontal one pixel lines, spaced by a third of the preview each,
  // which is what makes the nine thirds. A line is a background colour rather than a border:
  // it draws the same single pixel without needing a wrapper per line.
  gridOverlay: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  gridLineVertical: {
    backgroundColor: 'rgba(255, 255, 255, 0.5)',
    bottom: 0,
    left: '33.333%',
    position: 'absolute',
    top: 0,
    width: 1,
  },
  gridColumnRight: {
    backgroundColor: 'rgba(255, 255, 255, 0.5)',
    bottom: 0,
    left: '66.666%',
    position: 'absolute',
    top: 0,
    width: 1,
  },
  gridLineHorizontal: {
    backgroundColor: 'rgba(255, 255, 255, 0.5)',
    height: 1,
    left: 0,
    position: 'absolute',
    right: 0,
    top: '33.333%',
  },
  gridRowBottom: {
    backgroundColor: 'rgba(255, 255, 255, 0.5)',
    height: 1,
    left: 0,
    position: 'absolute',
    right: 0,
    top: '66.666%',
  },
  countdownOverlay: {
    alignItems: 'center',
    // alignSelf plus no left or right is what centres an absolutely positioned child in
    // React Native; pinning both edges with a fixed width would not.
    alignSelf: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    borderColor: 'rgba(255, 255, 255, 0.35)',
    borderRadius: 60,
    borderWidth: 2,
    height: 120,
    justifyContent: 'center',
    position: 'absolute',
    top: '35%',
    width: 120,
  },
  countdownText: {
    color: '#FFFFFF',
    fontSize: 64,
    fontWeight: '900',
  },
  zoomBadge: {
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: 999,
    // Bottom left rather than the top corner the recording badge uses, so a clip that is
    // being recorded at a zoom does not show the two on top of each other.
    bottom: 12,
    left: 12,
    paddingHorizontal: 11,
    paddingVertical: 6,
    position: 'absolute',
  },
  zoomBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
  },
  recordingBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 7,
    left: 12,
    paddingHorizontal: 11,
    paddingVertical: 6,
    position: 'absolute',
    top: 12,
  },
  recordingDot: {
    backgroundColor: '#FE2C55',
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  recordingText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  shutterOuter: {
    alignItems: 'center',
    borderColor: '#FFFFFF',
    borderRadius: 40,
    borderWidth: 4,
    height: 80,
    justifyContent: 'center',
    width: 80,
  },
  shutterInner: {
    backgroundColor: '#FE2C55',
    borderRadius: 31,
    height: 62,
    width: 62,
  },
  // Square while recording, the way a camera app shows that it is already capturing.
  shutterInnerRecording: {
    borderRadius: 12,
    height: 36,
    width: 36,
  },
  errorText: {
    color: '#FF6B6B',
    fontSize: 12,
    paddingHorizontal: 15,
    paddingVertical: 6,
  },
  bottomBar: {
    // Fixed width buttons rather than flex 1: the pair is a compact centred block instead of
    // a bar that fills the screen, and both buttons are the same width because the same
    // value is on each of them.
    flexDirection: 'row',
    gap: 15,
    justifyContent: 'center',
    paddingBottom: 18,
    paddingTop: 4,
  },
  postButton: {
    alignItems: 'center',
    backgroundColor: '#FE2C55',
    borderRadius: 10,
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: 12,
    // Percentage based so the pair keeps its proportions on a narrow phone instead of the
    // fixed 160 clipping the label on the smallest widths.
    width: '32%',
  },
  postButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 1.2,
  },
  createButton: {
    alignItems: 'center',
    borderColor: 'rgba(255, 255, 255, 0.45)',
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: 12,
    width: '32%',
  },
  createButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.72,
  },
});
