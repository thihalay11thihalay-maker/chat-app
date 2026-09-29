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

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // The bar sits in the layout flow, so each screen has to stop above it. Without
        // this the screen keeps the full window height and content runs under the bar.
        sceneStyle: { backgroundColor: '#F7F4EF' },
      }}
      tabBar={({ navigation, state }) => {
        const activeTab = TABS[state.index];

        return (
          <CurvedTabBar
            activeHref={activeTab?.href}
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
