import {
    RecordingPresets,
    requestRecordingPermissionsAsync,
    setAudioModeAsync,
    useAudioRecorder,
    useAudioRecorderState,
} from 'expo-audio';
import * as ImagePicker from 'expo-image-picker';
import { User } from 'firebase/auth';
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';

import { getFirebaseDb, getFirebaseStorage, isFirebaseStorageConfigured } from '@/lib/firebase';

export type MediaMessageType = 'image' | 'video' | 'audio';

type MediaKind = 'image' | 'video' | 'audio' | 'gif';

function isStorageUnavailable(error: unknown) {
    const details = typeof error === 'object' && error !== null
        ? error as { code?: unknown; message?: unknown; serverResponse?: unknown }
        : {};
    const errorText = [details.code, details.message, details.serverResponse]
        .filter((value) => typeof value === 'string')
        .join(' ')
        .toLowerCase();

    return /storage\/(bucket-not-found|project-not-found|unknown)/.test(errorText)
        || /billing|blaze|quota|bucket.*not found|storage.*not (enabled|configured|available)/.test(errorText);
}

export function useChatMedia(chatId: string, currentUser: User | null) {
    const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
    const recorderState = useAudioRecorderState(recorder);
    const [isUploading, setIsUploading] = useState(false);
    const [isAttachmentMenuVisible, setIsAttachmentMenuVisible] = useState(false);
    const [isRecording, setIsRecording] = useState(false);

    const showStorageComingSoon = useCallback(() => {
        Alert.alert(
            'Coming Soon',
            'Media sharing will be available when Firebase Storage is enabled on the Blaze plan.',
        );
    }, []);

    const stopRecording = useCallback(async () => {
        try {
            await recorder.stop();
        } finally {
            try {
                await setAudioModeAsync({ allowsRecording: false });
            } catch (error) {
                console.error('Could not reset the audio session:', error);
            }
        }
    }, [recorder]);

    const stopRef = useRef(stopRecording);
    const isRecordingRef = useRef(false);

    useEffect(() => {
        stopRef.current = stopRecording;
    }, [stopRecording]);

    useEffect(() => () => {
        if (isRecordingRef.current) {
            isRecordingRef.current = false;
            void stopRef.current();
        }
    }, [chatId]);
    const uploadAndSendMedia = useCallback(async (
        uri: string,
        type: MediaMessageType,
        fileName: string,
        contentType: string,
    ) => {
        if (!currentUser) {
            Alert.alert('Login required', 'Please log in to send media.');
            return;
        }
        if (!isFirebaseStorageConfigured()) {
            showStorageComingSoon();
            return;
        }

        setIsUploading(true);
        try {
            const response = await fetch(uri);
            if (!response.ok) {
                throw new Error('Could not read the selected media file.');
            }
            const blob = await response.blob();
            const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
            const mediaRef = ref(
                getFirebaseStorage(),
                `chats/${chatId}/messages/${currentUser.uid}/${Date.now()}_${safeName}`,
            );
            await uploadBytes(mediaRef, blob, { contentType });
            const mediaUrl = await getDownloadURL(mediaRef);

            await addDoc(collection(getFirebaseDb(), 'chats', chatId, 'messages'), {
                createdAt: serverTimestamp(),
                fileName,
                mediaUrl,
                senderId: currentUser.uid,
                type,
            });
        } catch (error) {
            console.error('Failed to upload chat media:', error);
            if (isStorageUnavailable(error)) {
                showStorageComingSoon();
            } else {
                Alert.alert('Upload failed', 'Could not send this media. Check Storage permissions and try again.');
            }
        } finally {
            setIsUploading(false);
        }
    }, [chatId, currentUser, showStorageComingSoon]);

    const pickMedia = useCallback(async (kind: Exclude<MediaKind, 'audio'>) => {
        setIsAttachmentMenuVisible(false);
        try {
            const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (!permission.granted) {
                Alert.alert('Permission required', 'Allow access to your media library to attach a file.');
                return;
            }

            const result = await ImagePicker.launchImageLibraryAsync({
                allowsEditing: false,
                mediaTypes: kind === 'video' ? ['videos'] : ['images'],
                quality: 1,
            });
            if (result.canceled) {
                return;
            }

            const asset = result.assets[0];
            if (kind === 'gif') {
                const isGif = asset.mimeType?.toLowerCase() === 'image/gif'
                    || asset.fileName?.toLowerCase().endsWith('.gif')
                    || asset.uri.toLowerCase().split('?')[0].endsWith('.gif');
                if (!isGif) {
                    Alert.alert('Choose a GIF', 'Select a .gif file to send it as an animated image.');
                    return;
                }
            }

            const type = kind === 'video' ? 'video' : 'image';
            const extension = kind === 'video' ? 'mp4' : kind === 'gif' ? 'gif' : 'jpg';
            const fileName = asset.fileName || `attachment.${extension}`;
            const contentType = asset.mimeType
                || (kind === 'video' ? 'video/mp4' : kind === 'gif' ? 'image/gif' : 'image/jpeg');
            await uploadAndSendMedia(asset.uri, type, fileName, contentType);
        } catch (error) {
            console.error('Could not choose media:', error);
            Alert.alert('Could not open media library', 'Please try again.');
        }
    }, [uploadAndSendMedia]);

    const startAudioRecording = useCallback(async () => {
        setIsAttachmentMenuVisible(false);
        if (!isFirebaseStorageConfigured()) {
            showStorageComingSoon();
            return;
        }

        try {
            const permission = await requestRecordingPermissionsAsync();
            if (!permission.granted) {
                Alert.alert('Permission required', 'Allow microphone access to record an audio message.');
                return;
            }
            await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
            await recorder.prepareToRecordAsync();
            recorder.record();
            isRecordingRef.current = true;
            setIsRecording(true);
        } catch (error) {
            console.error('Could not start audio recording:', error);
            Alert.alert('Recording unavailable', 'Could not start the audio recording.');
        }
    }, [recorder, showStorageComingSoon, stopRecording]);

    const stopAndSendAudio = useCallback(async () => {
        try {
            const recordedUri = recorder.uri;
            isRecordingRef.current = false;
            await stopRecording();
            setIsRecording(false);
            if (!recordedUri) {
                throw new Error('The audio recording file is unavailable.');
            }
            const isWebRecording = Platform.OS === 'web';
            await uploadAndSendMedia(
                recordedUri,
                'audio',
                `voice-${Date.now()}.${isWebRecording ? 'webm' : 'm4a'}`,
                isWebRecording ? 'audio/webm' : 'audio/mp4',
            );
        } catch (error) {
            isRecordingRef.current = false;
            setIsRecording(false);
            console.error('Could not finish audio recording:', error);
            Alert.alert('Recording failed', 'Could not finish or send the audio recording.');
        }
    }, [recorder.uri, uploadAndSendMedia]);

    const cancelAudioRecording = useCallback(async () => {
        try {
            isRecordingRef.current = false;
            await stopRecording();
        } catch (error) {
            console.error('Could not cancel the recording:', error);
        } finally {
            setIsRecording(false);
        }
    }, []);

    const handleAttachmentPress = useCallback(() => {
        if (!isFirebaseStorageConfigured()) {
            showStorageComingSoon();
            return;
        }
        setIsAttachmentMenuVisible(true);
    }, [showStorageComingSoon]);

    return {
        cancelAudioRecording,
        handleAttachmentPress,
        isAttachmentMenuVisible,
        isRecording,
        isUploading,
        pickMedia,
        recorderDurationSeconds: Math.floor(recorderState.durationMillis / 1000),
        setIsAttachmentMenuVisible,
        startAudioRecording,
        stopAndSendAudio,
    };
}
