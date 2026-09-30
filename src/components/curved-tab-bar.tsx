import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Translucent black instead of the solid navy it used to be, so the post behind the bar
// shows through the way it does in TikTok and Instagram. The bar draws no shadow and no
// border: an edge against the content behind it is what makes a translucent bar look solid.
const BAR_BACKGROUND = 'rgba(0, 0, 0, 0.4)';
// White reads clearly on the darkened video; the inactive entries drop to 60% so the active
// one still stands out without leaving the bar.
const ACTIVE_COLOR = '#FFFFFF';
const INACTIVE_COLOR = '#FFFFFF';
const UPLOAD_COLOR = '#EF4444';
const UPLOAD_TAB_KEY = 'upload';

const BAR_HEIGHT = 70;
// The bar runs to both edges of the screen, so there is no side gap and no rounding.
const BAR_SIDE_GAP = 0;
const NOTCH_SIZE = 50;

/**
 * Space the bar occupies in the layout, ignoring the device inset. Screens that size
 * themselves from the window height subtract this plus `insets.bottom` so their content
 * ends above the bar instead of running underneath it.
 */
export const TAB_BAR_HEIGHT = BAR_HEIGHT;

type IconName = ComponentProps<typeof Ionicons>['name'];

export type TabItem = {
  key: string;
  label: string;
  href: string;
  icon: IconName;
  activeIcon: IconName;
};

export const TAB_ITEMS: TabItem[] = [
  { key: 'home', label: 'Home', href: '/home', icon: 'home-outline', activeIcon: 'home' },
  { key: 'friends', label: 'Friends', href: '/friends', icon: 'people-outline', activeIcon: 'people' },
  { key: 'upload', label: 'Upload', href: '/upload', icon: 'add', activeIcon: 'add' },
  { key: 'inbox', label: 'Inbox', href: '/chat', icon: 'chatbubble-ellipses-outline', activeIcon: 'chatbubble-ellipses' },
  { key: 'profile', label: 'Profile', href: '/profile', icon: 'person-outline', activeIcon: 'person' },
];

export type CurvedTabBarProps = {
  /** Overrides the active tab, for when the bar is driven by another navigator. */
  activeHref?: string;
  /**
   * Lays the bar over the screen instead of shortening it. Only safe where the screen draws
   * its own bottom padding, and the only place that wants it is a full-bleed video feed.
   */
  isOverlay?: boolean;
  items?: TabItem[];
  /** Called instead of navigating, for custom handling. */
  onSelect?: (item: TabItem) => void;
};

function isTabActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function CurvedTabBar({ activeHref, isOverlay = false, items = TAB_ITEMS, onSelect }: CurvedTabBarProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const routePathname = usePathname() ?? '';
  const pathname = activeHref ?? routePathname;

  const selectTab = (item: TabItem) => {
    if (onSelect) {
      onSelect(item);
      return;
    }

    router.push(item.href as never);
  };

  return (
    // Kept in the normal layout flow on purpose: an absolutely positioned bar overlays the
    // screen instead of shortening it, which is what pushed videos under the bar. The feed
    // opts out with isOverlay, because there a full-bleed post is meant to run under it.
    <View
      style={[
        styles.wrapper,
        // Only the device inset below, so the bar itself sits flush against the bottom
        // edge and clears the phone navigation bar instead of being cut off by it.
        { paddingBottom: insets.bottom },
        isOverlay ? styles.overlay : null,
      ]}
    >
      <View style={styles.bar}>
        {items.map((item) => {
          const isActive = isTabActive(pathname, item.href);

          if (item.key === UPLOAD_TAB_KEY) {
            return (
              <View key={item.key} style={styles.uploadSlot}>
                <Pressable
                  accessibilityLabel={item.label}
                  accessibilityRole="button"
                  onPress={() => selectTab(item)}
                  style={styles.uploadButton}
                >
                  <Ionicons color={INACTIVE_COLOR} name="add" size={28} />
                </Pressable>
              </View>
            );
          }

          return (
            <Pressable
              accessibilityLabel={item.label}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
              key={item.key}
              onPress={() => selectTab(item)}
              style={styles.tab}
            >
              <Ionicons
                color={isActive ? ACTIVE_COLOR : INACTIVE_COLOR}
                name={isActive ? item.activeIcon : item.icon}
                size={22}
                style={isActive ? styles.iconActive : styles.icon}
              />
              <Text style={[styles.label, isActive && styles.labelActive]}>{item.label}</Text>
              <View style={isActive ? styles.activeDot : styles.hiddenDot} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default CurvedTabBar;

const styles = StyleSheet.create({
  wrapper: {
    // The same translucent fill as the bar, so the device inset below it is one continuous
    // block and the content behind shows through both parts evenly.
    backgroundColor: BAR_BACKGROUND,
    paddingHorizontal: BAR_SIDE_GAP,
    width: '100%',
  },
  bar: {
    alignItems: 'center',
    backgroundColor: BAR_BACKGROUND,
    flexDirection: 'row',
    height: BAR_HEIGHT,
    paddingHorizontal: 6,
    width: '100%',
    // No shadow and no border: either one draws a hard edge that a translucent bar cannot
    // hide, and the edge reads as a solid block.
    elevation: 0,
    shadowOpacity: 0,
  },
  overlay: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    // Above the feed it covers, which is the post video and its social bar.
    zIndex: 20,
  },
  tab: {
    alignItems: 'center',
    flex: 1,
    gap: 3,
    justifyContent: 'center',
    paddingVertical: 6,
  },
  icon: {
    opacity: 0.6,
  },
  iconActive: {
    opacity: 1,
  },
  label: {
    color: INACTIVE_COLOR,
    fontSize: 10,
    fontWeight: '700',
    opacity: 0.6,
  },
  labelActive: {
    color: ACTIVE_COLOR,
    opacity: 1,
  },
  activeDot: {
    backgroundColor: ACTIVE_COLOR,
    borderRadius: 3,
    elevation: 5,
    height: 5,
    shadowColor: ACTIVE_COLOR,
    shadowOffset: { height: 0, width: 0 },
    shadowOpacity: 1,
    shadowRadius: 6,
    width: 5,
  },
  hiddenDot: {
    height: 5,
    width: 5,
  },
  uploadSlot: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  uploadButton: {
    alignItems: 'center',
    backgroundColor: UPLOAD_COLOR,
    borderRadius: NOTCH_SIZE / 2,
    elevation: 16,
    height: NOTCH_SIZE,
    justifyContent: 'center',
    // The bar is now flush to both edges, so the button is centred by the equal flex slots
    // on either side rather than being offset to line up with anything.
    marginTop: 0,
    width: NOTCH_SIZE,
    zIndex: 10,
  },
});
