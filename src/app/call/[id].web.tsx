import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function CallScreen() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.centerState}>
        <Text style={styles.title}>Video calls are unavailable on web</Text>
        <Text style={styles.text}>
          This feature requires an iOS or Android development build because it uses native Agora video support.
        </Text>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.backButtonText}>Go back</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  centerState: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    padding: 28,
  },
  title: {
    color: '#20232A',
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 12,
    textAlign: 'center',
  },
  text: {
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
});
