import { Ionicons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import { CameraType, CameraView, FlashMode, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { router, useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
// React Native's Image rather than expo-image: expo-image cannot open a local file:// uri on
// Android, and every image here is a local capture or a local library pick.
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCapture } from '@/components/capture-provider';
import { FilteredImage } from '@/components/filtered-image';
import { FilterSheet } from '@/components/filter-sheet';
import { MusicSearchSheet } from '@/components/music-search-sheet';
import { applyFilterToImageFile } from '@/lib/apply-filter';
import { DEFAULT_FILTER_ID, toCameraFilter } from '@/lib/filters';
import type { CameraFilter } from '@/lib/filters';
import { MusicTrack } from '@/lib/music';
import {
  IMAGE_CONTENT_TYPE,
  isSupabaseConfigured,
  VIDEO_CONTENT_TYPE,
} from '@/lib/upload-post';

type UploadMode = 'PHOTO' | 'TEXT' | 'VIDEO';

// Order is the order the pills appear in, left to right. 15s is the default selection, so it
// is named rather than read off the front of this list. expo-camera takes the cap in seconds
// and stops on its own when it is reached.
const CLIP_LENGTHS = ['3m', '60s', '15s'] as const;

const CLIP_SECONDS: Record<(typeof CLIP_LENGTHS)[number], number> = {
  '15s': 15,
  '3m': 180,
  '60s': 60,
};

// The stops under the zoom slider, left to right. expo-camera's zoom is a 0 to 1 fraction of
// whatever the device's own maximum is, and SDK 57 exposes no way to ask for that maximum, so
// these are positions along the slider rather than measured magnifications: on a phone with a
// periscope lens the top stop really is far more than 3x, and on one without it the top stop is
// well under 3x. Swapping the labels for real multiples needs the device maximum first.
const ZOOM_STOPS = [
  { label: '1x', value: 0 },
  { label: '2x', value: 0.5 },
  { label: '3x', value: 1 },
] as const;

// The flash cycles through these in order when its tool is tapped.
const FLASH_CYCLE = ['off', 'on', 'auto'] as const;

// The self timer cycles through these, in seconds, where 0 means no delay at all.
const TIMER_CYCLE = [0, 3, 10] as const;

// Text posts have no camera frame behind them, so the post gets one of these as a flat
// background instead. The feed paints the colour where it would paint the media.
const TEXT_BACKGROUNDS = ['#FE2C55', '#FF7A00', '#FFD166', '#2BC46A', '#2D7FF9', '#8A5CFF'] as const;

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

type Capture = {
  base64: string;
  contentType: string;
  /** The filter that was written into the file, so the preview never claims a look it lacks. */
  filterId?: string;
  mediaType: 'image' | 'video';
  uri: string;
};

export default function UploadScreen() {
  // The captured shot, or the one picked from the gallery. While this is set the live viewfinder
  // is unmounted and the shot is shown full screen instead; clearing it puts the camera back.
  // A recorded clip lands here too, which is why the value is a Capture and not a bare uri.
  const [capturedImage, setCapturedImage] = useState<Capture | null>(null);
  const [sound, setSound] = useState<MusicTrack | null>(null);
  const [isPickingSound, setIsPickingSound] = useState(false);
  // The look chosen in the filter sheet. It is a preview only: the layers below are drawn over
  // the frame, and the file that gets posted is still the one the camera wrote.
  const [selectedFilterId, setSelectedFilterId] = useState(DEFAULT_FILTER_ID);
  const [isPickingFilter, setIsPickingFilter] = useState(false);
  // True while the chosen filter is being written to the file the post will use.
  const [isFiltering, setIsFiltering] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  // One selection for the whole row. VIDEO is entered by picking a duration, PHOTO and TEXT by
  // picking those pills, and because the highlight is read off this single value only one pill
  // in the row can be lit at a time. It opens on PHOTO, so the durations start unlit.
  const [selectedMode, setSelectedMode] = useState<UploadMode>('PHOTO');
  const [selectedDuration, setSelectedDuration] = useState<(typeof CLIP_LENGTHS)[number]>('15s');
  const [selectedTextColor, setSelectedTextColor] = useState<string>(TEXT_BACKGROUNDS[0]);
  // The number still to run down before a capture fires, or null when no countdown is running.
  // The self timer itself stays in `timer`; this is only the on-screen countdown it drives.
  const [countdown, setCountdown] = useState<number | null>(null);

  const [facing, setFacing] = useState<CameraType>('back');
  // 0 is the wide camera, 1 is the device's own maximum. The slider writes here and the camera
  // reads it, so a half dragged thumb and a tapped 2x stop land on the same value.
  const [zoom, setZoom] = useState(0);
  const [flash, setFlash] = useState<FlashMode>(FLASH_CYCLE[0]);
  const [timer, setTimer] = useState<number>(TIMER_CYCLE[0]);
  const [showGrid, setShowGrid] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const cameraRef = useRef<CameraView>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
  // Plays back a captured clip in the preview. The source follows the captured shot, so the player
  // is empty while a photo is showing rather than holding the last clip.
  const previewPlayer = useVideoPlayer(capturedImage?.mediaType === 'video' ? capturedImage.uri : null, (player) => {
    player.loop = true;
    player.muted = true;
  });

  const { getCapture, setCapture } = useCapture();
  // Read off the id once per render so the overlay, the tool label and the sheet all agree on
  // which look is chosen, and an id that no longer exists falls back to the untouched frame.
  const selectedFilter = toCameraFilter(selectedFilterId);
  // The shot the background read below belongs to. A read that finishes after the user has moved
  // on would otherwise land the bytes of a discarded shot on the one now being posted.
  const latestShotUri = useRef('');

  // Puts a finished shot on the stage and starts reading its bytes for the upload.
  //
  // The uri is what the preview and the Next button use straight away, so the shot is on screen
  // the moment the file exists rather than the moment its bytes have been read.
  const showShot = useCallback((shot: Capture) => {
    // Normalised rather than left blank, so "no filter" is the same value everywhere it is read.
    const ready: Capture = { ...shot, filterId: shot.filterId ?? DEFAULT_FILTER_ID };

    // The shot becomes the current one here, before its bytes are read. A filtered photo arrives
    // with a uri that was never seen by keepShot, so the mark has to follow the file that is
    // actually on screen; otherwise the read below is rejected as stale and the bytes are thrown
    // away, leaving every filtered post on the slower fetch path.
    latestShotUri.current = ready.uri;
    setCapturedImage(ready);
    setCapture({ base64: '', mediaType: ready.mediaType, uri: ready.uri });

    if (ready.mediaType !== 'image') {
      return;
    }

    // The bytes are read after the shot is already on screen. Asking the camera for its base64
    // before takePictureAsync resolves is what used to hold the preview back for a second or
    // more after the shutter: the photo is megabytes, and encoding it into a string that crosses
    // the bridge is what took the time. Reading it here keeps the capture instant and still gives
    // the upload a body that does not depend on the cache path staying readable.
    void (async () => {
      try {
        const base64 = await new File(ready.uri).base64();

        if (latestShotUri.current !== ready.uri) {
          return;
        }

        setCapture({ base64, mediaType: 'image', uri: ready.uri });
      } catch (error) {
        // The shot still previews and still uploads from its uri, so a failed read only costs the
        // second, slower upload path.
        console.warn('Could not read the captured photo for upload:', error);
      }
    })();
  }, [setCapture]);

  // Writes the chosen look into a photo that is on screen and does not have it yet.
  //
  // Shared by the shutter and the filter sheet, so a look picked after the shot is taken is
  // written into the file the same way one picked before it is, rather than living only as a tint
  // over a photo that was never touched.
  const applyFilterToShot = useCallback(async (shot: Capture, filter: CameraFilter) => {
    setIsFiltering(true);

    try {
      const filteredUri = await applyFilterToImageFile(shot.uri, filter.matrix);

      // The shot can be discarded, or replaced by a newer one, while it is being processed. Either
      // way the file this call produced belongs to a shot nobody is looking at any more.
      if (latestShotUri.current !== shot.uri) {
        return;
      }

      if (!filteredUri) {
        // Unfiltered is a usable result: the photo still posts, it just is not the look that was
        // picked, which is worth saying out loud rather than passing off as the real thing.
        setErrorMessage(`Could not apply the ${filter.label} filter. The photo was kept as taken.`);
        showShot(shot);
        return;
      }

      showShot({ ...shot, filterId: filter.id, uri: filteredUri });
    } finally {
      setIsFiltering(false);
    }
  }, [showShot]);

  // Every shot ends up here, whether it was captured or picked. Nothing navigates yet: the shot
  // takes over the stage, and Next is what moves the flow on.
  //
  // A photo is shown the moment its file exists, so the capture feels instant. A photo that has to
  // be filtered waits for its own processing instead, because showing the unfiltered frame first
  // and swapping it a moment later reads as a glitch on the very thing the user just chose.
  const keepShot = useCallback(async (next: Capture) => {
    const uri = next.uri.trim();

    if (!uri) {
      setErrorMessage('Could not read that file. Please try again.');
      return;
    }

    const shot = { ...next, uri };

    latestShotUri.current = shot.uri;
    const filter = toCameraFilter(selectedFilterId);

    if (shot.mediaType !== 'image' || filter.id === DEFAULT_FILTER_ID) {
      showShot(shot);
      return;
    }

    await applyFilterToShot(shot, filter);
  }, [applyFilterToShot, selectedFilterId, showShot]);

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
        // No base64 here either: it is what made a pick take as long as a capture. keepShot reads
        // the bytes afterwards, off the same path the camera uses.
        mediaTypes: selectedMode === 'PHOTO' ? ['images'] : ['images', 'videos'],
        quality: 1,
      });

      if (result.canceled) {
        return;
      }

      const asset = result.assets[0];
      const mediaType = asset.type === 'video' ? 'video' : 'image';

      if (!asset.uri) {
        setErrorMessage('Could not get file info. Please try again.');
        return;
      }

      // The original uri is kept as it came. Nothing is copied into app storage here: the file
      // is uploaded from this uri when the post is published.
      await keepShot({
        base64: '',
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
  }, [keepShot, selectedMode]);

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

  // Photo mode: one shot, straight into the same media state the gallery fills, so the preview
  // and the upload path are shared with a picked file. There is no navigation here on purpose.
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
      const picture = await cameraRef.current.takePictureAsync({ quality: 0.8 });

      if (!picture?.uri) {
        return;
      }

      await keepShot({
        base64: '',
        contentType: IMAGE_CONTENT_TYPE,
        mediaType: 'image',
        // The original camera uri is passed straight through. It is the value Next hands to the
        // caption screen and the value that gets uploaded.
        uri: picture.uri,
      });
    } catch (error) {
      console.error('Could not take a photo:', error);
      setErrorMessage('Could not take a photo. Please try again.');
    } finally {
      setIsCapturing(false);
    }
  }, [ensureCameraPermissions, isCapturing, keepShot]);

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
      const result = await cameraRef.current.recordAsync({ maxDuration: CLIP_SECONDS[selectedDuration] });

      // Undefined means the camera was stopped without producing a file, for example by
      // flipping the camera mid recording. Nothing to keep in that case.
      if (!result?.uri) {
        return;
      }

      await keepShot({
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
  }, [selectedDuration, ensureCameraPermissions, isCapturing, isRecording, keepShot]);

  // What one capture does, which is what the self timer counts down to. The mode is passed in
  // rather than read from state so a countdown cannot fire into a mode the user has since left.
  const runCapture = useCallback(
    (mode: UploadMode) => {
      if (mode === 'PHOTO') {
        void capturePhoto();
        return;
      }

      if (mode === 'TEXT') {
        console.log('Text post background selected:', selectedTextColor);
        return;
      }

      void toggleRecording();
    },
    [capturePhoto, selectedTextColor, toggleRecording],
  );

  const cancelCountdown = useCallback(() => {
    setCountdown(null);
  }, []);

  // Ticks once a second and fires the capture on the last beat. Driven from state rather than an
  // interval so a cancelled countdown really does stop, instead of leaving a timer that fires
  // into an unmounted screen.
  useEffect(() => {
    if (countdown === null) {
      return undefined;
    }

    const id = setTimeout(() => {
      if (countdown <= 1) {
        setCountdown(null);
        runCapture(selectedMode);
      } else {
        setCountdown(countdown - 1);
      }
    }, 1000);

    return () => clearTimeout(id);
  }, [countdown, runCapture, selectedMode]);

  // What the record button does. With the self timer on, the first tap only starts the countdown
  // and the capture follows on its own; a second tap cancels it.
  const onRecordPress = useCallback(() => {
    if (countdown !== null) {
      cancelCountdown();
      return;
    }

    if (isRecording) {
      // The button stops its own recording rather than starting a second one.
      void toggleRecording();
      return;
    }

    // A text post is not a camera capture, so there is nothing for the self timer to wait for.
    if (timer > 0 && selectedMode !== 'TEXT') {
      setCountdown(timer);
      return;
    }

    runCapture(selectedMode);
  }, [cancelCountdown, countdown, isRecording, runCapture, selectedMode, timer, toggleRecording]);

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

  // Flipping mid recording would stop the clip halfway, so it waits until the clip is saved. A
  // countdown is left alone for the same reason: the shot it is about to take would not be the
  // one the user was framing.
  const flipCamera = useCallback(() => {
    if (isRecording || countdown !== null) {
      return;
    }

    setFacing((current) => (current === 'back' ? 'front' : 'back'));
  }, [countdown, isRecording]);

// The camera screen only captures. The title, the caption and the upload itself belong to the
  // post details screen.
  const isBusy = isPicking;

  const comingSoon = useCallback((label: string) => {
    Alert.alert(label, 'This control is part of the new camera UI. Capture and editing are not wired up yet.');
  }, []);

  // Throws the shot away and puts the live viewfinder back. The capture held for the caption
  // screen goes with it, or the next visit would preview the photo that was just discarded.
  const discardShot = useCallback(() => {
    setCapturedImage(null);
    setCapture(null);
    // The mark of the current shot goes too. Left behind, it names a photo that is no longer on
    // screen, and the next read that lands would be compared against it instead of against the new
    // shot.
    latestShotUri.current = '';
    cancelCountdown();
  }, [cancelCountdown, setCapture]);

  /**
   * Drops the shot once the post it belonged to has been published.
   *
   * A successful post clears the capture context and then navigates to the feed, so this screen
   * comes back to focus with its own `capturedImage` still holding the photo that was just posted.
   * The tab stays mounted, which is the whole reason this is needed: without it the next visit
   * opens on the previous post's photo and Next would publish it a second time.
   *
   * The capture context is what decides between "just posted" and "came back without posting", so
   * going back from the caption screen leaves the shot alone and only a consumed capture discards
   * it. The synchronous getter is read rather than the state value, because this must run once per
   * focus: depending on the live capture would re-fire the moment a new shot's bytes arrive and
   * throw away the photo being framed.
   */
  useFocusEffect(
    useCallback(() => {
      if (getCapture()) {
        return;
      }

      setCapturedImage(null);
      latestShotUri.current = '';
    }, [getCapture]),
  );

  // True while the captured shot owns the stage instead of the viewfinder. Every camera control
  // is read off this one value, so nothing has to be switched off a row at a time.
  const isPreviewing = Boolean(capturedImage);
  // A photo is only "filtered on disk" when a filter was chosen before it was taken. A shot taken
  // without one, or a clip, keeps the tint layers instead, and picking a filter afterwards cannot
  // be right because the file behind the preview was already written.
  const isFilteredOnDisk = Boolean(capturedImage)
    && capturedImage?.mediaType === 'image'
    && selectedFilter.id !== DEFAULT_FILTER_ID
    && capturedImage?.filterId === selectedFilter.id;

  // A photo on screen whose file does not carry the chosen filter: it was taken with no filter, or
  // a filter was picked after it was taken. Skia draws the real matrix over it there, which is the
  // only case where a matrix belongs on top of a photo.
  const showsMatrixPreview = Boolean(capturedImage)
    && capturedImage?.mediaType === 'image'
    && selectedFilter.id !== DEFAULT_FILTER_ID
    && !isFilteredOnDisk;

  // The tints stand in for the matrix where Skia cannot reach: the live viewfinder, which is a
  // native surface Skia cannot wrap, and a clip, which is never processed. They are suppressed the
  // moment a photo is showing the real matrix, or they would be laid over a correct preview and
  // push it further than the filter goes.
  const showsTintLayers = !showsMatrixPreview && selectedFilter.layers.length > 0;

  // The cross in the top bar means different things depending on what is on screen. In preview
  // mode it clears the shot, which is the same as Retake; with the live camera behind it, it is
  // the only way out of the screen, so it returns to the tab the user came from.
  const handleTopBarClose = useCallback(() => {
    if (capturedImage) {
      discardShot();
      return;
    }

    router.back();
  }, [capturedImage, discardShot]);

  // The whole flow in one step: the caption screen, where the title and the description are
  // written and the post is published. The image travels as a route param and the song as JSON,
  // because a route param can only be a string.
  const goNext = useCallback(() => {
    if (!capturedImage) {
      return;
    }

    router.push({
      pathname: '/post-details',
      params: {
        imageUri: capturedImage.uri,
        mediaType: capturedImage.mediaType,
        ...(sound ? { sound: JSON.stringify(sound) } : {}),
      },
    });
  }, [capturedImage, sound]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.container}
      >
        <View style={styles.topBar}>
        <Pressable
          accessibilityLabel={isPreviewing ? 'Retake' : 'Close'}
          accessibilityRole="button"
          hitSlop={10}
          onPress={handleTopBarClose}
          style={styles.circleButton}
        >
          <Ionicons color="#FFFFFF" name="close" size={26} />
        </Pressable>

        {/* Only the two camera controls sit over a live viewfinder. A song is attached to a post,
            not to a frame, so the pill waits until there is a shot to attach it to: with it hidden
            rather than disabled, nothing on screen is a control the user cannot use yet.
            space-between with two children still pins them to the two ends. */}
        {isPreviewing ? (
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
        ) : null}

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
          {/* The captured shot replaces the viewfinder outright rather than sitting on top of it:
              while it is set the CameraView below is not rendered at all, so the camera session
              is not left running behind a photo the user is looking at. */}
          {capturedImage ? (
            capturedImage.mediaType === 'image' ? (
              // A photo whose file already carries the matrix is drawn with React Native's Image
              // and nothing else: the filter is in the pixels, and running the matrix over it again
              // here would show a stronger look than the one that actually gets posted. The Skia
              // path is for the opposite case, a photo whose file does not have the filter in it
              // yet, where drawing the matrix is what makes the preview tell the truth.
              showsMatrixPreview ? (
                <FilteredImage matrix={selectedFilter.matrix} uri={capturedImage.uri} />
              ) : (
                <Image
                  resizeMode="cover"
                  source={{ uri: capturedImage.uri }}
                  style={StyleSheet.absoluteFill}
                />
              )
            ) : (
              <VideoView contentFit="cover" nativeControls={false} player={previewPlayer} style={StyleSheet.absoluteFill} />
            )
          ) : cameraPermission?.granted ? (
            <CameraView
              facing={facing}
              flash={flash}
              mode={selectedMode === 'PHOTO' ? 'picture' : 'video'}
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

          {/* The chosen look, where Skia cannot draw it: over the live viewfinder, which is a
              native surface Skia cannot wrap, and over a clip, which is never processed. A photo
              either carries the matrix in its file or has it drawn over it above, so it never gets
              a tint on top. pointerEvents none, so the tap on the media underneath (play and pause
              on a clip) still belongs to the media. */}
          {showsTintLayers ? selectedFilter.layers.map((layer) => (
            <View
              key={`${selectedFilter.id}-${layer.color}`}
              pointerEvents="none"
              style={[styles.filterOverlay, { backgroundColor: layer.color, opacity: layer.opacity }]}
            />
          )) : null}

          {/* The filter is being written to the file, so the stage is deliberately empty for a
              moment rather than showing the photo unfiltered and then swapping it. */}
          {isFiltering ? (
            <View pointerEvents="none" style={styles.filteringBadge}>
              <ActivityIndicator color="#FFFFFF" />
              <Text style={styles.filteringText}>{`Applying ${selectedFilter.label}`}</Text>
            </View>
          ) : null}

          {/* Every overlay below is a camera overlay: none of them means anything once the photo
              is on screen, so they are read off the same flag as the viewfinder. */}
          {!isPreviewing && showGrid ? (
            <View pointerEvents="none" style={styles.gridOverlay}>
              <View style={styles.gridLineVertical} />
              <View style={styles.gridColumnRight} />
              <View style={styles.gridLineHorizontal} />
              <View style={styles.gridRowBottom} />
            </View>
          ) : null}

          {!isPreviewing && isRecording ? (
            <View pointerEvents="none" style={styles.recordingBadge}>
              <View style={styles.recordingDot} />
              <Text style={styles.recordingText}>{`Recording, up to ${selectedDuration}`}</Text>
            </View>
          ) : null}

          {/* The self timer counting down. Tap the shutter again to call it off, so the number
              itself takes no touches. */}
          {!isPreviewing && countdown !== null ? (
            <View pointerEvents="none" style={styles.countdown}>
              <Text accessibilityLiveRegion="polite" style={styles.countdownText}>
                {countdown}
              </Text>
            </View>
          ) : null}

          {!isPreviewing && !isSupabaseConfigured() ? (
            <View pointerEvents="none" style={styles.supabaseNotice}>
              <Text style={styles.supabaseNoticeText}>
                Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to .env.local, then restart the dev
                server.
              </Text>
            </View>
          ) : null}
        </View>

        {/* The rail is drawn only over the live viewfinder. Unmounted rather than hidden, so a
            hidden control cannot be reached by a stray tap on a photo. */}
        {!isPreviewing ? (
        <ScrollView
          contentContainerStyle={styles.toolRailContent}
          // box-none: the rail's own box is wider than its six icons, and the gaps between them
          // are empty. Without this the rail would swallow every touch in that strip instead of
          // letting it reach the viewfinder behind, while the buttons still take their own.
          pointerEvents="box-none"
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
                  // Changing the delay while one is already running would do nothing, so the
                  // control is inert until the countdown ends or is called off.
                  disabled={countdown !== null}
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

            if (tool.label === 'Filter') {
              const isCustom = selectedFilter.id !== DEFAULT_FILTER_ID;

              return (
                <Pressable
                  key={tool.label}
                  accessibilityLabel={isCustom ? `Filter, currently ${selectedFilter.label}` : 'Filter'}
                  accessibilityRole="button"
                  onPress={() => setIsPickingFilter(true)}
                  style={styles.toolItem}
                >
                  <View style={styles.toolButton}>
                    <Ionicons color={isCustom ? '#FE2C55' : '#FFFFFF'} name={tool.icon} size={20} />
                  </View>
                  <Text numberOfLines={1} style={styles.toolLabel}>
                    {isCustom ? selectedFilter.label : tool.label}
                  </Text>
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
        ) : null}
      </View>

      {errorMessage ? (
        <Text numberOfLines={2} style={styles.errorText}>
          {errorMessage}
        </Text>
      ) : null}

      {/* Bottom cluster. Every row below is a normal flow child of this one and the gap on the
          cluster is the only spacing between them, so the effects carousel cannot land on top
          of the record button the way a hand tuned absolute offset did. The whole cluster is
          camera controls: zoom and the mode pills all act on the viewfinder, so none of it is
          drawn while the captured shot is on screen. */}
      {!isPreviewing ? (
      <View style={styles.bottomCluster}>
        {/* Zoom has nothing to act on in TEXT mode, so the row the slider would occupy becomes the
            background picker for the post. */}
        {selectedMode === 'TEXT' ? (
          <View style={styles.textPalette}>
            {TEXT_BACKGROUNDS.map((color) => {
              const isActive = color === selectedTextColor;

              return (
                <Pressable
                  key={color}
                  accessibilityLabel={`Text background ${color}`}
                  accessibilityRole="button"
                  onPress={() => setSelectedTextColor(color)}
                  style={[styles.textSwatch, isActive && styles.textSwatchActive]}
                >
                  <View style={[styles.textSwatchFill, { backgroundColor: color }]} />
                </Pressable>
              );
            })}
          </View>
        ) : (
          <View style={styles.zoomRow}>
          <Slider
            accessibilityLabel="Zoom"
            maximumTrackTintColor="rgba(255, 255, 255, 0.3)"
            maximumValue={1}
            minimumTrackTintColor="rgba(255, 255, 255, 0.9)"
            minimumValue={0}
            onValueChange={setZoom}
            step={0.01}
            style={styles.zoomSlider}
            thumbTintColor="#FFFFFF"
            value={zoom}
          />

          <View style={styles.zoomLabels}>
            {ZOOM_STOPS.map((stop) => {
              const isActive = Math.abs(zoom - stop.value) < 0.02;

              return (
                <Pressable
                  key={stop.label}
                  accessibilityLabel={`Zoom ${stop.label}`}
                  accessibilityRole="button"
                  hitSlop={10}
                  onPress={() => setZoom(stop.value)}
                  style={styles.zoomLabelHit}
                >
                  <Text style={[styles.zoomLabel, isActive && styles.zoomLabelActive]}>{stop.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        )}

        {/* One row, one selection. A duration is lit only while VIDEO is the mode and it is the
            chosen one; PHOTO and TEXT are lit only when they are the mode. That is what keeps
            exactly one pill lit, without a separate flag saying which one owns the highlight. */}
        <View style={styles.modeRow}>
          {CLIP_LENGTHS.map((length) => {
            const isActive = selectedMode === 'VIDEO' && selectedDuration === length;

            return (
              <Pressable
                key={length}
                accessibilityLabel={`${length} clip`}
                accessibilityRole="button"
                onPress={() => {
                  setSelectedMode('VIDEO');
                  setSelectedDuration(length);
                  discardShot();
                }}
                style={[styles.modePill, isActive && styles.modePillActive]}
              >
                <Text style={[styles.modePillText, isActive && styles.modePillTextActive]}>{length}</Text>
              </Pressable>
            );
          })}

          <Pressable
            accessibilityLabel="Photo mode"
            accessibilityRole="button"
            onPress={() => {
              setSelectedMode('PHOTO');
              discardShot();
            }}
            style={[styles.modePill, selectedMode === 'PHOTO' && styles.modePillActive]}
          >
            <Text style={[styles.modePillText, selectedMode === 'PHOTO' && styles.modePillTextActive]}>PHOTO</Text>
          </Pressable>

          <Pressable
            accessibilityLabel="Text mode"
            accessibilityRole="button"
            onPress={() => {
              setSelectedMode('TEXT');
              discardShot();
            }}
            style={[styles.modePill, selectedMode === 'TEXT' && styles.modePillActive]}
          >
            <Text style={[styles.modePillText, selectedMode === 'TEXT' && styles.modePillTextActive]}>TEXT</Text>
          </Pressable>
        </View>
      </View>
      ) : null}

{/* Bottom bar. With the live camera it is album left, shutter dead centre, and an empty twin on
          the right so the circle lands in the middle of the bar. In preview mode the shutter and
          the album have no meaning, so they are swapped for the two things that do: Next, red and
          centred, and Retake beside it, which does exactly what the top bar cross does. */}
        <View style={styles.bottomBar}>
          {isPreviewing ? (
            <>
              <View style={styles.bottomBarSide}>
                <Pressable
                  accessibilityLabel="Retake"
                  accessibilityRole="button"
                  onPress={discardShot}
                  style={({ pressed }) => [styles.retakeButton, pressed && styles.pressed]}
                >
                  <Text style={styles.retakeLabel}>Retake</Text>
                </Pressable>
              </View>

              <View style={styles.bottomBarSide}>
                <Pressable
                  accessibilityLabel="Next, to add a title and description"
                  accessibilityRole="button"
                  onPress={goNext}
                  style={({ pressed }) => [styles.nextButton, pressed && styles.pressed]}
                >
                  <Text style={styles.nextLabel}>Next</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <View style={styles.bottomBarSide}>
                <Pressable
                  accessibilityLabel="Open gallery"
                  accessibilityRole="button"
                  disabled={isBusy}
                  onPress={() => void pickMedia()}
                  style={({ pressed }) => [styles.albumButton, pressed && styles.pressed, isBusy && styles.disabled]}
                >
                  <Ionicons color="#FFFFFF" name="images-outline" size={20} />
                </Pressable>
              </View>

              <Pressable
                accessibilityLabel={
                  isRecording
                    ? 'Stop recording'
                    : selectedMode === 'PHOTO'
                      ? 'Take a photo'
                      : `Record a ${selectedDuration} clip`
                }
                accessibilityRole="button"
                disabled={!isCameraReady || !cameraPermission?.granted}
                onPress={onRecordPress}
                style={({ pressed }) => [styles.shutterOuter, pressed && styles.pressed]}
              >
                <View style={[styles.shutterInner, isRecording && styles.shutterInnerRecording]} />
              </Pressable>

              <View style={styles.bottomBarSide} />
            </>
          )}
        </View>
      </KeyboardAvoidingView>

      <FilterSheet
        onClose={() => setIsPickingFilter(false)}
        onSelect={(filter) => {
          setSelectedFilterId(filter.id);
          setIsPickingFilter(false);

          // A photo taken before the look was chosen does not have it in the file yet, so picking
          // a filter now writes it into the photo on screen. Without this the sheet would only
          // ever tint a photo that was never filtered, and the post would go out unfiltered.
          const shot = capturedImage;

          if (
            shot
            && shot.mediaType === 'image'
            && shot.filterId === DEFAULT_FILTER_ID
            && filter.id !== DEFAULT_FILTER_ID
          ) {
            void applyFilterToShot(shot, filter);
          }
        }}
        selectedId={selectedFilterId}
        visible={isPickingFilter}
      />

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
    // Full width. The rail is absolutely positioned and floats over the viewfinder, so it needs
    // no gutter of its own.
    right: 0,
    top: 0,
  },
  previewMedia: {
    height: '100%',
    width: '100%',
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
  filteringBadge: {
  alignItems: 'center',
  backgroundColor: 'rgba(0, 0, 0, 0.6)',
  borderRadius: 999,
  flexDirection: 'row',
  gap: 8,
  left: 12,
  paddingHorizontal: 12,
  paddingVertical: 8,
  position: 'absolute',
  top: 12,
},
filteringText: {
  color: '#FFFFFF',
  fontSize: 12,
  fontWeight: '700',
},
// A filter layer. Absolute over the whole frame, so several stack into the same look the sheet
// previews, and it takes no touches so the media underneath still does.
filterOverlay: {
  bottom: 0,
  left: 0,
  position: 'absolute',
  right: 0,
  top: 0,
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
  toolRail: {
    // Floats over the full width viewfinder rather than sitting beside it, so the camera is not
    // narrowed to make room. It is a later sibling than the preview and carries a zIndex on top
    // of that, so it draws over the viewfinder instead of under it.
    bottom: 12,
    position: 'absolute',
    right: 10,
    top: 0,
    zIndex: 10,
  },
  toolRailContent: {
    alignItems: 'center',
    // Centres the tools in the space available, and scrolls instead of overflowing when a
    // short screen cannot fit all six.
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
  // The five pills share one row, spread across the width rather than separated by a fixed gap
  // that clipped on a 360dp screen. The pills keep their own size, so the space goes between
  // them. Selected is the white background with black text; the rest are outlined only.
  modeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 15,
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
  // The whole bottom stack in one column. Every row is a flow child and the gap here is the
  // only thing separating them, which is what guarantees a clear band of space between the
  // rows instead of two independently positioned ones.
  bottomCluster: {
    alignItems: 'center',
    gap: 14,
    paddingBottom: 6,
    width: '100%',
  },
  // Takes the zoom row's place in TEXT mode, so the two controls occupy the same band and the
  // rows below do not move when the mode changes.
  textPalette: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    justifyContent: 'center',
    paddingVertical: 4,
    width: '100%',
  },
  // The ring is drawn by the parent so the selected colour stays true: a border over the swatch
  // would tint it.
  textSwatch: {
    alignItems: 'center',
    borderColor: 'rgba(255, 255, 255, 0.35)',
    borderRadius: 21,
    borderWidth: 2,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  textSwatchActive: {
    borderColor: '#FFFFFF',
    borderWidth: 3,
  },
  textSwatchFill: {
    borderRadius: 16,
    height: 32,
    width: 32,
  },
  // Thin bar with a white thumb, the way a Xiaomi camera draws it. The 20 matches the padding
  // on the label row below so the two line up on the same edges.
  zoomRow: {
    paddingHorizontal: 20,
    width: '100%',
  },
  zoomSlider: {
    height: 28,
    width: '100%',
  },
  zoomLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    // Pulls the outer labels in by the width of the thumb, so a label sits under the point its
    // stop actually puts the thumb rather than under the end of the track.
    paddingHorizontal: 6,
  },
  zoomLabelHit: {
    paddingVertical: 4,
  },
  zoomLabel: {
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 11,
    fontWeight: '700',
  },
  zoomLabelActive: {
    color: '#FFFFFF',
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
  // The self timer, dead centre over the viewfinder. No background of its own: a plate behind a
  // large number reads as a dialog, and this is not one.
  countdown: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  countdownText: {
    color: '#FFFFFF',
    fontSize: 96,
    fontWeight: '200',
    // A shadow rather than a box, so the number stays legible over a bright frame without
    // needing a second layer behind it.
    shadowColor: 'rgba(0, 0, 0, 0.45)',
    shadowOffset: { height: 2, width: 0 },
    shadowOpacity: 1,
    shadowRadius: 8,
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
  errorText: {
    color: '#FF6B6B',
    fontSize: 12,
    paddingHorizontal: 15,
    paddingVertical: 6,
  },
  bottomBar: {
    alignItems: 'center',
    // Solid black so the bar reads as one block with the viewfinder above it, whatever the
    // preview is showing. No blur: it costs a native view and reads no better on a dark UI.
    backgroundColor: '#000000',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 18,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  // The album slot and the Next slot are two equal flex rows. space-between alone would put the
  // record circle wherever the album happened to end, so it would drift off centre.
  bottomBarSide: {
    flex: 1,
    justifyContent: 'center',
  },
  // TikTok's record button: a white ring around a red disc. The ring is the outer view's
  // border, so it stays even while the inner disc shrinks to a square while recording.
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
  albumButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    borderColor: 'rgba(255, 255, 255, 0.5)',
    borderRadius: 8,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 40,
  },
  // The quiet half of the preview pair: an outlined pill, the same size as Next, so the two read
  // as a pair with the red one carrying the action.
  retakeButton: {
    alignItems: 'center',
    alignSelf: 'flex-end',
    borderColor: 'rgba(255, 255, 255, 0.6)',
    borderRadius: 999,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  retakeLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  // Takes the rest of its side of the bar, so Next lines up with the album slot it mirrors.
  nextButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#FE2C55',
    borderRadius: 999,
    height: 40,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  nextLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.72,
  },
});
