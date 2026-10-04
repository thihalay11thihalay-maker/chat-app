import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { joinRoomByInviteCode } from '@/lib/chat-rooms';

/**
 * What somebody sees after tapping an invite link.
 *
 * Joining happens here rather than on the conversation screen, because the person tapping the link is
 * not in the room yet and has no screen for it. Everything the join can refuse is refused here with the
 * reason, so the failure is a sentence on a page rather than a permission error in a room that never
 * opens.
 */
export default function JoinRoomScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const inviteCode = Array.isArray(code) ? code[0] : code || '';

  const [isJoining, setIsJoining] = useState(true);
  const [error, setError] = useState('');

  const join = useCallback(async () => {
    setIsJoining(true);
    setError('');

    try {
      const chatId = await joinRoomByInviteCode(inviteCode);

      // Replaced rather than pushed, so the back gesture from the room leaves the app rather than
      // returning to a join page that has already been used.
      router.replace({ params: { id: chatId }, pathname: '/chat/[id]' } as never);
    } catch (joinError) {
      console.error('Could not join the group:', joinError);
      setError(joinError instanceof Error ? joinError.message : 'Could not join that group.');
      setIsJoining(false);
    }
  }, [inviteCode]);

  // On arriving, and again on coming back to this page, rather than once on mount: somebody who has
  // signed in on this screen and gone back to the link should find it works now.
  useFocusEffect(
    useCallback(() => {
      void join();
    }, [join]),
  );

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <View style={styles.body}>
        {isJoining ? (
          <>
            <ActivityIndicator color="#2FBF71" size="large" />
            <Text style={styles.title}>Joining the group</Text>
            <Text style={styles.body}>One moment.</Text>
          </>
        ) : (
          <>
            <Ionicons color="#C0392B" name="alert-circle" size={34} />
            <Text style={styles.title}>Could not join</Text>
            <Text style={styles.message}>{error}</Text>
            <View style={styles.actions}>
              <Pressable
                accessibilityLabel="Try again"
                accessibilityRole="button"
                onPress={() => void join()}
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}
              >
                <Text style={styles.buttonText}>Try again</Text>
              </Pressable>
              <Pressable
                accessibilityLabel="Go back"
                accessibilityRole="button"
                onPress={() => router.back()}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryText}>Go back</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  body: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    color: '#20232A',
    fontSize: 19,
    fontWeight: '800',
    marginBottom: 6,
    marginTop: 14,
    textAlign: 'center',
  },
  message: {
    color: '#6C7079',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  actions: {
    marginTop: 20,
    width: '100%',
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#2FBF71',
    borderRadius: 12,
    paddingVertical: 13,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  secondaryButton: {
    alignItems: 'center',
    borderRadius: 12,
    marginTop: 8,
    paddingVertical: 13,
  },
  secondaryText: {
    color: '#6C7079',
    fontSize: 14,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.7,
  },
});