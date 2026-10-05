import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { useState } from 'react';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../../lib/constants';
import { getUserByPhone, sendFriendRequest } from '../../lib/friends';
import { User } from '../../types';
import { Avatar } from '../../components/common/Avatar';

export default function AddFriendByPhoneScreen() {
  const [phone, setPhone] = useState('');
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [requested, setRequested] = useState(false);

  const handleSearch = async () => {
    if (!phone.trim()) {
      Alert.alert('Error', 'Please enter a phone number');
      return;
    }

    setSearching(true);
    try {
      const found = await getUserByPhone(phone.trim());
      setUser(found);
      setRequested(false);
      if (!found) {
        Alert.alert('Not found', 'No user found with this phone number.');
      }
    } catch (error) {
      Alert.alert('Error', 'Search failed.');
    } finally {
      setSearching(false);
    }
  };

  const handleAdd = async () => {
    if (!user) return;

    setLoading(true);
    try {
      await sendFriendRequest(user.uid);
      setRequested(true);
      Alert.alert('Success', 'Friend request sent!');
    } catch (error) {
      Alert.alert('Error', 'Failed to send request.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={COLORS.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Add by Phone</Text>
        <View style={styles.rightSpace} />
      </View>

      <View style={styles.content}>
        <Text style={styles.label}>Phone Number</Text>
        <View style={styles.searchRow}>
          <TextInput
            style={styles.input}
            placeholder="Enter phone number with country code"
            placeholderTextColor={COLORS.placeholder}
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            onSubmitEditing={handleSearch}
          />
          <TouchableOpacity
            style={styles.searchButton}
            onPress={handleSearch}
            disabled={searching}
          >
            {searching ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <Ionicons name="search" size={20} color="white" />
            )}
          </TouchableOpacity>
        </View>

        {user && (
          <View style={styles.resultCard}>
            <Avatar name={user.name} photoUrl={user.avatarUrl} size={64} />
            <View style={styles.resultInfo}>
              <Text style={styles.resultName}>{user.name}</Text>
              <Text style={styles.resultPhone}>{user.phone}</Text>
            </View>
            <TouchableOpacity
              style={[styles.addButton, requested && styles.addButtonDisabled]}
              onPress={handleAdd}
              disabled={loading || requested}
            >
              {loading ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Text style={styles.addButtonText}>
                  {requested ? 'Sent' : 'Add'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        )}
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
  label: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginBottom: 6,
    fontWeight: '500',
  },
  searchRow: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  input: {
    flex: 1,
    height: 48,
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    color: COLORS.text,
    marginRight: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  searchButton: {
    backgroundColor: COLORS.primary,
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  resultCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  resultInfo: {
    flex: 1,
    marginLeft: 12,
  },
  resultName: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
  },
  resultPhone: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  addButton: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
  },
  addButtonDisabled: {
    backgroundColor: COLORS.success,
  },
  addButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
});