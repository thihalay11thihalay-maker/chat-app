import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';
import { getAge, getString, UserData } from '@/lib/user-data';

type Profile = {
  age: number | null;
  city: string;
  country: string;
  displayName: string;
  email: string;
  interests: string[];
  phone: string;
  photoUrl: string;
};

const SIGN_OUT_CONFIRM_MS = 4000;

function readInterests(data: UserData) {
  const source = Array.isArray(data.interests) ? data.interests : data.interestedIn;
  if (!Array.isArray(source)) {
    return [];
  }

  return source.filter(
    (interest): interest is string => typeof interest === 'string' && interest.trim() !== '',
  );
}

async function loadProfile(): Promise<Profile> {
  const currentUser = getFirebaseAuth().currentUser;
  if (!currentUser) {
    throw new Error('You are not signed in.');
  }

  const snapshot = await getDoc(doc(getFirebaseDb(), 'users', currentUser.uid));
  const data = (snapshot.exists() ? snapshot.data() : {}) as UserData;

  return {
    age: getAge(data),
    city: getString(data, ['city']),
    country: getString(data, ['country']),
    displayName: getString(
      data,
      ['displayName', 'name', 'username'],
      currentUser.displayName || 'Your profile',
    ),
    email: currentUser.email || '',
    interests: readInterests(data),
    phone: currentUser.phoneNumber || '',
    photoUrl: getString(data, ['profilePictureUrl', 'photoURL', 'photoUrl', 'avatarUrl'])
      || currentUser.photoURL
      || '',
  };
}

export default function ProfileScreen() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isConfirmingSignOut, setIsConfirmingSignOut] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [photoFailed, setPhotoFailed] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    setErrorMessage('');

    try {
      setProfile(await loadProfile());
      setPhotoFailed(false);
    } catch (error) {
      console.error('Could not load the profile:', error);
      setProfile(null);
      setErrorMessage(error instanceof Error ? error.message : 'Could not load your profile.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Refetches on every focus so edits made in onboarding show up on the way back.
  useFocusEffect(
    useCallback(() => {
      setIsLoading(true);
      const timer = setTimeout(() => void refresh(), 0);
      return () => clearTimeout(timer);
    }, [refresh]),
  );

  useEffect(() => () => {
    if (confirmTimer.current) {
      clearTimeout(confirmTimer.current);
    }
  }, []);

  const handleSignOutPress = () => {
    // Two taps instead of a native dialog: Alert has no action buttons on web.
    if (!isConfirmingSignOut) {
      setIsConfirmingSignOut(true);
      confirmTimer.current = setTimeout(() => setIsConfirmingSignOut(false), SIGN_OUT_CONFIRM_MS);
      return;
    }

    setIsSigningOut(true);
    signOut(getFirebaseAuth())
      .then(() => {
        if (confirmTimer.current) {
          clearTimeout(confirmTimer.current);
        }
        router.replace('/login' as never);
      })
      .catch((error) => {
        console.error('Could not sign out:', error);
        setIsSigningOut(false);
        setIsConfirmingSignOut(false);
        setErrorMessage('Could not sign out. Please try again.');
      });
  };

  const location = [profile?.city, profile?.country].filter(Boolean).join(', ');

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      {isLoading ? (
        <View style={styles.stateContainer}>
          <ActivityIndicator color="#E56B4C" size="large" />
          <Text style={styles.stateText}>Loading your profile...</Text>
        </View>
      ) : errorMessage && !profile ? (
        <View style={styles.stateContainer}>
          <Ionicons color="#E56B4C" name="alert-circle-outline" size={34} />
          <Text style={styles.stateTitle}>Profile unavailable</Text>
          <Text style={styles.stateText}>{errorMessage}</Text>
          <Pressable onPress={() => void refresh()} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Try again</Text>
          </Pressable>
        </View>
      ) : profile ? (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.header}>
            <View style={styles.avatarWrap}>
              {profile.photoUrl && !photoFailed ? (
                <Image
                  onError={() => setPhotoFailed(true)}
                  source={{ uri: profile.photoUrl }}
                  style={styles.avatar}
                />
              ) : (
                <View style={styles.avatarFallback}>
                  <Text style={styles.avatarLetter}>{profile.displayName.charAt(0).toUpperCase()}</Text>
                </View>
              )}
            </View>

            <Text numberOfLines={1} style={styles.displayName}>{profile.displayName}</Text>
            <Text style={styles.meta}>
              {profile.age === null ? 'Age not set' : `${profile.age} years old`}
              {location ? `  ·  ${location}` : ''}
            </Text>
          </View>

          {errorMessage ? <Text style={styles.inlineError}>{errorMessage}</Text> : null}

          <View style={styles.card}>
            <Row icon="mail-outline" label="Email" value={profile.email} />
            {profile.phone ? <Row icon="call-outline" label="Phone" value={profile.phone} /> : null}
            {location ? <Row icon="location-outline" label="Location" value={location} /> : null}
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Interests</Text>
            <Text style={styles.sectionCount}>{profile.interests.length}</Text>
          </View>

          {profile.interests.length === 0 ? (
            <Text style={styles.emptyText}>
              No interests yet. Add a few so people know what to talk about.
            </Text>
          ) : (
            <View style={styles.chips}>
              {profile.interests.map((interest) => (
                <View key={interest} style={styles.chip}>
                  <Text style={styles.chipText}>{interest}</Text>
                </View>
              ))}
            </View>
          )}

          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/onboarding' as never)}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          >
            <Ionicons color="#20232A" name="create-outline" size={18} />
            <Text style={styles.secondaryButtonText}>Edit profile</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={isSigningOut}
            onPress={handleSignOutPress}
            style={({ pressed }) => [styles.dangerButton, pressed && styles.pressed]}
          >
            {isSigningOut ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Ionicons color="#FFFFFF" name="log-out-outline" size={18} />
            )}
            <Text style={styles.dangerButtonText}>
              {isSigningOut
                ? 'Signing out...'
                : isConfirmingSignOut
                  ? 'Tap again to sign out'
                  : 'Sign out'}
            </Text>
          </Pressable>
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

type RowProps = {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  value: string;
};

function Row({ icon, label, value }: RowProps) {
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}>
        <Ionicons color="#E56B4C" name={icon} size={16} />
      </View>
      <View style={styles.rowCopy}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text numberOfLines={1} style={styles.rowValue}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  content: {
    paddingBottom: 130,
    paddingHorizontal: 22,
    paddingTop: 18,
  },
  header: {
    alignItems: 'center',
    marginBottom: 22,
  },
  avatarWrap: {
    height: 96,
    marginBottom: 14,
    width: 96,
  },
  avatar: {
    backgroundColor: '#E7E2DA',
    borderRadius: 48,
    height: 96,
    width: 96,
  },
  avatarFallback: {
    alignItems: 'center',
    backgroundColor: '#F2C6B8',
    borderRadius: 48,
    flex: 1,
    justifyContent: 'center',
  },
  avatarLetter: {
    color: '#6E3D31',
    fontSize: 34,
    fontWeight: '800',
  },
  displayName: {
    color: '#20232A',
    fontSize: 24,
    fontWeight: '800',
  },
  meta: {
    color: '#777C84',
    fontSize: 13,
    marginTop: 6,
  },
  inlineError: {
    backgroundColor: '#FBE4DE',
    borderRadius: 10,
    color: '#A2402B',
    fontSize: 12,
    marginBottom: 14,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  card: {
    backgroundColor: '#FFFDFC',
    borderColor: '#E7E2DA',
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 22,
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  row: {
    alignItems: 'center',
    borderBottomColor: '#EFE9E1',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    paddingVertical: 12,
  },
  rowIcon: {
    alignItems: 'center',
    backgroundColor: '#FBE9E3',
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    marginRight: 12,
    width: 34,
  },
  rowCopy: {
    flex: 1,
    minWidth: 0,
  },
  rowLabel: {
    color: '#8D929C',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  rowValue: {
    color: '#20232A',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 3,
  },
  sectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
    marginBottom: 10,
  },
  sectionTitle: {
    color: '#363A42',
    fontSize: 15,
    fontWeight: '800',
  },
  sectionCount: {
    backgroundColor: '#D7E6DF',
    borderRadius: 10,
    color: '#315A49',
    fontSize: 11,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  emptyText: {
    color: '#777C84',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 22,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 26,
  },
  chip: {
    backgroundColor: '#FFFDFC',
    borderColor: '#E7E2DA',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  chipText: {
    color: '#363A42',
    fontSize: 12,
    fontWeight: '700',
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 13,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 9,
    justifyContent: 'center',
    marginBottom: 12,
    paddingVertical: 14,
  },
  secondaryButtonText: {
    color: '#20232A',
    fontSize: 14,
    fontWeight: '800',
  },
  dangerButton: {
    alignItems: 'center',
    backgroundColor: '#C4462F',
    borderRadius: 13,
    flexDirection: 'row',
    gap: 9,
    justifyContent: 'center',
    paddingVertical: 14,
  },
  dangerButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.72,
  },
  stateContainer: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingBottom: 40,
    paddingHorizontal: 28,
  },
  stateTitle: {
    color: '#20232A',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 12,
    textAlign: 'center',
  },
  stateText: {
    color: '#777C84',
    fontSize: 14,
    lineHeight: 21,
    marginTop: 8,
    textAlign: 'center',
  },
  primaryButton: {
    backgroundColor: '#20232A',
    borderRadius: 10,
    marginTop: 18,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
});
