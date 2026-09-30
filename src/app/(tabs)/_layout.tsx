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
        <Tabs.Screen key={tab.key} name={tab.name} options={{ title: tab.label }} />
      ))}
    </Tabs>
  );
}
