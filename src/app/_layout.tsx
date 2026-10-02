import { router } from 'expo-router';
import { Stack } from 'expo-router/stack';
import type { Auth } from 'firebase/auth';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { CaptureProvider } from '@/components/capture-provider';
import { ErrorBoundary } from '@/components/error-boundary';
import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';

export default function RootLayout() {
  return (
    // React Navigation, which expo-router runs on, uses react-native-gesture-handler for its
    // own transitions and drawers, and it expects the root of the app to be a gesture handler
    // root. Cheap to keep, and removing it risks breaking navigation gestures.
    <GestureHandlerRootView style={styles.root}>
      <ErrorBoundary>
        {/* Above the navigator so a capture survives navigating from the camera to the story
            editor and on to the details screen. */}
        <CaptureProvider>
          <RootNavigator />
        </CaptureProvider>
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

  return <Stack screenOptions={{ headerShown: false }} />;
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
