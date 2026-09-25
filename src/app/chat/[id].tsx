import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ChatDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chatId = id || 'chat';

  const openCall = () => {
    router.push(`/call/${encodeURIComponent(chatId)}` as never);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.backButton}>
            <Text style={styles.backText}>{'<-'}</Text>
          </Pressable>
          <View>
            <Text style={styles.eyebrow}>CONVERSATION</Text>
            <Text style={styles.title}>Chat {chatId}</Text>
          </View>
        </View>

        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>Start a conversation</Text>
          <Text style={styles.emptySubtitle}>Connect with this friend through a call.</Text>
        </View>

        <View style={styles.callActions}>
          <Pressable
            accessibilityLabel="Start phone call"
            accessibilityRole="button"
            onPress={openCall}
            style={({ pressed }) => [styles.callButton, pressed && styles.pressed]}
          >
            <Text style={styles.callIcon}>+</Text>
            <Text style={styles.callButtonText}>Phone Call</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Start video call"
            accessibilityRole="button"
            onPress={openCall}
            style={({ pressed }) => [styles.callButton, styles.videoButton, pressed && styles.pressed]}
          >
            <Text style={styles.callIcon}>[]</Text>
            <Text style={styles.callButtonText}>Video Call</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  container: {
    flex: 1,
    padding: 28,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
  },
  backButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 22,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  backText: {
    color: '#20232A',
    fontSize: 18,
    fontWeight: '800',
  },
  eyebrow: {
    color: '#E56B4C',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.6,
    marginBottom: 4,
  },
  title: {
    color: '#20232A',
    fontSize: 24,
    fontWeight: '800',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
  },
  emptyTitle: {
    color: '#20232A',
    fontSize: 30,
    fontWeight: '800',
    marginBottom: 10,
  },
  emptySubtitle: {
    color: '#656A73',
    fontSize: 16,
    lineHeight: 24,
  },
  callActions: {
    gap: 12,
  },
  callButton: {
    alignItems: 'center',
    backgroundColor: '#20232A',
    borderRadius: 14,
    flexDirection: 'row',
    height: 58,
    justifyContent: 'center',
  },
  videoButton: {
    backgroundColor: '#E56B4C',
  },
  callIcon: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
    marginRight: 10,
  },
  callButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.78,
  },
});
