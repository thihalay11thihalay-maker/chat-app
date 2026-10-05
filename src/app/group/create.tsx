import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, FlatList, ActivityIndicator } from 'react-native';
import { useState, useEffect } from 'react';
import { router } from 'expo-router';
import { useCurrentUser } from '../../hooks/useCurrentUser';
import { Avatar } from '../../components/common/Avatar';
import { Loading } from '../../components/common/Loading';
import { COLORS } from '../../lib/constants';
import { createGroupRoom } from '../../lib/rooms';
import { searchUsersByName } from '../../lib/friends';
import { User } from '../../types';

export default function GroupCreateScreen() {
  const { user: currentUser } = useCurrentUser();
  const [name, setName] = useState('');
  const [selectedUsers, setSelectedUsers] = useState<User[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    setSearching(true);
    try {
      const results = await searchUsersByName(searchQuery.trim());
      setSearchResults(results.filter((u) => u.uid !== currentUser?.uid));
    } catch (error) {
      console.error('Search failed:', error);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const toggleUser = (user: User) => {
    setSelectedUsers((prev) => {
      const isSelected = prev.some((u) => u.uid === user.uid);
      if (isSelected) {
        return prev.filter((u) => u.uid !== user.uid);
      }
      return [...prev, user];
    });
  };

  const isSelected = (uid: string) => selectedUsers.some((u) => u.uid === uid);

  const handleCreate = async () => {
    if (!name.trim()) {
      Alert.alert('Error', 'Please enter a group name');
      return;
    }

    if (selectedUsers.length < 1) {
      Alert.alert('Error', 'Please add at least 1 member');
      return;
    }

    setCreating(true);
    try {
      const participantIds = selectedUsers.map((u) => u.uid);
      const room = await createGroupRoom(currentUser!.uid, name.trim(), participantIds);
      router.replace(`/group/${room.id}`);
    } catch (error) {
      Alert.alert('Error', 'Failed to create group.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>New Group</Text>
        <TouchableOpacity
          onPress={handleCreate}
          disabled={creating || !name.trim() || selectedUsers.length === 0}
        >
          <Text
            style={[
              styles.createText,
              (creating || !name.trim() || selectedUsers.length === 0) && styles.createTextDisabled,
            ]}
          >
            {creating ? 'Creating...' : 'Create'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.content}>
        {/* Group name */}
        <View style={styles.field}>
          <Text style={styles.label}>Group Name</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter group name"
            placeholderTextColor={COLORS.placeholder}
            value={name}
            onChangeText={setName}
          />
        </View>

        {/* Selected members */}
        {selectedUsers.length > 0 && (
          <View style={styles.selectedSection}>
            <Text style={styles.sectionTitle}>
              Members ({selectedUsers.length})
            </Text>
            <View style={styles.selectedList}>
              {selectedUsers.map((user) => (
                <View key={user.uid} style={styles.selectedChip}>
                  <Avatar name={user.name} photoUrl={user.avatarUrl} size={24} />
                  <Text style={styles.selectedName}>{user.name}</Text>
                  <TouchableOpacity onPress={() => toggleUser(user)}>
                    <Text style={styles.removeText}>×</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Search */}
        <View style={styles.searchBar}>
          <TextInput
            style={styles.searchInput}
            placeholder="Search users to add"
            placeholderTextColor={COLORS.placeholder}
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={handleSearch}
            returnKeyType="search"
          />
          <TouchableOpacity style={styles.searchButton} onPress={handleSearch}>
            <Text style={styles.searchButtonText}>Search</Text>
          </TouchableOpacity>
        </View>

        {/* Search results */}
        {searching ? (
          <ActivityIndicator style={styles.searching} size="large" color={COLORS.primary} />
        ) : searchResults.length > 0 ? (
          <FlatList
            data={searchResults}
            keyExtractor={(item) => item.uid}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.resultRow}
                onPress={() => toggleUser(item)}
              >
                <Avatar name={item.name} photoUrl={item.avatarUrl} size={44} />
                <View style={styles.resultInfo}>
                  <Text style={styles.resultName}>{item.name}</Text>
                  {item.phone ? (
                    <Text style={styles.resultPhone}>{item.phone}</Text>
                  ) : null}
                </View>
                <View style={[styles.checkbox, isSelected(item.uid) && styles.checkboxSelected]}>
                  {isSelected(item.uid) && <Text style={styles.checkmark}>✓</Text>}
                </View>
              </TouchableOpacity>
            )}
          />
        ) : searchQuery ? (
          <Text style={styles.noResults}>No users found</Text>
        ) : null}
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
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  cancelText: {
    fontSize: 16,
    color: COLORS.textSecondary,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.text,
  },
  createText: {
    fontSize: 16,
    color: COLORS.primary,
    fontWeight: '600',
  },
  createTextDisabled: {
    color: COLORS.placeholder,
  },
  content: {
    flex: 1,
    padding: 16,
  },
  field: {
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginBottom: 6,
    fontWeight: '500',
  },
  input: {
    height: 48,
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  selectedSection: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginBottom: 8,
    fontWeight: '500',
  },
  selectedList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  selectedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderRadius: 20,
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginRight: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  selectedName: {
    fontSize: 14,
    color: COLORS.text,
    marginHorizontal: 6,
  },
  removeText: {
    fontSize: 18,
    color: COLORS.textSecondary,
    paddingHorizontal: 4,
  },
  searchBar: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  searchInput: {
    flex: 1,
    height: 44,
    backgroundColor: COLORS.surface,
    borderRadius: 22,
    paddingHorizontal: 16,
    fontSize: 15,
    color: COLORS.text,
    marginRight: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  searchButton: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 16,
    justifyContent: 'center',
    borderRadius: 22,
  },
  searchButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  searching: {
    marginTop: 20,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    marginBottom: 8,
  },
  resultInfo: {
    flex: 1,
    marginLeft: 12,
  },
  resultName: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.text,
  },
  resultPhone: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: COLORS.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxSelected: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  checkmark: {
    color: 'white',
    fontSize: 14,
    fontWeight: '700',
  },
  noResults: {
    textAlign: 'center',
    color: COLORS.textSecondary,
    marginTop: 20,
    fontSize: 15,
  },
});