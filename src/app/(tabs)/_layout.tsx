import { Tabs } from 'expo-router';

import { CurvedTabBar, type TabItem } from '@/components/curved-tab-bar';

// The curved bar draws itself, so the screen order and this list have to stay the same:
// the middle entry is the raised upload button.
const TABS: (TabItem & { name: string })[] = [
  {
    activeIcon: 'home',
    href: '/home',
    icon: 'home-outline',
    key: 'home',
    label: 'Home',
    name: 'home',
  },
  {
    activeIcon: 'people',
    href: '/friends',
    icon: 'people-outline',
    key: 'friends',
    label: 'Friends',
    name: 'friends',
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
        const activeTab = TABS[state.index];

        if (!activeTab || HIDDEN_TAB_KEYS.has(activeTab.key)) {
          return null;
        }

        return (
          <CurvedTabBar
            activeHref={activeTab?.href}
            isOverlay={activeTab ? OVERLAY_TAB_KEYS.has(activeTab.key) : false}
            items={TABS}
            onSelect={(item) => navigation.navigate(item.key as never)}
          />
        );
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.key}
          name={tab.name}
          options={{
            title: tab.label,
            // Belt and braces. This only styles the built in bar, and the tabBar prop above
            // replaces it, so HIDDEN_TAB_KEYS is what actually hides the bar on upload. Kept
            // so the route still reads as tab-less if the custom bar is ever removed.
            tabBarStyle: HIDDEN_TAB_KEYS.has(tab.key) ? HIDDEN_TAB_BAR_STYLE : undefined,
          }}
        />
      ))}
    </Tabs>
  );
}
