import { Image } from 'expo-image';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { TAB_BAR_HEIGHT } from '@/components/curved-tab-bar';

type LiveStream = {
  id: string;
  host: string;
  hostAvatar: string;
  title: string;
  viewers: string;
  cover: string;
};

// Placeholder rooms. Nothing here is a real stream; the shapes are what the list will look
// like once there is a live endpoint behind it.
const LIVE_STREAMS: LiveStream[] = [
  {
    cover: 'https://picsum.photos/seed/liveroom1/300/400',
    host: 'Nwe Lay',
    hostAvatar: 'https://i.pravatar.cc/150?img=32',
    id: 'live-1',
    title: 'Late night music requests',
    viewers: '2.4k',
  },
  {
    cover: 'https://picsum.photos/seed/liveroom2/300/400',
    host: 'Mon',
    hostAvatar: 'https://i.pravatar.cc/150?img=5',
    id: 'live-2',
    title: 'Cooking and talking',
    viewers: '840',
  },
  {
    cover: 'https://picsum.photos/seed/liveroom3/300/400',
    host: 'HninKyaing',
    hostAvatar: 'https://i.pravatar.cc/150?img=12',
    id: 'live-3',
    title: 'Study with me',
    viewers: '156',
  },
];

export default function LiveScreen() {
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Live</Text>

      <FlatList
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.list}
        data={LIVE_STREAMS}
        keyExtractor={(item) => item.id}
        numColumns={3}
        renderItem={({ item }) => (
          <Pressable
            accessibilityLabel={`${item.host}, ${item.title}`}
            accessibilityRole="button"
            style={styles.card}
          >
            <Image contentFit="cover" source={{ uri: item.cover }} style={styles.cover} transition={120} />

            <View style={styles.viewerBadge}>
              <View style={styles.liveDot} />
              <Text style={styles.viewers}>{item.viewers}</Text>
            </View>

            <View style={styles.meta}>
              <Image contentFit="cover" source={{ uri: item.hostAvatar }} style={styles.hostAvatar} />
              <Text numberOfLines={1} style={styles.host}>{item.host}</Text>
            </View>

            <Text numberOfLines={2} style={styles.streamTitle}>{item.title}</Text>
          </Pressable>
        )}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  title: {
    color: '#20232A',
    fontSize: 28,
    fontWeight: '800',
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  list: {
    // Clears the floating tab bar.
    paddingBottom: TAB_BAR_HEIGHT + 24,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  row: {
    gap: 10,
  },
  card: {
    flex: 1,
    marginBottom: 16,
  },
  cover: {
    backgroundColor: '#E7E2DA',
    borderRadius: 10,
    height: 190,
    width: '100%',
  },
  viewerBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 4,
    left: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    position: 'absolute',
    top: 6,
  },
  liveDot: {
    backgroundColor: '#FE2C55',
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  viewers: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  meta: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    marginTop: 7,
  },
  hostAvatar: {
    backgroundColor: '#E7E2DA',
    borderRadius: 10,
    height: 20,
    width: 20,
  },
  host: {
    color: '#20232A',
    flexShrink: 1,
    fontSize: 13,
    fontWeight: '800',
  },
  streamTitle: {
    color: '#656A73',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
});