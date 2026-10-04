import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Linking from 'expo-linking';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { doc, getDoc } from 'firebase/firestore';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  isWellFormedInviteCode,
  normalizeInviteCode,
  readRoomInviteCode,
  readRoomName,
  setRoomInviteCode,
} from '@/lib/chat-rooms';
import { getFirebaseDb } from '@/lib/firebase';

/**
 * The room's link, its code, and the two ways of using it.
 *
 * A link rather than a code alone, because a code has to be copied somewhere to be useful and most of
 * the time the thing somebody has to hand over is a link they can tap. The code is on screen anyway, for
 * the case where it is being read down a phone line.
 *
 * Turning invites off clears the code, which makes every link already handed out stop working. That is
 * the point of the switch, and it is why the switch asks first.
 */
export default function RoomInviteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chatId = Array.isArray(id) ? id[0] : id || '';

  const [inviteCode, setInviteCode] = useState('');
  const [roomName, setRoomName] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState('');
  const [typedCode, setTypedCode] = useState('');
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [scanError, setScanError] = useState('');
  const [permission, requestPermission] = useCameraPermissions();

  const load = useCallback(async () => {
    if (!chatId) {
      setIsLoading(false);
      return;
    }

    try {
      const snapshot = await getDoc(doc(getFirebaseDb(), 'chats', chatId));
      const data = snapshot.exists() ? snapshot.data() : {};

      setInviteCode(readRoomInviteCode(data));
      setRoomName(readRoomName(data, ''));
    } catch (error) {
      console.error('Could not read the room invite:', error);
      setError('Could not read this room.');
    } finally {
      setIsLoading(false);
    }
  }, [chatId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const inviteLink = inviteCode === '' ? '' : Linking.createURL(`/join/${inviteCode}`);

  const toggleInvites = useCallback(async () => {
    if (isWorking) {
      return;
    }

    if (inviteCode !== '') {
      // Asked first, because this is the one switch here that cannot be undone: the code goes, and every
      // link already handed out stops working. That is what somebody turning it off is asking for, and it
      // is still worth a sentence before it happens rather than after.
      Alert.alert(
        'Turn invites off?',
        'Every invite link for this group stops working. You can turn them on again with a new link.',
        [
          { style: 'cancel', text: 'Cancel' },
          {
            style: 'destructive',
            text: 'Turn off',
            onPress: () => {
              setIsWorking(true);
              setError('');
              void setRoomInviteCode(chatId, false)
                .then(load)
                .catch((error) => {
                  console.error('Could not turn invites off:', error);
                  setError('Could not turn invites off. Please try again.');
                })
                .finally(() => setIsWorking(false));
            },
          },
        ],
      );
      return;
    }

    setIsWorking(true);
    setError('');
    try {
      await setRoomInviteCode(chatId, true);
      await load();
    } catch (error) {
      console.error('Could not turn invites on:', error);
      setError('Could not turn invites on. Please try again.');
    } finally {
      setIsWorking(false);
    }
  }, [chatId, inviteCode, isWorking, load]);

  const share = useCallback(async () => {
    if (inviteLink === '') {
      return;
    }

    await Share.share({
      message: `Join ${roomName || 'our group'} on chat-app-new: ${inviteLink}`,
      url: inviteLink,
    }).catch(() => {});
  }, [inviteLink, roomName]);

  const joinTypedCode = useCallback(() => {
    const code = normalizeInviteCode(typedCode);

    if (!isWellFormedInviteCode(code)) {
      setScanError('That code is not valid. Check it and try again.');
      return;
    }

    router.push({ params: { code }, pathname: '/join/[code]' } as never);
  }, [typedCode]);

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Pressable accessibilityLabel="Back" accessibilityRole="button" onPress={() => router.back()}>
            <Text style={styles.back}>←</Text>
          </Pressable>
          <Text style={styles.title}>Invite people</Text>
        </View>

        {isLoading ? (
          <ActivityIndicator color="#2FBF71" style={styles.loading} />
        ) : (
          <>
            {inviteCode === '' ? (
              <View style={styles.card}>
                <Ionicons color="#8D929C" name="lock-closed-outline" size={22} />
                <Text style={styles.cardTitle}>Invites are off</Text>
                <Text style={styles.cardBody}>
                  Nobody with a link can join this group. Turning them on creates a link you can share.
                </Text>
                <Pressable
                  accessibilityLabel="Turn invites on"
                  accessibilityRole="button"
                  disabled={isWorking}
                  onPress={() => void toggleInvites()}
                  style={({ pressed }) => [styles.button, pressed && styles.pressed]}
                >
                  <Text style={styles.buttonText}>Turn invites on</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <View style={styles.card}>
                  <Text style={styles.cardLabel}>Scan this at the door</Text>
                  <View style={styles.qrBox}>
                    <QRCode backgroundColor="#FFFFFF" size={196} value={inviteLink} />
                  </View>
                  <Text style={styles.code}>{inviteCode}</Text>
                  <Text numberOfLines={2} style={styles.link} selectable>{inviteLink}</Text>

                  <Pressable
                    accessibilityLabel="Share the invite link"
                    accessibilityRole="button"
                    onPress={() => void share()}
                    style={({ pressed }) => [styles.button, pressed && styles.pressed]}
                  >
                    <Ionicons color="#FFFFFF" name="share-outline" size={17} />
                    <Text style={styles.buttonText}>Share link</Text>
                  </Pressable>
                </View>

                <Pressable
                  accessibilityLabel="Turn invites off"
                  accessibilityRole="button"
                  disabled={isWorking}
                  onPress={() => void toggleInvites()}
                  style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                >
                  <Text style={styles.secondaryText}>Turn invites off</Text>
                </Pressable>
              </>
            )}

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Have a code?</Text>
              <TextInput
                autoCapitalize="characters"
                onChangeText={setTypedCode}
                onSubmitEditing={joinTypedCode}
                placeholder="Enter group code"
                placeholderTextColor="#8D929C"
                style={styles.input}
                value={typedCode}
              />
              {scanError ? <Text style={styles.error}>{scanError}</Text> : null}
              <Pressable
                accessibilityLabel="Join with this code"
                accessibilityRole="button"
                onPress={joinTypedCode}
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}
              >
                <Text style={styles.buttonText}>Join group</Text>
              </Pressable>
            </View>

            <Pressable
              accessibilityLabel="Scan a QR code"
              accessibilityRole="button"
              onPress={() => {
                setScanError('');
                setIsScannerOpen(true);
              }}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
            >
              <Ionicons color="#363A42" name="scan-outline" size={17} />
              <Text style={styles.secondaryText}>Scan a QR code</Text>
            </Pressable>

            {error ? <Text style={styles.error}>{error}</Text> : null}
          </>
        )}
      </ScrollView>

      <Modal animationType="slide" onRequestClose={() => setIsScannerOpen(false)} visible={isScannerOpen}>
        <View style={styles.scanner}>
          {permission?.granted ? (
            <CameraView
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => {
                // A code can arrive as a bare code or as the whole link this screen hands out, so both
                // are accepted: the last path segment is the code in either case.
                const fromLink = data.split('/').pop() ?? '';
                const code = normalizeInviteCode(fromLink);

                setIsScannerOpen(false);

                if (!isWellFormedInviteCode(code)) {
                  setScanError('That is not a group code.');
                  return;
                }

                router.push({ params: { code }, pathname: '/join/[code]' } as never);
              }}
              style={styles.camera}
            />
          ) : (
            <View style={styles.cameraFallback}>
              <Text style={styles.cardBody}>Allow the camera to scan a group code.</Text>
              <Pressable
                accessibilityLabel="Allow camera"
                accessibilityRole="button"
                onPress={() => void requestPermission()}
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}
              >
                <Text style={styles.buttonText}>Allow camera</Text>
              </Pressable>
            </View>
          )}

          <Pressable
            accessibilityLabel="Close the scanner"
            accessibilityRole="button"
            onPress={() => setIsScannerOpen(false)}
            style={styles.scannerClose}
          >
            <Ionicons color="#FFFFFF" name="close" size={24} />
          </Pressable>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  content: {
    paddingBottom: 30,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  back: {
    color: '#363A42',
    fontSize: 22,
  },
  title: {
    color: '#20232A',
    fontSize: 19,
    fontWeight: '800',
  },
  loading: {
    marginTop: 40,
  },
  card: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    marginBottom: 12,
    marginHorizontal: 16,
    padding: 16,
  },
  cardLabel: {
    color: '#8D929C',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  cardTitle: {
    color: '#20232A',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 6,
    marginTop: 6,
    textAlign: 'center',
  },
  cardBody: {
    color: '#6C7079',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
    textAlign: 'center',
  },
  qrBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    marginVertical: 12,
    padding: 12,
  },
  code: {
    color: '#20232A',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 2,
    marginBottom: 6,
  },
  link: {
    color: '#8D929C',
    fontSize: 11,
    marginBottom: 14,
    textAlign: 'center',
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#2FBF71',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 12,
    width: '100%',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginBottom: 12,
    marginHorizontal: 16,
    paddingVertical: 12,
  },
  secondaryText: {
    color: '#363A42',
    fontSize: 14,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.7,
  },
  input: {
    backgroundColor: '#F7F4EF',
    borderRadius: 12,
    color: '#20232A',
    fontSize: 16,
    letterSpacing: 2,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    width: '100%',
  },
  error: {
    color: '#C0392B',
    fontSize: 13,
    marginBottom: 10,
    textAlign: 'center',
  },
  scanner: {
    backgroundColor: '#000000',
    flex: 1,
  },
  camera: {
    flex: 1,
  },
  cameraFallback: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  scannerClose: {
    position: 'absolute',
    right: 16,
    top: 50,
  },
});