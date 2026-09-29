import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { decode } from 'base64-arraybuffer';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { onAuthStateChanged, User } from 'firebase/auth';
import { addDoc, collection, doc, getDoc, serverTimestamp } from 'firebase/firestore';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';
import { getString } from '@/lib/user-data';

const IMAGE_CONTENT_TYPE = 'image/jpeg';
const VIDEO_CONTENT_TYPE = 'video/mp4';
const UPLOAD_ATTEMPTS = 3;

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
const supabaseAccessToken = process.env.EXPO_PUBLIC_SUPABASE_ACCESS_TOKEN || '';
const supabaseBucket = process.env.EXPO_PUBLIC_SUPABASE_BUCKET || 'media';

let supabaseClient: SupabaseClient | null = null;

function isSupabaseConfigured() {
  return Boolean(supabaseUrl && supabaseAnonKey);
}

function getSupabase(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error(
      'Supabase is not configured. Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to .env.local, then restart the dev server.',
    );
  }

  supabaseClient ??= createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: supabaseAccessToken
      ? { headers: { Authorization: `Bearer ${supabaseAccessToken}` } }
      : undefined,
  });

  return supabaseClient;
}

function toErrorDetails(error: unknown) {
  return typeof error === 'object' && error !== null
    ? error as { name?: unknown; message?: unknown; status?: unknown; statusCode?: unknown }
    : {};
}

function errorText(error: unknown) {
  const details = toErrorDetails(error);
  const name = typeof details.name === 'string' ? details.name : '';
  const message = typeof details.message === 'string' ? details.message : '';

  return `${name} ${message}`.toLowerCase();
}

// Android reports connection problems as "fetch failed" plus a nested java.io
// exception, so the string has to be checked instead of the error name.
function isNetworkError(error: unknown) {
  const text = errorText(error);

  return /fetch failed|failed to fetch|network ?request ?failed|networkerror|connectexception|connection ?refused|unable to resolve host|econnreset|econnrefused|etimedout|timeout|socket|load failed|not found/.test(text);
}

function isUnknownHostError(error: unknown) {
  return /unable to resolve host|enotfound|name not resolved|nxdomain|getaddrinfo/.test(errorText(error));
}

function describeError(error: unknown) {
  const details = toErrorDetails(error);
  const message = typeof details.message === 'string' ? details.message : '';
  const statusCode = typeof details.statusCode === 'number'
    ? details.statusCode
    : typeof details.status === 'number'
      ? details.status
      : 0;
  const combined = `${typeof details.name === 'string' ? details.name : ''} ${message}`.toLowerCase();

  if (isUnknownHostError(error)) {
    return `Could not resolve "${supabaseUrl}". Check the Project URL and publishable key in .env.local (Dashboard -> Project Settings -> API), then restart the dev server.`;
  }
  if (isNetworkError(error)) {
    return `This device could not reach Supabase. Your connection dropped while uploading, so the upload was retried ${UPLOAD_ATTEMPTS} times. Check mobile data or Wi-Fi (some networks block Supabase's CDN) and try again.`;
  }
  if (statusCode === 401 || statusCode === 403) {
    return 'Supabase rejected the upload token. Check EXPO_PUBLIC_SUPABASE_ACCESS_TOKEN.';
  }
  if (statusCode === 404 || combined.includes('bucket')) {
    return `Bucket "${supabaseBucket}" was not found. Create it in Supabase Storage, or set EXPO_PUBLIC_SUPABASE_BUCKET.`;
  }
  if (combined.includes('row-level security') || combined.includes('policy')) {
    return 'Supabase Storage policies blocked this upload. Add an INSERT policy for anon and authenticated on the bucket.';
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  return 'Something went wrong.';
}

// Large videos over mobile data drop the connection often enough that a single failed
// request is not enough to call the upload a failure.
async function uploadWithRetry(fileName: string, fileBody: ArrayBuffer | Blob, contentType: string) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      const { error } = await getSupabase()
        .storage.from(supabaseBucket)
        .upload(fileName, fileBody, {
          contentType,
          upsert: true,
        });

      if (!error) {
        return;
      }

      lastError = error;

      if (!isNetworkError(error)) {
        throw error;
      }
    } catch (error) {
      lastError = error;

      if (!isNetworkError(error)) {
        throw error;
      }
    }

    if (attempt < UPLOAD_ATTEMPTS) {
      await new Promise((resolve) => {
        setTimeout(resolve, 800 * attempt);
      });
    }
  }

  throw lastError;
}

export default function UploadScreen() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [media, setMedia] = useState<{
    base64: string;
    contentType: string;
    mediaType: 'image' | 'video';
    uri: string;
  } | null>(null);
  const [caption, setCaption] = useState('');
  const [isPicking, setIsPicking] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    let unsubscribe = () => {};

    try {
      unsubscribe = onAuthStateChanged(getFirebaseAuth(), setCurrentUser);
    } catch (error) {
      console.error('Firebase auth is unavailable:', error);
    }

    return unsubscribe;
  }, []);

  useEffect(() => {
    const uid = currentUser?.uid;
    if (!uid) {
      return undefined;
    }

    let isCancelled = false;

    void (async () => {
      try {
        const snapshot = await getDoc(doc(getFirebaseDb(), 'users', uid));
        const data = snapshot.exists() ? snapshot.data() : {};
        const name = getString(data, ['displayName', 'name', 'username']);
        if (!isCancelled) {
          setDisplayName(name || currentUser?.displayName || uid.slice(0, 8));
        }
      } catch (error) {
        console.error('Could not load the profile name:', error);
        if (!isCancelled) {
          setDisplayName(currentUser?.displayName || uid.slice(0, 8));
        }
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [currentUser]);

  // 1. Pick a photo or video. Images come back as base64; videos do not on every
  // platform, so videos are uploaded from the uri with fetch + blob().
  const pickMedia = useCallback(async () => {
    setErrorMessage('');
    setIsPicking(true);

    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission required', 'Allow access to your photos and videos.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: false,
        base64: true,
        mediaTypes: ['images', 'videos'],
        quality: 1,
      });

      if (result.canceled) {
        return;
      }

      const asset = result.assets[0];
      const mediaType = asset.type === 'video' ? 'video' : 'image';
      const base64 = asset.base64 ?? '';

      if (mediaType === 'image' && !base64) {
        setErrorMessage('Could not get file info. Please try again.');
        return;
      }

      setMedia({
        base64,
        contentType: mediaType === 'video' ? VIDEO_CONTENT_TYPE : IMAGE_CONTENT_TYPE,
        mediaType,
        uri: asset.uri,
      });
    } catch (error) {
      console.error('Could not pick media:', error);
      setErrorMessage('Could not get file info. Please try again.');
    } finally {
      setIsPicking(false);
    }
  }, []);

  const uploadPost = useCallback(async () => {
    if (!currentUser) {
      Alert.alert('Login required', 'You need to be logged in.');
      return;
    }
    if (!media || !caption.trim()) {
      Alert.alert('Missing details', 'Please add a photo/video and a caption.');
      return;
    }

    setIsUploading(true);
    setErrorMessage('');

    const extension = media.mediaType === 'video' ? 'mp4' : 'jpg';
    const fileName = `${currentUser.uid}_${Date.now()}.${extension}`;
    const contentType = media.mediaType === 'video' ? VIDEO_CONTENT_TYPE : IMAGE_CONTENT_TYPE;
    let byteLength = 0;

    try {
      let fileBody: ArrayBuffer | Blob;

      if (media.mediaType === 'video') {
        // 2. Video: base64 is not available, so read the file with fetch and take a blob.
        const response = await fetch(media.uri);

        if (!response.ok) {
          throw new Error(`Could not read the video file (status ${response.status}).`);
        }

        const blob = await response.blob();
        byteLength = blob.size;
        // supabase-js ignores options.contentType for Blob bodies and uses the blob type
        // for the multipart part, so the blob type is set explicitly.
        fileBody = blob.type.startsWith('video/')
          ? blob
          : new Blob([blob], { type: VIDEO_CONTENT_TYPE });
      } else {
        // 1. Image: convert the base64 string into an ArrayBuffer.
        if (!media.base64) {
          throw new Error('Could not get file info. Please try again.');
        }

        const arrayBuffer = decode(media.base64);
        byteLength = arrayBuffer.byteLength;
        fileBody = arrayBuffer;
      }

      // 3. Upload to Supabase Storage. Without contentType it is stored as text/plain.
      await uploadWithRetry(fileName, fileBody, contentType);

      const { data } = getSupabase().storage.from(supabaseBucket).getPublicUrl(fileName);
      const mediaUrl = data.publicUrl;

      // 4. Save the post in the Firestore posts collection.
      await addDoc(collection(getFirebaseDb(), 'posts'), {
        caption: caption.trim(),
        createdAt: serverTimestamp(),
        displayName: displayName || currentUser.displayName || 'User',
        mediaType: media.mediaType,
        mediaUrl,
        userId: currentUser.uid,
      });
    } catch (error) {
      // 5. Detailed error logging
      console.error('Upload failed', {
        bucket: supabaseBucket,
        bytes: byteLength,
        caption: caption.trim(),
        contentType,
        error,
        errorMessage: describeError(error),
        fileName,
        mediaType: media.mediaType,
        source: media.mediaType === 'video' ? 'fetch-blob' : 'base64-arraybuffer',
        supabaseUrl,
        userId: currentUser.uid,
      });
      setErrorMessage(describeError(error));
      setIsUploading(false);
      return;
    }

    setIsUploading(false);
    setCaption('');
    setMedia(null);
    Alert.alert('Success', 'Post uploaded successfully.');
    router.replace('/home');
  }, [caption, currentUser, displayName, media]);

  const isBusy = isUploading || isPicking;

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.container}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.eyebrow}>SHARE</Text>
          <Text style={styles.header}>Create Post</Text>

          {!isSupabaseConfigured() ? (
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>Supabase setup needed</Text>
              <Text style={styles.noticeBody}>
                {`Add these to .env.local and restart the dev server:\nEXPO_PUBLIC_SUPABASE_URL\nEXPO_PUBLIC_SUPABASE_ANON_KEY`}
              </Text>
            </View>
          ) : null}

          <Pressable
            accessibilityLabel="Pick a photo or video"
            accessibilityRole="button"
            disabled={isBusy}
            onPress={() => void pickMedia()}
            style={({ pressed }) => [styles.mediaPicker, pressed && styles.pressed, isBusy && styles.disabled]}
          >
            {media ? (
              <>
                {media.mediaType === 'image' ? (
                  <Image contentFit="cover" source={{ uri: media.uri }} style={styles.mediaPreview} />
                ) : (
                  <View style={styles.mediaPreview}>
                    <Text style={styles.videoBadge}>VIDEO</Text>
                    <Text style={styles.videoHint}>{VIDEO_CONTENT_TYPE}</Text>
                  </View>
                )}
                <View style={styles.replaceTag}>
                  <Text style={styles.replaceTagText}>Change</Text>
                </View>
              </>
            ) : (
              <View style={styles.pickerPlaceholder}>
                <Text style={styles.pickerPlus}>+</Text>
                <Text style={styles.mediaPickerText}>Select Photo or Video</Text>
              </View>
            )}
          </Pressable>

          <Text style={styles.inputLabel}>Caption</Text>
          <TextInput
            editable={!isUploading}
            maxLength={220}
            multiline
            onChangeText={setCaption}
            placeholder="Write a caption..."
            placeholderTextColor="#8D929C"
            style={styles.input}
            value={caption}
          />

          {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

          <Pressable
            accessibilityLabel="Share post"
            accessibilityRole="button"
            disabled={isBusy}
            onPress={() => void uploadPost()}
            style={({ pressed }) => [styles.postButton, pressed && styles.pressed, isBusy && styles.disabled]}
          >
            {isBusy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.postButtonText}>Post</Text>}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  container: {
    flex: 1,
  },
  content: {
    padding: 22,
    paddingBottom: 40,
  },
  eyebrow: {
    color: '#E56B4C',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.6,
    marginBottom: 4,
  },
  header: {
    color: '#20232A',
    fontSize: 26,
    fontWeight: '800',
    marginBottom: 18,
  },
  notice: {
    backgroundColor: '#FFF4E9',
    borderColor: '#E7C79A',
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 16,
    padding: 14,
  },
  noticeTitle: {
    color: '#8A5A22',
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 6,
  },
  noticeBody: {
    color: '#8A5A22',
    fontSize: 12,
    lineHeight: 18,
  },
  mediaPicker: {
    alignItems: 'center',
    backgroundColor: '#20232A',
    borderRadius: 20,
    height: 260,
    justifyContent: 'center',
    overflow: 'hidden',
    width: '100%',
  },
  mediaPreview: {
    alignItems: 'center',
    height: '100%',
    justifyContent: 'center',
    width: '100%',
  },
  pickerPlaceholder: {
    alignItems: 'center',
    gap: 10,
  },
  pickerPlus: {
    color: '#FFFFFF',
    fontSize: 40,
    fontWeight: '300',
  },
  mediaPickerText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  videoBadge: {
    backgroundColor: '#E56B4C',
    borderRadius: 6,
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.2,
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  videoHint: {
    color: '#A9AEB8',
    fontSize: 13,
    marginTop: 10,
  },
  replaceTag: {
    backgroundColor: 'rgba(32, 35, 42, 0.72)',
    borderRadius: 14,
    bottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 6,
    position: 'absolute',
    right: 12,
  },
  replaceTagText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  inputLabel: {
    color: '#656A73',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 8,
    marginTop: 20,
    textTransform: 'uppercase',
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 14,
    borderWidth: 1,
    color: '#20232A',
    fontSize: 15,
    minHeight: 92,
    padding: 14,
    textAlignVertical: 'top',
  },
  errorText: {
    color: '#B84141',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 14,
  },
  postButton: {
    alignItems: 'center',
    backgroundColor: '#E56B4C',
    borderRadius: 16,
    justifyContent: 'center',
    marginTop: 20,
    minHeight: 56,
  },
  postButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.72,
  },
});
