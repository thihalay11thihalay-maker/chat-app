import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ChatScreen() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Text style={styles.eyebrow}>CONVO</Text>
        <Text style={styles.title}>Your chats are ready.</Text>
        <Text style={styles.subtitle}>Your profile has been saved successfully.</Text>
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
    justifyContent: 'center',
    padding: 28,
  },
  eyebrow: {
    color: '#E56B4C',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.8,
    marginBottom: 12,
  },
  title: {
    color: '#20232A',
    fontSize: 32,
    fontWeight: '800',
    marginBottom: 10,
  },
  subtitle: {
    color: '#656A73',
    fontSize: 16,
    lineHeight: 24,
  },
});