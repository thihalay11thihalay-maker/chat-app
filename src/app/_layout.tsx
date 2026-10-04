import { router } from 'expo-router';
import { Stack } from 'expo-router/stack';
import type { Auth } from 'firebase/auth';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { CaptureProvider } from '@/components/capture-provider';
import { ErrorBoundary } from '@/components/error-boundary';
import { useBotResponder } from '@/hooks/use-bot-responder';
import { usePresenceReporter } from '@/hooks/use-presence';
import { useVisibilityBackfill } from '@/hooks/use-visibility-backfill';
import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';
import { FeatureFlagsProvider } from '@/lib/feature-flags';

/**
 * Keeps this account's presence published for as long as it is signed in.
 *
 * A component rather than a hook called in RootLayout, because the root returns early while the
 * navigator and the signed-in gate are still resolving, and a hook called across those early returns
 * would be called in a different order each time and lose its subscriptions.
 */
function PresenceReporter() {
  usePresenceReporter();

  return null;
}

/**
 * Answers messages, but only when this account is the bot.
 *
 * A separate component from PresenceReporter for the same reason it is one at all: a hook called in
 * RootLayout would be called across the early returns below and lose its subscriptions. Both are
 * silent, and both are off for anybody whose profile is not flagged, so a normal build does nothing
 * here.
 */
function BotResponder() {
  useBotResponder();

  return null;
}

/**
 * Gives this account's older posts a visibility, once, on sign-in.
 *
 * A component for the same reason as the two above: RootLayout returns early while auth and the
 * navigator resolve, and a hook called across those returns loses its subscriptions.
 */
function VisibilityBackfill() {
  useVisibilityBackfill();

  return null;
}

export default function RootLayout() {
  return (
    // React Navigation, which expo-router runs on, uses react-native-gesture-handler for its
    // own transitions and drawers, and it expects the root of the app to be a gesture handler
    // root. Cheap to keep, and removing it risks breaking navigation gestures.
    <GestureHandlerRootView style={styles.root}>
      <ErrorBoundary>
        {/* Above the navigator, and above everything that reads a flag. Without this mounted the whole
            override layer was dead: `useFeatureFlag` fell back to the build-time values, so AsyncStorage
            was never read, `setOverride` was unreachable, and a flag could only be changed by editing
            app.json and shipping a build. It wraps the navigator rather than living inside a screen so a
            flag read during the first render already has the device's overrides applied. */}
        <FeatureFlagsProvider>
          {/* Above the navigator so a capture survives navigating from the camera to the story
              editor and on to the details screen. */}
          <CaptureProvider>
            {/* Inside the providers but above the navigator, so presence is published from launch and
                survives navigating anywhere in the app. */}
            <PresenceReporter />
            <BotResponder />
            <VisibilityBackfill />
            <RootNavigator />
          </CaptureProvider>
        </FeatureFlagsProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}

type AuthResolution = { instance: Auth | null; error: string };

function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  return 'Unknown error';
}

function resolveAuth(): AuthResolution {
  try {
    return { error: '', instance: getFirebaseAuth() };
  } catch (error) {
    return {
      error: `Firebase auth could not initialise: ${describeError(error)}. Add the EXPO_PUBLIC_FIREBASE_* values to .env.local and restart the dev server.`,
      instance: null,
    };
  }
}

function RootNavigator() {
  // Resolved during the first render, not inside an effect. getFirebaseAuth() throws
  // when the EXPO_PUBLIC_FIREBASE_* values are missing; letting that throw escape into
  // an effect crashed the root layout and showed a blank white screen with no clue why.
  const [auth, setAuth] = useState<AuthResolution>(resolveAuth);
  const authError = auth.error;
  const [isCheckingAuth, setIsCheckingAuth] = useState(!authError);

  // A missing key is a setup problem, not a crash. The message is rendered on the
  // screen below and logged once so LogBox keeps the details without breaking the app.
  useEffect(() => {
    if (authError) {
      console.error(authError);
    }
  }, [authError]);

  const retrySetup = useCallback(() => {
    const next = resolveAuth();
    setAuth(next);
    setIsCheckingAuth(!next.error);
  }, []);

  useEffect(() => {
    let isMounted = true;
    const authInstance = auth.instance;

    if (!authInstance) {
      return undefined;
    }

    const unsubscribe = onAuthStateChanged(authInstance, async (user) => {
      if (!user) {
        if (isMounted) {
          setIsCheckingAuth(false);
          router.replace('/login');
        }
        return;
      }

      try {
        const profileSnapshot = await getDoc(doc(getFirebaseDb(), 'users', user.uid));
        const profileComplete = profileSnapshot.exists()
          && profileSnapshot.data().profileComplete === true;

        if (isMounted) {
          setIsCheckingAuth(false);
          router.replace(profileComplete ? '/home' as never : '/onboarding');
        }
      } catch (error) {
        console.error('Failed to load the user profile:', error);
        if (isMounted) {
          setIsCheckingAuth(false);
          router.replace('/onboarding');
        }
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [auth]);

  if (isCheckingAuth) {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator color="#E56B4C" size="large" />
      </View>
    );
  }

  if (authError) {
    return (
      <View style={styles.loadingScreen}>
        <Text style={styles.errorTitle}>Setup needed</Text>
        <Text style={styles.errorBody}>{authError}</Text>
        <Pressable accessibilityRole="button" onPress={retrySetup} style={styles.retryButton}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  // A navigator that failed to resolve would otherwise render as an invalid element and
  // take the whole app down, so the screen is shown instead of crashing.
  if (typeof Stack === 'undefined') {
    return (
      <View style={styles.loadingScreen}>
        <Text style={styles.errorTitle}>Router unavailable</Text>
        <Text style={styles.errorBody}>
          expo-router did not provide a Stack navigator. Restart the dev server with
          {' '}
          npx expo start -c
        </Text>
      </View>
    );
  }

  return (
    // Above the navigator so every screen gets the same keyboard handling, and so the measure is
    // taken once for the whole app rather than per screen.
    //
    // Android 16 enforces edge-to-edge, so the window no longer resizes for the keyboard and
    // React Native's own KeyboardAvoidingView, which relies on that resize when `behavior` is
    // undefined, leaves the composer under the keyboard. This provider is what makes the keyboard
    // height readable on Android, which the screens use to move their inputs clear of it.
    <KeyboardProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </KeyboardProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  loadingScreen: {
    alignItems: 'center',
    backgroundColor: '#F7F4EF',
    flex: 1,
    justifyContent: 'center',
    padding: 28,
  },
  errorTitle: {
    color: '#20232A',
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 10,
  },
  errorBody: {
    color: '#656A73',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: '#20232A',
    borderRadius: 10,
    marginTop: 20,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
});
