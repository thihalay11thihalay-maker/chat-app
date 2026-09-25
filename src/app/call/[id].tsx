import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    PermissionsAndroid,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import {
    ChannelMediaOptions,
    ChannelProfileType,
    ClientRoleType,
    createAgoraRtcEngine,
    IRtcEngine,
    IRtcEngineEventHandler,
    RtcSurfaceView,
} from 'react-native-agora';
import { SafeAreaView } from 'react-native-safe-area-context';

const agoraAppId = process.env.EXPO_PUBLIC_AGORA_APP_ID?.trim();

async function requestMediaPermissions() {
  if (Platform.OS !== 'android') {
    return true;
  }

  const permissions = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.CAMERA,
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
  ]);

  return permissions[PermissionsAndroid.PERMISSIONS.CAMERA] === PermissionsAndroid.RESULTS.GRANTED
    && permissions[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === PermissionsAndroid.RESULTS.GRANTED;
}

export default function CallScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const channelName = Array.isArray(id) ? id[0] : id || 'demo-channel';
  const engineRef = useRef<IRtcEngine | null>(null);
  const [remoteUid, setRemoteUid] = useState<number | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [callStatus, setCallStatus] = useState('Connecting...');

  useEffect(() => {
    let isMounted = true;
    let eventHandler: IRtcEngineEventHandler | null = null;

    const startCall = async () => {
      if (Platform.OS === 'web') {
        if (isMounted) {
          setErrorMessage('Video calls require an iOS or Android development build.');
          setIsInitializing(false);
        }
        return;
      }

      if (!agoraAppId) {
        if (isMounted) {
          setErrorMessage('Agora App ID is missing from EXPO_PUBLIC_AGORA_APP_ID.');
          setIsInitializing(false);
        }
        return;
      }

      try {
        const permissionsGranted = await requestMediaPermissions();
        if (!permissionsGranted) {
          throw new Error('Camera and microphone permissions are required for a call.');
        }

        const engine = createAgoraRtcEngine();
        engineRef.current = engine;
        eventHandler = {
          onJoinChannelSuccess: () => {
            if (isMounted) {
              setIsInitializing(false);
              setCallStatus('You are connected');
            }
          },
          onUserJoined: (_connection, userId) => {
            if (isMounted) {
              setRemoteUid(userId);
              setCallStatus('Friend connected');
            }
          },
          onUserOffline: (_connection, userId) => {
            if (isMounted) {
              setRemoteUid(null);
              setCallStatus('Waiting for your friend');
            }
          },
        };

        engine.initialize({ appId: agoraAppId });
        engine.registerEventHandler(eventHandler);
        engine.enableVideo();
        engine.startPreview();

        const options = new ChannelMediaOptions();
        options.channelProfile = ChannelProfileType.ChannelProfileCommunication;
        options.clientRoleType = ClientRoleType.ClientRoleBroadcaster;
        options.publishCameraTrack = true;
        options.publishMicrophoneTrack = true;
        engine.joinChannel('', channelName, 0, options);

        if (isMounted) {
          setCallStatus('Joining call...');
        }
      } catch (error) {
        console.error('Failed to start Agora call:', error);
        if (isMounted) {
          setErrorMessage(error instanceof Error ? error.message : 'Could not start the call.');
          setIsInitializing(false);
        }
      }
    };

    const initialStart = setTimeout(() => void startCall(), 0);

    return () => {
      isMounted = false;
      clearTimeout(initialStart);
      if (engineRef.current) {
        if (eventHandler) {
          engineRef.current.unregisterEventHandler(eventHandler);
        }
        engineRef.current.stopPreview();
        engineRef.current.leaveChannel();
        engineRef.current.release();
        engineRef.current = null;
      }
    };
  }, [channelName]);

  const toggleMute = () => {
    const nextMuted = !isMuted;
    engineRef.current?.muteLocalAudioStream(nextMuted);
    setIsMuted(nextMuted);
  };

  const toggleCamera = () => {
    const nextCameraOff = !isCameraOff;
    engineRef.current?.enableLocalVideo(!nextCameraOff);
    setIsCameraOff(nextCameraOff);
  };

  const endCall = () => {
    engineRef.current?.stopPreview();
    engineRef.current?.leaveChannel();
    engineRef.current?.release();
    engineRef.current = null;
    router.back();
  };

  if (errorMessage) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centerState}>
          <Text style={styles.errorTitle}>Call unavailable</Text>
          <Text style={styles.errorText}>{errorMessage}</Text>
          <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.backButton}>
            <Text style={styles.backButtonText}>Go back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.callScreen}>
      <View style={styles.remoteVideo}>
        {remoteUid ? (
          <RtcSurfaceView canvas={{ uid: remoteUid }} style={StyleSheet.absoluteFill} />
        ) : (
          <View style={styles.waitingState}>
            <Text style={styles.waitingTitle}>Waiting for your friend</Text>
            <Text style={styles.waitingText}>{channelName}</Text>
          </View>
        )}
      </View>

      <SafeAreaView style={styles.overlay}>
        <View style={styles.topBar}>
          <View>
            <Text style={styles.callLabel}>VIDEO CALL</Text>
            <Text style={styles.statusText}>{callStatus}</Text>
          </View>
          {isInitializing ? <ActivityIndicator color="#FFFFFF" /> : null}
        </View>

        <View style={styles.localVideoFrame}>
          {isCameraOff ? (
            <View style={styles.cameraOffState}>
              <Text style={styles.cameraOffText}>Camera off</Text>
            </View>
          ) : (
            <RtcSurfaceView canvas={{ uid: 0 }} style={StyleSheet.absoluteFill} />
          )}
        </View>

        <View style={styles.controls}>
          <Pressable
            accessibilityLabel={isMuted ? 'Unmute microphone' : 'Mute microphone'}
            accessibilityRole="button"
            onPress={toggleMute}
            style={({ pressed }) => [styles.controlButton, isMuted && styles.controlButtonActive, pressed && styles.pressed]}
          >
            <Text style={styles.controlIcon}>{isMuted ? 'ON' : 'MUTE'}</Text>
            <Text style={styles.controlLabel}>{isMuted ? 'Unmute' : 'Mute'}</Text>
          </Pressable>
          <Pressable
            accessibilityLabel={isCameraOff ? 'Turn camera on' : 'Turn camera off'}
            accessibilityRole="button"
            onPress={toggleCamera}
            style={({ pressed }) => [styles.controlButton, isCameraOff && styles.controlButtonActive, pressed && styles.pressed]}
          >
            <Text style={styles.controlIcon}>{isCameraOff ? 'ON' : 'CAM'}</Text>
            <Text style={styles.controlLabel}>{isCameraOff ? 'Camera on' : 'Camera off'}</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="End call"
            accessibilityRole="button"
            onPress={() => {
              Alert.alert('End call?', 'Leave this video call?', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'End call', onPress: endCall, style: 'destructive' },
              ]);
            }}
            style={({ pressed }) => [styles.endButton, pressed && styles.pressed]}
          >
            <Text style={styles.endButtonText}>End Call</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  callScreen: {
    backgroundColor: '#20232A',
    flex: 1,
  },
  remoteVideo: {
    backgroundColor: '#20232A',
    flex: 1,
    overflow: 'hidden',
  },
  waitingState: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    padding: 28,
  },
  waitingTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
  },
  waitingText: {
    color: '#B9BBC0',
    fontSize: 14,
    marginTop: 8,
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'space-between',
    padding: 20,
  },
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  callLabel: {
    color: '#F5B09D',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.6,
  },
  statusText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 5,
  },
  localVideoFrame: {
    backgroundColor: '#363A42',
    borderColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 2,
    height: 180,
    overflow: 'hidden',
    position: 'absolute',
    right: 20,
    top: 100,
    width: 120,
  },
  cameraOffState: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    padding: 10,
  },
  cameraOffText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
  controls: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
  },
  controlButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(32, 35, 42, 0.86)',
    borderColor: 'rgba(255, 255, 255, 0.24)',
    borderRadius: 14,
    borderWidth: 1,
    minWidth: 76,
    paddingHorizontal: 10,
    paddingVertical: 11,
  },
  controlButtonActive: {
    backgroundColor: '#E56B4C',
    borderColor: '#E56B4C',
  },
  controlIcon: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
    marginBottom: 5,
  },
  controlLabel: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  endButton: {
    alignItems: 'center',
    backgroundColor: '#B84141',
    borderRadius: 14,
    minWidth: 84,
    paddingHorizontal: 12,
    paddingVertical: 18,
  },
  endButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
  },
  centerState: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    padding: 28,
  },
  errorTitle: {
    color: '#20232A',
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 10,
  },
  errorText: {
    color: '#656A73',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  backButton: {
    backgroundColor: '#E56B4C',
    borderRadius: 12,
    marginTop: 22,
    paddingHorizontal: 20,
    paddingVertical: 13,
  },
  backButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  pressed: {
    opacity: 0.78,
  },
});
