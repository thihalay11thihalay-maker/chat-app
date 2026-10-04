import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from 'react';
import { Alert } from 'react-native';

/**
 * Which parts of the app are switched on.
 *
 * A flag rather than a deleted import, because the thing being turned off here is not broken -- the Live
 * tab and the call buttons both work, and both are wanted back. Deleting them would make turning them on
 * a rewrite rather than a one-line change, and would throw away the Agora wiring that took the token flow
 * to get right.
 *
 * Two layers, because they answer different questions:
 *   the build-time values   - what this build is supposed to ship with. Read from `extra.featureFlags` in
 *                             app.json, so an EAS build profile can ship the tab off without a code
 *                             change, and so a fresh checkout has a known state rather than whatever the
 *                             last person left on their device.
 *   the runtime overrides   - what this device has been told instead. Held in AsyncStorage and applied on
 *                             top, which is what makes a flag flippable without a rebuild: the Profile
 *                             screen's developer section writes them.
 *
 * Overrides are per device and never leave it. They are not a remote config and there is nothing here
 * that fetches a flag from a server, so an app in the store cannot be switched into a state its build was
 * not reviewed for. That is a deliberate limit: a real rollout flag wants a trusted server, and until there
 * is one, this is a developer switch and not a rollout.
 */

/**
 * Every flag, and what it ships as when app.json says nothing.
 *
 * These are the last word only when `extra.featureFlags` in app.json is silent. It is not, at the moment,
 * and that is deliberate: a flag this app cannot turn off for users in the field is not a flag, it is a
 * comment. So the values below are the fallback and app.json is the switch, and a build profile that
 * should not ship a feature sets it off there.
 *
 * Read the precedence in `buildFeatureFlags`.
 */
export const FEATURE_FLAG_DEFAULTS = {
  /**
   * The Live tab on the bottom bar.
   *
   * Off because Live is being replaced by Find Friends in the same slot. `live.tsx` is untouched and
   * stays registered as a route, so turning this back on restores the tab with nothing else to do.
   */
  liveTab: false,
  /**
   * The Find Friends tab, in the slot Live used to have.
   *
   * Off, and it should stay off until the Firestore rules and composite indexes it reads have actually
   * been deployed -- see the ordering at the top of firestore.rules. With the flag on and the rules
   * undeployed, every suggestion and every contact match fails with permission-denied, so the tab ships
   * broken rather than merely empty. Turn it on in `extra.featureFlags` in app.json once
   * `npm run deploy:rules` has been run and the indexes have finished building.
   */
  findFriendsTab: false,
  /**
   * The phone and video call buttons in a conversation's header.
   *
   * Off because calling needs an Agora App Certificate that this build does not have yet. The buttons led
   * to a call screen that could not get a token, so they are hidden rather than left to fail. `openCall`,
   * the `/call/[id]` routes and `src/lib/agora-call.ts` all stay exactly where they are.
   */
  chatCalls: false,
} as const;

export type FeatureFlagName = keyof typeof FEATURE_FLAG_DEFAULTS;

export type FeatureFlags = Record<FeatureFlagName, boolean>;

/** Human names for the developer section, and why each one is currently the way it is. */
export const FEATURE_FLAG_LABELS: Record<FeatureFlagName, string> = {
  chatCalls: 'Calls in chat (needs AGORA_APP_CERTIFICATE)',
  findFriendsTab: 'Find Friends tab',
  liveTab: 'Live tab',
};

const OVERRIDE_KEY = 'convo.featureFlagOverrides.v1';

/**
 * The values this build ships with, read once.
 *
 * From `Constants.expoConfig.extra`, not from `process.env`: an env var has to be set on every machine
 * that opens the project before the app will show the tab it is supposed to have, and a missing one
 * silently reverts to the default rather than failing. app.json is checked in and is the same for
 * everybody.
 *
 * Unknown keys are ignored and missing ones fall back to the defaults, so a half-filled app.json or one
 * from a newer build cannot produce `undefined` for a flag the screens ask about.
 */
function buildTimeFlags(): FeatureFlags {
  const configured = (Constants.expoConfig?.extra?.featureFlags ?? {}) as Partial<Record<string, unknown>>;
  const resolved = {} as FeatureFlags;

  (Object.keys(FEATURE_FLAG_DEFAULTS) as FeatureFlagName[]).forEach((name) => {
    const value = configured[name];

    resolved[name] = typeof value === 'boolean' ? value : FEATURE_FLAG_DEFAULTS[name];
  });

  return resolved;
}

/** The values this build ships with, for anything outside React. */
export const BUILD_FEATURE_FLAGS: FeatureFlags = buildTimeFlags();

type FlagContextValue = {
  flags: FeatureFlags;
  isReady: boolean;
  setOverride: (name: FeatureFlagName, value: boolean | null) => Promise<void>;
};

const FeatureFlagContext = createContext<FlagContextValue | null>(null);

/**
 * The flags, with any overrides this device has applied.
 *
 * Falls back to the build-time values outside the provider rather than throwing, because a component that
 * reads a flag must not take the app down over it -- and the one place that genuinely runs outside the
 * provider (the tab bar's own default list) has to be able to answer.
 */
export function useFeatureFlags(): FeatureFlags {
    return useContext(FeatureFlagContext)?.flags ?? BUILD_FEATURE_FLAGS;
}

/** Whether one flag is on. The common case, so it does not need the whole object. */
export function useFeatureFlag(name: FeatureFlagName): boolean {
    return useFeatureFlags()[name];
}

/**
 * Puts the flags in reach of the whole app.
 *
 * The overrides are read after the first render rather than before it, so the bar appears on its first
 * paint instead of waiting on storage: an app that shows nothing while a key is read is indistinguishable
 * from one that has crashed, and the build-time value is right almost every time.
 */
export function FeatureFlagsProvider({ children }: { children: React.ReactNode }) {
  const [overrides, setOverrides] = useState<Partial<Record<FeatureFlagName, boolean>>>({});
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let isMounted = true;

    void (async () => {
      try {
        const stored = await AsyncStorage.getItem(OVERRIDE_KEY);
        const parsed = stored ? JSON.parse(stored) as Record<string, unknown> : {};
        const next: Partial<Record<FeatureFlagName, boolean>> = {};

        (Object.keys(FEATURE_FLAG_DEFAULTS) as FeatureFlagName[]).forEach((name) => {
          const value = parsed?.[name];

          if (typeof value === 'boolean') {
            next[name] = value;
          }
        });

        if (isMounted) {
          setOverrides(next);
        }
      } catch (error) {
        // Corrupt or unreadable storage is not a reason to hold the app at a splash screen. The build's
        // values are a good answer, so they are the answer.
        console.warn('Could not read the feature flag overrides; using the build defaults:', error);
      } finally {
        if (isMounted) {
          setIsReady(true);
        }
      }
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  const setOverride = useCallback(async (name: FeatureFlagName, value: boolean | null) => {
    const next = { ...overrides };

    if (value === null) {
      delete next[name];
    } else {
      next[name] = value;
    }

    // Written before the state changes rather than after: if the write fails the flag must not have moved
    // on screen, or the switch says one thing and the next launch says another.
    try {
      await AsyncStorage.setItem(OVERRIDE_KEY, JSON.stringify(next));
    } catch (error) {
      console.warn('Could not save the feature flag override:', error);
      Alert.alert('Not saved', 'The flag could not be stored on this device.');

      return;
    }

    setOverrides(next);
  }, [overrides]);

  const flags = useMemo(() => {
    const merged = { ...BUILD_FEATURE_FLAGS };

    (Object.keys(overrides) as FeatureFlagName[]).forEach((name) => {
      const value = overrides[name];

      if (typeof value === 'boolean') {
        merged[name] = value;
      }
    });

    return merged;
  }, [overrides]);

  const value = useMemo(() => ({ flags, isReady, setOverride }), [flags, isReady, setOverride]);

  return <FeatureFlagContext.Provider value={value}>{children}</FeatureFlagContext.Provider>;
}