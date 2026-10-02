import { Ionicons } from '@expo/vector-icons';
import { Camera } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import AgoraRTC, {
  ChannelProfileType,
  ClientRoleType,
  RtcEngineContext,
  RtcSurfaceView,
  VideoSourceType,
  type IRtcEngine,
} from 'react-native-agora';

import {
  AGORA_APP_ID,
  callChannelName,
  isCallType,
  PLACEHOLDER_TOKEN,
  TEMP_AGORA_TOKEN,
  type CallSetupError,
} from '@/lib/agora-call';
import { findMockChat } from '@/lib/mock-chats';

/**
 * The engine is a native singleton, so it is created once at module scope and released on the way
 * out. Building one per mount would hand the SDK a second engine and make it throw.
 */
let engine: IRtcEngine | null = null;

function getEngine() {
  if (!engine) {
    engine = AgoraRTC();
  }

  return engine;
}

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');

  return `${minutes}:${seconds}`;
}

export default function CallScreen() {
  const { callType, id } = useLocalSearchParams<{ callType?: string; id?: string }>();
  const chatId = (Array.isArray(id) ? id[0] : id) ?? '';
  // A bad or missing param falls back to audio, which needs the least of the SDK.
  const resolvedType = isCallType(callType) ? callType : 'audio';
  const isVideoCall = resolvedType === 'video';

  const mockChat = findMockChat(chatId);
  const displayName = mockChat?.name ?? (chatId ? `Chat ${chatId}` : 'Unknown contact');

  // Missing App ID and an unset token are properties of the build, not things that change while the
  // screen is open, so they are derived during render instead of being pushed through state from
  // an effect. Only outcomes that genuinely arrive at runtime live in setupError.
  const configError: CallSetupError | null = !AGORA_APP_ID
    ? 'no-app-id'
    : !TEMP_AGORA_TOKEN || TEMP_AGORA_TOKEN === PLACEHOLDER_TOKEN
      ? 'placeholder-token'
      : null;

  const [setupError, setSetupError] = useState<CallSetupError | null>(null);
  const activeError = configError ?? setupError;
  const [status, setStatus] = useState<'joining' | 'connected'>('joining');
  const [remoteUid, setRemoteUid] = useState<number | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // Lets the unmount handler reach the handler object registered with the SDK, which has to be the
  // same reference passed to registerEventHandler.
  const handlersRef = useRef<Parameters<IRtcEngine['registerEventHandler']>[0] | null>(null);
  const isEndingRef = useRef(false);
  // Mirrors remoteUid for the SDK callbacks, which fire long after the effect that registered them
  // has finished and would otherwise close over a stale null.
  const remoteUidRef = useRef<number | null>(null);

  const leaveAndExit = useCallback(() => {
    if (isEndingRef.current) {
      return;
    }

    isEndingRef.current = true;

    try {
      if (handlersRef.current) {
        getEngine().unregisterEventHandler(handlersRef.current);
        handlersRef.current = null;
      }
      getEngine().leaveChannel();
      // release destroys the engine outright. Without it the next call on this device either
      // reuses a dead engine or fails to initialise a second one.
      getEngine().release();
    } catch (error) {
      // Leaving a channel we never joined throws. The screen is going away regardless, so this
      // must not keep it on screen.
      console.error('Agora teardown failed:', error);
    } finally {
      engine = null;
    }

    router.back();
  }, []);

  // Join once per mount. Everything below the guard runs once, so a re-render cannot join twice.
  useEffect(() => {
    // Already reported during render; nothing to join.
    if (configError) {
      return undefined;
    }

    let cancelled = false;

    async function start() {
      // Microphone first: without it the call cannot carry audio at all, so there is nothing worth
      // proceeding to. The camera is only required for a video call.
      const microphone = await Camera.requestMicrophonePermissionsAsync();

      if (cancelled) {
        return;
      }

      if (!microphone.granted) {
        setSetupError('permission-denied');

        return;
      }

      if (isVideoCall) {
        const camera = await Camera.requestCameraPermissionsAsync();

        if (cancelled) {
          return;
        }

        if (!camera.granted) {
          setSetupError('permission-denied');

          return;
        }
      }

      if (cancelled) {
        return;
      }

      try {
        const agoraEngine = getEngine();
        const context = new RtcEngineContext();
        context.appId = AGORA_APP_ID;
        context.channelProfile = ChannelProfileType.ChannelProfileCommunication;

        agoraEngine.initialize(context);

        const handlers: Parameters<IRtcEngine['registerEventHandler']>[0] = {
          onUserJoined: (_connection, uid) => {
            remoteUidRef.current = uid;
            setRemoteUid(uid);
          },
          onUserOffline: (_connection, uid) => {
            // The other side hung up. Staying on a connected-looking screen with nobody on it is
            // worse than leaving, so this ends the call the same way the button does.
            if (uid === remoteUidRef.current || remoteUidRef.current === null) {
              leaveAndExit();
            } else {
              remoteUidRef.current = null;
              setRemoteUid(null);
            }
          },
          // The SDK does not wrap these callbacks, so an exception inside one takes the app with it.
          onJoinChannelSuccess: () => setStatus('connected'),
          onLeaveChannel: () => setStatus('joining'),
        };

        handlersRef.current = handlers;
        agoraEngine.registerEventHandler(handlers);

        // Video has to be enabled before joining, otherwise the local camera never starts for this
        // call and the preview surface stays black.
        if (isVideoCall) {
          agoraEngine.enableVideo();
        }

        agoraEngine.enableAudio();
        agoraEngine.setEnableSpeakerphone(true);

        // uid 0 asks the SDK to assign one. Each side therefore gets a distinct id, which is what
        // the remote canvas below needs to find its stream.
        agoraEngine.joinChannel(TEMP_AGORA_TOKEN, callChannelName(chatId), 0, {
          autoSubscribeAudio: true,
          autoSubscribeVideo: isVideoCall,
          clientRoleType: ClientRoleType.ClientRoleBroadcaster,
        });
      } catch (error) {
        console.error('Agora join failed:', error);
        setSetupError('no-app-id');
      }
    }

    void start();

    return () => {
      cancelled = true;
    };
  }, [chatId, configError, isVideoCall, leaveAndExit]);

  // Tear the SDK down on unmount, which also covers navigating back with the system back gesture.
  useEffect(() => () => {
    if (isEndingRef.current) {
      return;
    }

    isEndingRef.current = true;

    try {
      if (handlersRef.current) {
        getEngine().unregisterEventHandler(handlersRef.current);
        handlersRef.current = null;
      }
      getEngine().leaveChannel();
      getEngine().release();
    } catch (error) {
      console.error('Agora teardown failed:', error);
    } finally {
      engine = null;
    }
  }, []);

  // The clock starts when the SDK reports the join, not when the screen mounts, so the timer is
  // not counting seconds spent on a permission prompt.
  useEffect(() => {
    if (status !== 'connected') {
      return undefined;
    }

    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);

    return () => clearInterval(timer);
  }, [status]);

  const toggleMute = () => {
    const next = !isMuted;

    try {
      getEngine().muteLocalAudioStream(next);
      setIsMuted(next);
    } catch (error) {
      console.error('Mute failed:', error);
    }
  };

  const toggleSpeaker = () => {
    const next = !isSpeakerOn;

    try {
      getEngine().setEnableSpeakerphone(next);
      setIsSpeakerOn(next);
    } catch (error) {
      console.error('Speaker toggle failed:', error);
    }
  };

  const toggleCamera = () => {
    const next = !isCameraOff;

    try {
      getEngine().muteLocalVideoStream(next);
      setIsCameraOff(next);
    } catch (error) {
      console.error('Camera toggle failed:', error);
    }
  };

  const switchCamera = () => {
    try {
      getEngine().switchCamera();
    } catch (error) {
      console.error('Switch camera failed:', error);
    }
  };

  if (activeError) {
    return (
      <View style={styles.errorScreen}>
        <Ionicons color="#B84141" name="warning-outline" size={34} />
        <Text style={styles.errorTitle}>{SETUP_ERROR_TITLE[activeError]}</Text>
        <Text style={styles.errorBody}>{SETUP_ERROR_BODY[activeError]}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        >
          <Text style={styles.backButtonText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {/* Remote video fills the screen behind everything. It is only mounted once the SDK has told
          us a peer joined, because a canvas bound to uid 0 is the local stream and would show this
          user to themselves at full size. */}
      {isVideoCall && remoteUid !== null ? (
        <RtcSurfaceView
          canvas={{ sourceType: VideoSourceType.VideoSourceRemote, uid: remoteUid }}
          style={styles.remoteVideo}
        />
      ) : null}

      {isVideoCall && isCameraOff ? (
        <View style={styles.cameraOffCover}>
          <Ionicons color="#FFFFFF" name="videocam-off-outline" size={30} />
        </View>
      ) : null}

      <View style={styles.topBar}>
        <Text style={styles.topName} numberOfLines={1}>{displayName}</Text>
        <Text style={styles.topMeta}>
          {resolvedType === 'video' ? 'Video call' : 'Voice call'}
          {status === 'connected' ? ` · ${formatDuration(elapsed)}` : ' · connecting'}
        </Text>
      </View>

      {/* Local self view, top right, small. */}
      {isVideoCall ? (
        <View style={styles.localPreview}>
          <RtcSurfaceView
            canvas={{ sourceType: VideoSourceType.VideoSourceCameraPrimary, uid: 0 }}
            style={styles.localVideo}
          />
        </View>
      ) : null}

      {/* Audio calls get an avatar and the clock, which is all there is to show. */}
      {!isVideoCall ? (
        <View style={styles.audioCentre}>
          {mockChat ? (
            <Image source={{ uri: mockChat.avatar }} style={styles.audioAvatar} />
          ) : (
            <View style={[styles.audioAvatar, styles.audioAvatarFallback]}>
              <Text style={styles.audioAvatarInitial}>{displayName.charAt(0).toUpperCase()}</Text>
            </View>
          )}
          <Text style={styles.audioName}>{displayName}</Text>
          {status === 'connected' ? (
            <Text style={styles.audioTimer}>{formatDuration(elapsed)}</Text>
          ) : (
            <ActivityIndicator color="#FFFFFF" style={styles.audioSpinner} />
          )}
        </View>
      ) : null}

      <View style={styles.controls}>
        <ControlButton
          active={isMuted}
          icon={isMuted ? 'mic-off' : 'mic'}
          label={isMuted ? 'Unmute' : 'Mute'}
          onPress={toggleMute}
        />

        <ControlButton
          active={isSpeakerOn}
          icon={isSpeakerOn ? 'volume-high' : 'volume-mute'}
          label="Speaker"
          onPress={toggleSpeaker}
        />

        {/* Camera controls are meaningless on an audio call, so they are not offered there. */}
        {isVideoCall ? (
          <>
            <ControlButton
              active={!isCameraOff}
              icon={isCameraOff ? 'videocam-off' : 'videocam'}
              label="Camera"
              onPress={toggleCamera}
            />
            <ControlButton
              icon="camera-reverse"
              label="Flip"
              onPress={switchCamera}
            />
          </>
        ) : null}

        <ControlButton danger icon="call" label="End" onPress={leaveAndExit} />
      </View>
    </View>
  );
}

const SETUP_ERROR_TITLE: Record<CallSetupError, string> = {
  'no-app-id': 'Calling is not configured',
  'permission-denied': 'Permission needed',
  'placeholder-token': 'Test token needed',
};

const SETUP_ERROR_BODY: Record<CallSetupError, string> = {
  'no-app-id': 'EXPO_PUBLIC_AGORA_APP_ID was not found. Add it to .env.local and restart the dev server.',
  'permission-denied':
    'Camera or microphone access was declined. Grant it in system settings and try the call again.',
  'placeholder-token':
    'The temporary Agora token is still the placeholder. Set TEMP_AGORA_TOKEN in src/lib/agora-call.ts to a short-lived token.',
};

type ControlButtonProps = {
  active?: boolean;
  danger?: boolean;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
};

function ControlButton({ active = true, danger = false, icon, label, onPress }: ControlButtonProps) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [styles.control, pressed && styles.pressed]}
    >
      {/* Inactive controls go dark and translucent rather than disappearing, so the row does not
          reflow as state changes. */}
      <View
        style={[
          styles.controlCircle,
          !active && styles.controlCircleOff,
          danger && styles.controlCircleDanger,
        ]}
      >
        <Ionicons color={danger ? '#FFFFFF' : active ? '#20232A' : '#FFFFFF'} name={icon} size={21} />
      </View>
      <Text style={styles.controlLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: '#111318',
    flex: 1,
  },
  remoteVideo: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  cameraOffCover: {
    alignItems: 'center',
    backgroundColor: '#111318',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  topBar: {
    left: 0,
    paddingHorizontal: 20,
    paddingTop: 54,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  topName: {
    color: '#FFFFFF',
    fontSize: 19,
    fontWeight: '800',
  },
  topMeta: {
    color: '#C6CAD2',
    fontSize: 13,
    marginTop: 3,
  },
  localPreview: {
    backgroundColor: '#20232A',
    borderColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 1.5,
    overflow: 'hidden',
    position: 'absolute',
    right: 18,
    top: 108,
    // Explicit numbers: an Agora canvas measures itself from its parent, and a flex or
    // percentage parent collapses it to nothing.
    width: 104,
    height: 148,
  },
  localVideo: {
    flex: 1,
  },
  audioCentre: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  audioAvatar: {
    backgroundColor: '#2A2E37',
    borderRadius: 66,
    height: 132,
    width: 132,
  },
  audioAvatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioAvatarInitial: {
    color: '#FFFFFF',
    fontSize: 52,
    fontWeight: '800',
  },
  audioName: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '800',
    marginTop: 20,
  },
  audioTimer: {
    color: '#C6CAD2',
    fontSize: 15,
    marginTop: 8,
  },
  audioSpinner: {
    marginTop: 14,
  },
  controls: {
    bottom: 0,
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    left: 0,
    paddingBottom: 42,
    paddingTop: 18,
    position: 'absolute',
    right: 0,
  },
  control: {
    alignItems: 'center',
    gap: 7,
  },
  controlCircle: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 30,
    height: 60,
    justifyContent: 'center',
    width: 60,
  },
  controlCircleOff: {
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  controlCircleDanger: {
    backgroundColor: '#D93B3B',
  },
  controlLabel: {
    color: '#E6E8EC',
    fontSize: 11,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.7,
  },
  errorScreen: {
    alignItems: 'center',
    backgroundColor: '#F7F4EF',
    flex: 1,
    justifyContent: 'center',
    padding: 30,
  },
  errorTitle: {
    color: '#20232A',
    fontSize: 22,
    fontWeight: '800',
    marginTop: 14,
    textAlign: 'center',
  },
  errorBody: {
    color: '#656A73',
    fontSize: 14,
    lineHeight: 21,
    marginTop: 10,
    textAlign: 'center',
  },
  backButton: {
    backgroundColor: '#E56B4C',
    borderRadius: 12,
    marginTop: 22,
    paddingHorizontal: 22,
    paddingVertical: 13,
  },
  backButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
});
