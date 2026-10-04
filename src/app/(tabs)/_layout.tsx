import { Href, Tabs } from 'expo-router';

import { CurvedTabBar, type TabItem } from '@/components/curved-tab-bar';
import { useFeatureFlag } from '@/lib/feature-flags';

// The curved bar draws itself, so the screen order and this list have to stay the same:
// the middle entry is the raised upload button.
//
// `flag` is the switch that decides whether an entry is on the bar. A screen whose flag is off is still
// registered below, with href null, so it stays reachable from anywhere that links to it -- turning a
// flag back on has nothing left to do.
const TABS: (TabItem & { flag?: 'findFriendsTab' | 'liveTab'; name: string })[] = [
  {
    activeIcon: 'home',
    href: '/home',
    icon: 'home-outline',
    key: 'home',
    label: 'Home',
    name: 'home',
  },
  {
    activeIcon: 'radio',
    flag: 'liveTab',
    href: '/live',
    icon: 'radio-outline',
    key: 'live',
    label: 'Live',
    name: 'live',
  },
  {
    // In the slot Live used to have. Live's screen is untouched and still registered, so this is a swap
    // of the bar rather than a deletion.
    activeIcon: 'people',
    flag: 'findFriendsTab',
    href: '/find-friends',
    icon: 'people-outline',
    key: 'find-friends',
    label: 'Find',
    name: 'find-friends',
  },
  {
    activeIcon: 'add',
    href: '/upload',
    icon: 'add',
    key: 'upload',
    label: 'Upload',
    name: 'upload',
  },
  {
    activeIcon: 'chatbubble-ellipses',
    href: '/chat',
    icon: 'chatbubble-ellipses-outline',
    key: 'chat',
    label: 'Inbox',
    name: 'chat',
  },
  {
    activeIcon: 'person',
    href: '/profile',
    icon: 'person-outline',
    key: 'profile',
    label: 'Profile',
    name: 'profile',
  },
];

// The feed draws a post edge to edge, so the bar has to float over it to let the video show
// through. Every other screen is a normal scrollable page, and overlaying there would bury
// the last row of a list under the bar.
const OVERLAY_TAB_KEYS = new Set(['home']);

// The camera draws edge to edge on upload, so its bar is dropped instead of shortened. The
// route level tabBarStyle option cannot do this: it only styles the default bar, and this
// layout replaces that bar with the function below. Rendering nothing is what hides it, and
// because the branch runs off the active route it comes straight back on the other tabs.
const HIDDEN_TAB_KEYS = new Set(['upload']);

const HIDDEN_TAB_BAR_STYLE = { display: 'none' } as const;

export default function TabsLayout() {
  const findFriendsOn = useFeatureFlag('findFriendsTab');
  const liveOn = useFeatureFlag('liveTab');

  const flagValues = { findFriendsTab: findFriendsOn, liveTab: liveOn };

  // The bar draws this list, so a flagged-off entry is dropped from here.
  const items = TABS.filter((tab) => !tab.flag || flagValues[tab.flag]);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // The bar sits in the layout flow on most screens, so each screen has to stop above
        // it. Without this the screen keeps the full window height and content runs under the
        // bar. The feed opts out below and draws its own bottom spacing instead.
        sceneStyle: { backgroundColor: '#F7F4EF' },
      }}
      tabBar={({ navigation, state }) => {
        // Resolved by route name rather than by index. A screen with href null is still registered and
        // still has an index, so indexing this bar's own list would land on the wrong entry the moment one
        // tab is hidden.
        const activeRoute = state.routes[state.index];
        const activeTab = activeRoute ? TABS.find((tab) => tab.name === activeRoute.name) : undefined;

        if (!activeTab || HIDDEN_TAB_KEYS.has(activeTab.key)) {
          return null;
        }

        return (
          <CurvedTabBar
            activeHref={activeTab?.href}
            isOverlay={activeTab ? OVERLAY_TAB_KEYS.has(activeTab.key) : false}
            items={items}
            onSelect={(item) => navigation.navigate(item.key as never)}
          />
        );
      }}
    >
      {TABS.map((tab) => {
        const hidden = Boolean(tab.flag) && !flagValues[tab.flag as 'findFriendsTab' | 'liveTab'];

        return (
          <Tabs.Screen
            key={tab.key}
            name={tab.name}
            options={{
              title: tab.label,
              // A flagged-off screen is registered with no href: off the bar, still routable. Without the
              // registration it would be an undeclared child of Tabs and pushing to it would fail.
              //
              // The cast is because TabItem types href as a plain string for the bar's benefit while the
              // screen options want a route that is checked against the routes that exist. Every href here
              // is a literal written by hand above, so the check being skipped is one that would pass.
              href: (hidden ? null : tab.href) as Href,
              // Belt and braces. This only styles the built in bar, and the tabBar prop above
              // replaces it, so HIDDEN_TAB_KEYS is what actually hides the bar on upload. Kept
              // so the route still reads as tab-less if the custom bar is ever removed.
              tabBarStyle: HIDDEN_TAB_KEYS.has(tab.key) ? HIDDEN_TAB_BAR_STYLE : undefined,
            }}
          />
        );
      })}

      {/* The people-nearby screen lost its slot on the bar to Live, but the screen still exists and the
          inbox links into it. href null keeps it registered and reachable while leaving it out of the
          bar; without this the route would be an undeclared child of Tabs and pushing to it would
          fail. Named for what it finds rather than for the relationship it starts. */}
      <Tabs.Screen name="friends" options={{ href: null, title: 'People' }} />
    </Tabs>
  );
}
