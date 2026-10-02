import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { isCallType } from '@/lib/agora-call';

/**
 * Web fallback. The Agora SDK behind [id].native.tsx is native only, so this route exists purely to
 * explain that rather than to blank the screen on a browser.
 */
export default function CallScreen() {
  const { callType } = useLocalSearchParams<{ callType?: string }>();
  const resolvedType = isCallType(callType) ? callType : 'audio';
  const label = resolvedType === 'video' ? 'video' : 'voice';

  return (
    <View style={styles.centerState}>
      <Ionicons color="#B0B4BD" name="call-outline" size={34} />
      <Text style={styles.title}>{label[0].toUpperCase() + label.slice(1)} calls need a mobile build</Text>
      <Text style={styles.text}>
        {`${label[0].toUpperCase() + label.slice(1)} calls use the native Agora SDK, which is only available on iOS and Android. Run a development build to try it.`}
      </Text>
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

const styles = StyleSheet.create({
  centerState: {
    alignItems: 'center',
    backgroundColor: '#F7F4EF',
    flex: 1,
    justifyContent: 'center',
    padding: 28,
  },
  title: {
    color: '#20232A',
    fontSize: 22,
    fontWeight: '800',
    marginTop: 14,
    textAlign: 'center',
  },
  text: {
    color: '#656A73',
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
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
  pressed: {
    opacity: 0.7,
  },
});
