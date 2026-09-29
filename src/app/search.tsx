import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type Result = {
  id: string;
  subtitle: string;
  title: string;
  type: 'user' | 'post';
};

const SAMPLE_USERS: Result[] = [
  { id: 'u1', type: 'user', title: 'Aye Nyein', subtitle: '18 · Yangon' },
  { id: 'u2', type: 'user', title: 'Min Thandar', subtitle: '22 · Mandalay' },
  { id: 'u3', type: 'user', title: 'Zaw Lin', subtitle: '25 · Bago' },
  { id: 'u4', type: 'user', title: 'Su Hlaing', subtitle: '27 · Naypyidaw' },
];

const SAMPLE_POSTS: Result[] = [
  { id: 'p1', type: 'post', title: 'Sunset at Inle Lake', subtitle: 'Aye Nyein · 1.2k likes' },
  { id: 'p2', type: 'post', title: 'Morning coffee', subtitle: 'Min Thandar · 340 likes' },
  { id: 'p3', type: 'post', title: 'Street food night', subtitle: 'Zaw Lin · 890 likes' },
];

const ALL_RESULTS = [...SAMPLE_USERS, ...SAMPLE_POSTS];

export default function SearchScreen() {
  const [query, setQuery] = useState('');
  const trimmedQuery = query.trim().toLowerCase();

  // Placeholder filtering so the screen has a shape before the Firestore queries land.
  const results = useMemo(() => {
    if (!trimmedQuery) {
      return ALL_RESULTS;
    }

    return ALL_RESULTS.filter((result) => (
      result.title.toLowerCase().includes(trimmedQuery)
      || result.subtitle.toLowerCase().includes(trimmedQuery)
    ));
  }, [trimmedQuery]);

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <View style={styles.header}>
        <View style={styles.searchField}>
          <Ionicons color="#9CA3AF" name="search" size={18} />
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setQuery}
            placeholder="Search people and posts"
            placeholderTextColor="#6B7280"
            style={styles.input}
            value={query}
          />
          {query ? (
            <Pressable accessibilityLabel="Clear search" onPress={() => setQuery('')}>
              <Ionicons color="#9CA3AF" name="close-circle" size={18} />
            </Pressable>
          ) : null}
        </View>

        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.cancelButton}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{trimmedQuery ? 'Results' : 'Recent'}</Text>
        <Text style={styles.sectionCount}>{results.length}</Text>
      </View>

      {results.length === 0 ? (
        <View style={styles.stateContainer}>
          <Ionicons color="#6B7280" name="search-outline" size={34} />
          <Text style={styles.stateTitle}>No matches</Text>
          <Text style={styles.stateText}>Try a different name or keyword.</Text>
        </View>
      ) : (
        <FlatList
          contentContainerStyle={styles.list}
          data={results}
          keyboardShouldPersistTaps="handled"
          keyExtractor={(item) => `${item.type}-${item.id}`}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.rowAvatar}>
                {item.type === 'user' ? (
                  <Text style={styles.rowAvatarLetter}>{item.title.charAt(0).toUpperCase()}</Text>
                ) : (
                  <Image
                    source={{ uri: 'https://picsum.photos/seed/' + item.id + '/80/80' }}
                    style={styles.rowAvatarImage}
                  />
                )}
              </View>

              <View style={styles.rowCopy}>
                <Text numberOfLines={1} style={styles.rowTitle}>{item.title}</Text>
                <Text numberOfLines={1} style={styles.rowSubtitle}>{item.subtitle}</Text>
              </View>

              <Ionicons color="#6B7280" name="chevron-forward" size={16} />
            </Pressable>
          )}
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#0A0A0A',
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  searchField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#1A1A1A',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  input: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 15,
    padding: 0,
  },
  cancelButton: {
    paddingVertical: 8,
  },
  cancelText: {
    color: '#3B82F6',
    fontSize: 15,
    fontWeight: 'bold',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 6,
  },
  sectionTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: 'bold',
  },
  sectionCount: {
    color: '#6B7280',
    fontSize: 12,
    fontWeight: '700',
  },
  list: {
    paddingHorizontal: 22,
    paddingBottom: 40,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 13,
    borderBottomColor: '#1F1F1F',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 12,
  },
  rowPressed: {
    opacity: 0.72,
  },
  rowAvatar: {
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    borderRadius: 23,
    height: 46,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 46,
  },
  rowAvatarImage: {
    height: '100%',
    width: '100%',
  },
  rowAvatarLetter: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: 'bold',
  },
  rowCopy: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: 'bold',
  },
  rowSubtitle: {
    color: '#6B7280',
    fontSize: 12,
    marginTop: 3,
  },
  stateContainer: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  stateTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: 'bold',
    marginTop: 12,
  },
  stateText: {
    color: '#6B7280',
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
});
