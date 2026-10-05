import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../../lib/constants';

export default function AddFriendByQrScreen() {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={COLORS.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Add by QR Code</Text>
        <View style={styles.rightSpace} />
      </View>

      <View style={styles.content}>
        <View style={styles.scannerPlaceholder}>
          <Ionicons name="qr-code-outline" size={80} color={COLORS.placeholder} />
          <Text style={styles.scannerText}>
            QR scanner will open here
          </Text>
          <Text style={styles.scannerSubtext}>
            Point your camera at a friend's QR code to add them
          </Text>
        </View>

        <TouchableOpacity
          style={styles.myQrButton}
          onPress={() => Alert.alert('My QR Code', 'Your QR code will be shown here.')}
        >
          <Ionicons name="person-circle-outline" size={24} color={COLORS.primary} />
          <Text style={styles.myQrText}>Show My QR Code</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.text,
    marginLeft: 12,
  },
  rightSpace: {
    width: 24,
  },
  content: {
    flex: 1,
    padding: 16,
  },
  scannerPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: COLORS.border,
    borderStyle: 'dashed',
    marginBottom: 16,
  },
  scannerText: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginTop: 16,
  },
  scannerSubtext: {
    fontSize: 14,
    color: COLORS.placeholder,
    marginTop: 8,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  myQrButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surface,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  myQrText: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.primary,
    marginLeft: 8,
  },
});