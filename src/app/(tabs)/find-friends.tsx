import { View, Text, TextInput, StyleSheet, FlatList, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { useState, useEffect } from 'react';
import { useCurrentUser } from '../../hooks/useCurrentUser';
import { Avatar } from '../../components/common/Avatar';
import { Loading } from '../../components/common/Loading';
import { EmptyState } from '../../components/common/EmptyState';
import { COLORS } from '../../lib/constants';
import { router } from 'expo-router';
import {
  sendFriendRequest,
  getFriendRequests,
  acceptFriendRequest,
  rejectFriendRequest,
  searchUsersByName,
  getUserByPhone,
} from '../../lib/friends';
import { User, FriendRequest } from '../../types';

export default function FriendsScreen() {
  const { user: currentUser } = useCurrentUser();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [friendRequests, setFriendRequests] = useState<FriendRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [searchMode, setSearchMode] = useState<'name' | 'phone'>('name');

  useEffect(() => {
    loadFriendRequests();
  }, []);

  const loadFriendRequests = async () => {
    try {
      const requests = await getFriendRequests();
      setFriendRequests(requests);
    } catch (error) {
      console.error('Failed to load friend requests:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    setSearching(true);
    try {
      if (searchMode === 'phone') {
        const user = await getUserByPhone(searchQuery.trim());
        setSearchResults(user ? [user] : []);
      } else {
        const results = await searchUsersByName(searchQuery.trim());
        setSearchResults(results.filter((u) => u.uid !== currentUser?.uid));
      }
    } catch (error) {
      console.error('Search failed:', error);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const handleSendRequest = async (toUid: string) => {
    try {
      await sendFriendRequest(toUid);
      Alert.alert('Success', 'Friend request sent!');
    } catch (error) {
      Alert.alert('Error', 'Failed to send friend request.');
    }
  };

  const handleAccept = async (requestId: string) => {
    try {
      await acceptFriendRequest(requestId);
      setFriendRequests((prev) =>
        prev.map((r) => (r.id === requestId ? { ...r, status: 'accepted' } : r)),
      );
    } catch (error) {
      Alert.alert('Error', 'Failed to accept request.');
    }
  };

  const handleReject = async (requestId: string) => {
    try {
      await rejectFriendRequest(requestId);
      setFriendRequests((prev) =>
        prev.map((r) => (r.id === requestId ? { ...r, status: 'rejected' } : r)),
      );
    } catch (error) {
      Alert.alert('Error', 'Failed to reject request.');
    }
  };

  const pendingRequests = friendRequests.filter((r) => r.status === 'pending');

  if (loading) {
    return <Loading />;
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Add Friends</Text>
      </View>

      {/* Search mode toggle */}
      <View style={styles.searchModeRow}>
        <TouchableOpacity
          style={[styles.searchModeButton, searchMode === 'name' && styles.searchModeActive]}
          onPress={() => setSearchMode('name')}
        >
          <Text style={[styles.searchModeText, searchMode === 'name' && styles.searchModeTextActive]}>
            By Name
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.searchModeButton, searchMode === 'phone' && styles.searchModeActive]}
          onPress={() => setSearchMode('phone')}
        >
          <Text style={[styles.searchModeText, searchMode === 'phone' && styles.searchModeTextActive]}>
            By Phone
          </Text>
        </TouchableOpacity>
      </View>

      {/* Search bar */}
      <View style={styles.searchBar}>
        <TextInput
          style={styles.searchInput}
          placeholder={searchMode === 'phone' ? 'Enter phone number' : 'Search by name'}
          placeholderTextColor={COLORS.placeholder}
          value={searchQuery}
          onChangeText={setSearchQuery}
          onSubmitEditing={handleSearch}
          returnKeyType="search"
          keyboardType={searchMode === 'phone' ? 'phone-pad' : 'default'}
        />
        <TouchableOpacity style={styles.searchButton} onPress={handleSearch}>
          <Text style={styles.searchButtonText}>Search</Text>
        </TouchableOpacity>
      </View>

      {/* Friend requests */}
      {pendingRequests.length > 0 && (
        <View style={styles.requestsSection}>
          <Text style={styles.sectionTitle}>Friend Requests ({pendingRequests.length})</Text>
          {pendingRequests.map((request) => (
            <View key={request.id} style={styles.requestRow}>
              <View style={styles.requestInfo}>
                <Text style={styles.requestText}>
                  Request from {request.fromUid}
                </Text>
              </View>
              <View style={styles.requestActions}>
                <TouchableOpacity
                  style={styles.acceptButton}
                  onPress={() => handleAccept(request.id)}
                >
                  <Text style={styles.acceptText}>Accept</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.rejectButton}
                  onPress={() => handleReject(request.id)}
                >
                  <Text style={styles.rejectText}>Reject</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Search results */}
      {searching ? (
        <ActivityIndicator style={styles.searching} size="large" color={COLORS.primary} />
      ) : searchResults.length > 0 ? (
        <FlatList
          data={searchResults}
          keyExtractor={(item) => item.uid}
          renderItem={({ item }) => (
            <View style={styles.resultRow}>
              <Avatar name={item.name} photoUrl={item.avatarUrl} size={48} />
              <View style={styles.resultInfo}>
                <Text style={styles.resultName}>{item.name}</Text>
                {item.phone ? (
                  <Text style={styles.resultPhone}>{item.phone}</Text>
                ) : null}
              </View>
              <TouchableOpacity
                style={styles.addButton}
                onPress={() => handleSendRequest(item.uid)}
              >
                <Text style={styles.addButtonText}>Add</Text>
              </TouchableOpacity>
            </View>
          )}
        />
      ) : searchQuery ? (
        <EmptyState title="No users found" subtitle="Try a different search" />
      ) : (
        <EmptyState
          title="Find friends"
          subtitle="Search by name or phone number to add friends"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.text,
  },
  searchModeRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.surface,
  },
  searchModeButton: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    backgroundColor: COLORS.background,
    marginHorizontal: 4,
    borderRadius: 8,
  },
  searchModeActive: {
    backgroundColor: COLORS.primary,
  },
  searchModeText: {
    color: COLORS.textSecondary,
    fontSize: 14,
    fontWeight: '500',
  },
  searchModeTextActive: {
    color: 'white',
  },
  searchBar: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  searchInput: {
    flex: 1,
    height: 40,
    backgroundColor: COLORS.background,
    borderRadius: 20,
    paddingHorizontal: 16,
    fontSize: 15,
    color: COLORS.text,
    marginRight: 8,
  },
  searchButton: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 16,
    justifyContent: 'center',
    borderRadius: 20,
  },
  searchButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  requestsSection: {
    backgroundColor: COLORS.surface,
    marginTop: 8,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
    marginBottom: 12,
  },
  requestRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  requestInfo: {
    flex: 1,
  },
  requestText: {
    fontSize: 14,
    color: COLORS.text,
  },
  requestActions: {
    flexDirection: 'row',
  },
  acceptButton: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    marginLeft: 8,
  },
  acceptText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '600',
  },
  rejectButton: {
    backgroundColor: COLORS.background,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    marginLeft: 8,
  },
  rejectText: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
  searching: {
    marginTop: 40,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.divider,
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
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
  },
  addButtonText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '600',
  },
});
