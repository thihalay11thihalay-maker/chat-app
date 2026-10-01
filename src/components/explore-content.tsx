import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useState } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

type ExploreTab = 'Popular' | 'Featured' | 'Explore' | 'Nearby';

type Region = {
  id: string;
  name: string;
  flag: string;
};

type TrendCard = {
  id: string;
  country: string;
  flag: string;
  image: string;
};

const EXPLORE_TABS: ExploreTab[] = ['Popular', 'Featured', 'Explore', 'Nearby'];

// Flag emoji rather than image assets: they are one code point each, so there is nothing to
// bundle and nothing to load before the row draws.
const REGIONS: Region[] = [
  { flag: '🇲🇲', id: 'mm', name: 'Myanmar' },
  { flag: '🇹🇭', id: 'th', name: 'Thailand' },
  { flag: '🇱🇦', id: 'la', name: 'Laos' },
  { flag: '🇻🇳', id: 'vn', name: 'Vietnam' },
  { flag: '🇵🇭', id: 'ph', name: 'Philippines' },
  { flag: '🇺🇸', id: 'us', name: 'USA' },
  { flag: '🇰🇷', id: 'kr', name: 'Korea' },
  { flag: '🇯🇵', id: 'jp', name: 'Japan' },
];

// picsum seeds are stable per id, so a card keeps the same picture across re-renders instead
// of changing every time the list recycles it.
const TRENDING: TrendCard[] = REGIONS.flatMap((region, index) =>
  [0, 1].map((offset) => {
    const id = `${region.id}-${offset}`;

    return {
      country: region.name,
      flag: region.flag,
      id,
      image: `https://picsum.photos/seed/live${id}/300/400`,
    };
  })
);

function ExploreListHeader({
  activeTab,
  onSelectTab,
}: {
  activeTab: ExploreTab;
  onSelectTab: (tab: ExploreTab) => void;
}) {
  return (
    <View>
      <View style={styles.header}>
        <Text style={styles.brand}>BIGO LIVE</Text>

        <View style={styles.headerIcons}>
          <Pressable
            accessibilityLabel="Search"
            accessibilityRole="button"
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          >
            <Ionicons color="#20232A" name="search-outline" size={22} />
          </Pressable>

          <Pressable
            accessibilityLabel="Notifications"
            accessibilityRole="button"
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          >
            <Ionicons color="#20232A" name="notifications-outline" size={22} />
          </Pressable>
        </View>
      </View>

      <View style={styles.tabBar}>
        {EXPLORE_TABS.map((tab) => {
          const isActive = tab === activeTab;

          return (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
              key={tab}
              onPress={() => onSelectTab(tab)}
              style={styles.tab}
            >
              <Text style={[styles.tabText, isActive && styles.tabTextActive]}>{tab}</Text>
              {/* A child rather than a border, so the underline appears without changing the
                  height of the row and nudging everything under it. */}
              <View style={[styles.tabUnderline, isActive && styles.tabUnderlineActive]} />
            </Pressable>
          );
        })}
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Countries &amp; regions</Text>
        <Pressable
          accessibilityLabel="More countries and regions"
          accessibilityRole="button"
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Text style={styles.sectionMore}>MORE &gt;</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.regionRow}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        {REGIONS.map((region) => (
          <Pressable
            accessibilityLabel={`${region.name} live rooms`}
            accessibilityRole="button"
            key={region.id}
            style={styles.regionItem}
          >
            <View style={styles.regionFlag}>
              <Text style={styles.regionFlagText}>{region.flag}</Text>
            </View>
            <Text numberOfLines={1} style={styles.regionName}>{region.name}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <View style={styles.trendHeader}>
        <Text style={styles.sectionTitle}>Trending</Text>
        <Pressable
          accessibilityLabel="Filter trending"
          accessibilityRole="button"
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        >
          <Ionicons color="#20232A" name="filter-outline" size={20} />
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The BIGO Live explore view. It is a component rather than a screen on purpose: it is a tab
 * inside the Home feed, so it renders under that screen's own tab pill and search button and
 * shares its bottom tab bar. Anything under src/app would become its own route and show this
 * UI outside Home, which is exactly what it should not do.
 *
 * `topInset` is the height of the Home bar above it, measured by Home and passed in, so the
 * header starts below the pill and the search button instead of at a guessed offset.
 */
export function ExploreContent({ topInset }: { topInset: number }) {
  const [activeTab, setActiveTab] = useState<ExploreTab>('Explore');

  return (
    <View style={styles.screen}>
      <FlatList
        // The sections sit in the list header so the trending grid scrolls under them, and
        // keying on the tab stops a trending card being recycled into a region circle.
        ListHeaderComponent={
          <View style={{ paddingTop: topInset }}>
            <ExploreListHeader activeTab={activeTab} onSelectTab={setActiveTab} />
          </View>
        }
        ListHeaderComponentStyle={styles.listHeader}
        columnWrapperStyle={styles.trendRow}
        contentContainerStyle={styles.list}
        data={TRENDING}
        keyExtractor={(item) => item.id}
        numColumns={3}
        renderItem={({ item }) => (
          <View style={styles.trendCard}>
            <Image contentFit="cover" source={{ uri: item.image }} style={styles.trendImage} transition={120} />
            <View style={styles.trendLabel}>
              <Text style={styles.trendFlag}>{item.flag}</Text>
              <Text numberOfLines={1} style={styles.trendCountry}>{item.country}</Text>
            </View>
          </View>
        )}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: '#FFFFFF',
    flex: 1,
  },
  list: {
    // Clears the Home tab bar, which floats over the bottom of the screen.
    paddingBottom: 96,
  },
  listHeader: {
    // Nothing fixed here: the top space comes from the inset Home measures and passes in.
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  brand: {
    color: '#20232A',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  headerIcons: {
    flexDirection: 'row',
    gap: 4,
  },
  iconButton: {
    padding: 6,
  },
  tabBar: {
    borderBottomColor: '#EEEAE3',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    marginTop: 10,
    paddingHorizontal: 10,
  },
  tab: {
    alignItems: 'center',
    flex: 1,
    paddingVertical: 10,
  },
  tabText: {
    color: '#8D929C',
    fontSize: 14,
    fontWeight: '600',
  },
  tabTextActive: {
    color: '#20232A',
    fontWeight: '800',
  },
  tabUnderline: {
    backgroundColor: 'transparent',
    borderRadius: 2,
    height: 3,
    marginTop: 6,
    width: 22,
  },
  tabUnderlineActive: {
    backgroundColor: '#E56B4C',
  },
  sectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  sectionTitle: {
    color: '#20232A',
    fontSize: 16,
    fontWeight: '800',
  },
  sectionMore: {
    color: '#8D929C',
    fontSize: 12,
    fontWeight: '700',
  },
  regionRow: {
    gap: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  regionItem: {
    alignItems: 'center',
    width: 62,
  },
  regionFlag: {
    alignItems: 'center',
    backgroundColor: '#F5F2ED',
    borderRadius: 31,
    height: 62,
    justifyContent: 'center',
    width: 62,
  },
  regionFlagText: {
    fontSize: 30,
  },
  regionName: {
    color: '#656A73',
    fontSize: 11,
    marginTop: 6,
    textAlign: 'center',
  },
  trendHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 10,
    paddingHorizontal: 16,
  },
  trendRow: {
    gap: 8,
    paddingHorizontal: 16,
  },
  trendCard: {
    borderRadius: 8,
    flex: 1,
    marginBottom: 8,
    overflow: 'hidden',
  },
  trendImage: {
    backgroundColor: '#F5F2ED',
    height: 150,
    width: '100%',
  },
  trendLabel: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    bottom: 0,
    flexDirection: 'row',
    gap: 4,
    left: 0,
    paddingHorizontal: 6,
    paddingVertical: 4,
    position: 'absolute',
    right: 0,
  },
  trendFlag: {
    fontSize: 11,
  },
  trendCountry: {
    color: '#FFFFFF',
    flexShrink: 1,
    fontSize: 11,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.6,
  },
});