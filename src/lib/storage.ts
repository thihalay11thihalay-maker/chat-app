import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import { getDownloadURL, ref, uploadBytes, getStorage } from 'firebase/storage';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';

const STORAGE = getStorage();

export async function pickImage(): Promise<string | null> {
  try {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      alert('Photo library permission is required.');
      return null;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.7,
    });

    if (!result.canceled && result.assets && result.assets.length > 0) {
      return result.assets[0].uri;
    }
  } catch (error) {
    console.error('Error picking image:', error);
  }
  return null;
}

export async function pickAudio(): Promise<{ uri: string; durationMs: number } | null> {
  try {
    const result = await DocumentPicker.getDocumentAsync({
      type: Platform.OS === 'ios' ? ['public.audio'] : ['audio/*'],
      copyToCacheDirectory: true,
    });

    if (result.canceled || !result.assets || result.assets.length === 0) {
      return null;
    }

    const asset = result.assets[0];
    return { uri: asset.uri, durationMs: 0 };
  } catch (error) {
    console.error('Error picking audio:', error);
    return null;
  }
}

export async function uploadFile(uri: string, path: string): Promise<string> {
  const response = await fetch(uri);
  const blob = await response.blob();
  const storageRef = ref(STORAGE, path);
  await uploadBytes(storageRef, blob);
  return getDownloadURL(storageRef);
}

export async function uploadAvatar(uri: string): Promise<string> {
  const extension = uri.split('.').pop()?.toLowerCase() ?? 'jpg';
  const { getCurrentUserProfile } = await import('./users');
  const profile = await getCurrentUserProfile();
  const path = `avatars/${profile.uid}.${extension}`;
  return uploadFile(uri, path);
}

export function getDocumentUri(): string | undefined {
  // @ts-expect-error - expo-file-system types may be outdated
  return FileSystem.documentDirectory ?? FileSystem.cacheDirectory;
}