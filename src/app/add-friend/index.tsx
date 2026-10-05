import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../../lib/constants';

export default function AddFriendScreen() {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={COLORS.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Add Friend</Text>
        <View style={styles.rightSpace} />
      </View>

      <View style={styles.content}>
        <TouchableOpacity
          style={styles.option}
          onPress={() => router.push('/add-friend/by-phone')}
        >
          <View style={styles.optionIcon}>
            <Ionicons name="call-outline" size={24} color={COLORS.primary} />
          </View>
          <View style={styles.optionInfo}>
            <Text style={styles.optionTitle}>Add by Phone</Text>
            <Text style={styles.optionSubtitle}>Find friends with their phone number</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={COLORS.placeholder} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.option}
          onPress={() => router.push('/add-friend/by-qr')}
        >
          <View style={styles.optionIcon}>
            <Ionicons name="qr-code-outline" size={24} color={COLORS.primary} />
          </View>
          <View style={styles.optionInfo}>
            <Text style={styles.optionTitle}>Add by QR Code</Text>
            <Text style={styles.optionSubtitle}>Scan a friend's QR code</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={COLORS.placeholder} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.option}
          onPress={() => router.push('/(tabs)/find-friends')}
        >
          <View style={styles.optionIcon}>
            <Ionicons name="search-outline" size={24} color={COLORS.primary} />
          </View>
          <View style={styles.optionInfo}>
            <Text style={styles.optionTitle}>Search by Name</Text>
            <Text style={styles.optionSubtitle}>Find friends by their name</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={COLORS.placeholder} />
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
    padding: 16,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  optionIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.primaryLight,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  optionInfo: {
    flex: 1,
  },
  optionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
  },
  optionSubtitle: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
});