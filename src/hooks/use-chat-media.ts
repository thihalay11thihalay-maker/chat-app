import { File, Paths } from 'expo-file-system';
import {
    RecordingPresets,
    requestRecordingPermissionsAsync,
    setAudioModeAsync,
    useAudioRecorder,
    useAudioRecorderState,
} from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { User } from 'firebase/auth';
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';

import { canUploadChatMedia, removeChatMedia, uploadChatMedia } from '@/lib/chat-media-storage';
import { AlbumItem, describeSendFailure, expiryField, MAX_ALBUM_ITEMS } from '@/lib/chat-messages';
import { getFirebaseDb } from '@/lib/firebase';
import { gifContentType, gifExtension, gifFileName, GifResult } from '@/lib/gif-search';
import { getSupabaseUploadErrorMessage, isSupabaseStorageConfigured } from '@/lib/supabase';

export type MediaMessageType = 'image' | 'video' | 'audio' | 'file' | 'location' | 'contact';

type MediaKind = 'album' | 'video' | 'audio' | 'gif' | 'file';

/**
 * One thing the picker handed over, read well enough to upload and to write into an album.
 *
 * Read here rather than at each use because the three callers disagree about what they care about: a single
 * photo only needs a name and a type, an album needs to know which of its items is a clip, and neither
 * should have to re-derive that from a mime type or a file name that may be missing.
 */
type PickedAsset = {
  contentType: string;
  /** Milliseconds, because that is what the picker reports. */
  durationMs?: number;
  fileName: string;
  fileSize?: number;
  type: 'image' | 'video';
  uri: string;
};

/**
 * How many items one album may hold, and the limit the sender is told about.
 *
 * Ten, because the phone's own galleries stop offering a multi-select past about that and because an album
 * taller than a screen is a list rather than an album. The number is also how long the send waits, since an
 * album is written only once every one of its files has landed -- so it is a limit on how long somebody is
 * left watching a spinner as much as on how much arrives.
 *
 * The same limit the message layer keeps, so the bubble can decide how tall a grid to draw without being
 * told a number the composer already had.
 */

/**
 * Whether a picked file is a clip.
 *
 * The mime type first, because the picker usually knows. Then the extension, for the picks where it does
 * not: `mediaTypes` covers both kinds and a device that reports nothing would otherwise file a video into
 * an album as a photograph, which the gallery would then refuse to open.
 */
function isVideoAsset(asset: { fileName?: string | null; mimeType?: string | null; uri: string }) {
  const mimeType = asset.mimeType?.toLowerCase();

  if (mimeType?.startsWith('video/')) {
    return true;
  }

  if (mimeType?.startsWith('image/')) {
    return false;
  }

  return /\.(mp4|mov|m4v|3gp|webm|mkv)$/i.test((asset.fileName || asset.uri).split('?')[0]);
}

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

/**
 * @param onMessageSent Called after a message has been written, with the text the chat list should
 * show as its preview. The room document has to be updated separately from the message itself,
 * because nothing in Firestore links a message to its room's preview, and the inbox reads that
 * preview rather than reading the newest message per room.
 */
export function useChatMedia(
  chatId: string,
  currentUser: User | null,
  onMessageSent?: (preview: string) => void,
  /**
   * How long messages this account sends should survive, in seconds. Passed in rather than read here
   * because it is a setting on the account, and the room screen is the thing that already has it.
   */
  expiresInSeconds = 0,
) {
    const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
    const recorderState = useAudioRecorderState(recorder);
    const [isUploading, setIsUploading] = useState(false);
    const [isAttachmentMenuVisible, setIsAttachmentMenuVisible] = useState(false);
    const [isRecording, setIsRecording] = useState(false);

    /**
     * Writes a message that carries no uploaded file: a place, a contact.
     *
     * Kept separate from the upload path because these two have nothing in common but the write. There
     * is no blob, no bucket and no Storage plan involved in either of them, so a room whose Storage is
     * not configured can still send them.
     */
    const sendPlainMessage = useCallback(async (
        fields: Record<string, string | number>,
        preview: string,
    ) => {
        if (!currentUser) {
            Alert.alert('Login required', 'Please log in first.');
            return false;
        }

        try {
            await addDoc(collection(getFirebaseDb(), 'chats', chatId, 'messages'), {
                ...fields,
                createdAt: serverTimestamp(),
                ...expiryField(expiresInSeconds),
                senderId: currentUser.uid,
            });
            onMessageSent?.(preview);
            return true;
        } catch (error) {
            console.error('Failed to send the message:', error);
            Alert.alert('Could not send', describeSendFailure(error));
            return false;
        }
    }, [chatId, currentUser, expiresInSeconds, onMessageSent]);

    const showStorageComingSoon = useCallback(() => {
        Alert.alert(
            'Coming Soon',
            'Media sharing needs somewhere to store the file. Add EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET, or a Supabase bucket in .env.local, then restart the dev server.',
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
    /**
     * Puts one file in storage and hands back where it landed. No message, no alert, no spinner.
     *
     * Split out from `uploadAndSendMedia` because an album is several uploads followed by one write, and
     * folding that loop into the single-file path is what made the album either a dozen messages or a
     * half-written one. This is deliberately quiet about its failures -- it throws, and each caller
     * decides what that means for the message it was about to write.
     */
    const uploadAsset = useCallback(async (asset: { contentType: string; fileName: string; uri: string }) => {
        if (!currentUser) {
            throw new Error('Login required');
        }

        return uploadChatMedia({
            chatId,
            contentType: asset.contentType,
            fileName: asset.fileName,
            uid: currentUser.uid,
            uri: asset.uri,
        });
    }, [chatId, currentUser]);

    /** Best-effort removal of uploads no message ended up pointing at. Never throws. */
    const discardUploads = useCallback((mediaUrls: string[]) => {
        for (const mediaUrl of mediaUrls) {
            void removeChatMedia(mediaUrl).catch((cleanupError) => {
                console.warn('Could not remove the upload for an unsent message:', cleanupError);
            });
        }
    }, []);

    const uploadAndSendMedia = useCallback(async (
        uri: string,
        type: MediaMessageType,
        fileName: string,
        contentType: string,
        fileSize?: number,
        /** Milliseconds, because that is what the media picker and the recorder both report. */
        durationMs?: number,
    ) => {
        if (!currentUser) {
            Alert.alert('Login required', 'Please log in to send media.');
            return;
        }
        if (!canUploadChatMedia()) {
            showStorageComingSoon();
            return;
        }

        setIsUploading(true);
        try {
            // Written only after the upload lands, because a message pointing at a file that was never
            // stored is a bubble that shows nothing, and the reader has no way to tell that from a photo
            // that failed to load.
            const uploaded = await uploadAsset({ contentType, fileName, uri });

            try {
                await addDoc(collection(getFirebaseDb(), 'chats', chatId, 'messages'), {
                    createdAt: serverTimestamp(),
                    ...expiryField(expiresInSeconds),
                    // Only when something knew it. A photo has no length, and a duration of zero on a
                    // poster is a label claiming the clip is empty.
                    ...(typeof durationMs === 'number' && durationMs > 0
                        ? { durationSeconds: Math.round(durationMs / 1000) }
                        : {}),
                    // Only when the picker knew it. A picked file does not always report a size, and a size
                    // that is not there is a field this record does not have rather than a field that is empty.
                    ...(typeof fileSize === 'number' ? { fileSize } : {}),
                    fileName,
                    mediaUrl: uploaded.mediaUrl,
                    senderId: currentUser.uid,
                    type,
                });
            } catch (error) {
                // The bytes are already stored and nothing points at them, so they are removed rather than
                // left to cost storage for the rest of the bucket's life. Best effort: a failure here is
                // logged, because the reader's problem is the message that was not sent, not this file.
                discardUploads([uploaded.mediaUrl]);

                throw error;
            }

            // The preview matches what the chat list shows for an attachment: a short label rather
            // than a url, which is unreadable as a row and says nothing useful about the message.
            // Audio goes through this path too, from stopAndSendAudio, so it needs its own wording
            // rather than falling into the photo branch and telling the reader they were sent one.
            onMessageSent?.(
                type === 'video'
                    ? 'Sent a video'
                    : type === 'audio'
                        ? 'Sent a voice message'
                        : type === 'file'
                            ? `Sent ${fileName}`
                            : 'Sent a photo',
            );
        } catch (error) {
            console.error('Failed to upload chat media:', error);
            if (isStorageUnavailable(error)) {
                showStorageComingSoon();
            } else if (isSupabaseStorageConfigured()) {
                Alert.alert('Upload failed', getSupabaseUploadErrorMessage(error));
            } else {
                Alert.alert('Upload failed', describeSendFailure(error));
            }
        } finally {
            setIsUploading(false);
        }
    }, [chatId, currentUser, discardUploads, expiresInSeconds, onMessageSent, showStorageComingSoon, uploadAsset]);

    /**
     * Sends a GIF somebody picked out of the search.
     *
     * Fetched into this app's own cache first, for the same reason the document picker copies what it
     * returns: the address the search gave is somebody else's server, and uploading straight from it
     * would mean holding an open connection to that server for as long as the upload takes, on a phone
     * that may have moved between networks in the middle of it. Once the bytes are local the upload is
     * the same upload as any other photo, and the file is named with the extension the service actually
     * served -- which is often not `.gif`.
     *
     * Failures say what happened. A search result that cannot be fetched is a dead end for that one
     * picture, and a reader who tapped it deserves to be told rather than left with nothing happening.
     */
    const sendGif = useCallback(async (gif: GifResult) => {
        setIsAttachmentMenuVisible(false);

        if (!currentUser) {
            Alert.alert('Login required', 'Please log in to send a gif.');
            return;
        }

        if (!canUploadChatMedia()) {
            showStorageComingSoon();
            return;
        }

        setIsUploading(true);

        let localUri = '';

        try {
            // Named after the search result rather than something fixed, so two GIFs sent in a row do
            // not write over each other in the cache while the second upload is still reading the first.
            const destination = new File(Paths.cache, `gif-${gif.id}-${Date.now()}${gifExtension(gif.url)}`);

            const downloaded = await File.downloadFileAsync(gif.url, destination);

            localUri = downloaded.uri;

            await uploadAndSendMedia(
                localUri,
                'image',
                gifFileName(gif),
                gifContentType(gif.url),
            );
        } catch (error) {
            console.error('Could not send the chosen gif:', error);
            Alert.alert(
                'Could not send that gif',
                isStorageUnavailable(error)
                    ? 'This app has nowhere to store the file yet.'
                    : describeSendFailure(error),
            );
        } finally {
            // The cache copy has done its job the moment the upload finishes, and a cache that keeps
            // every GIF anybody ever sent would be a very large cache.
            if (localUri !== '') {
                try {
                    new File(localUri).delete();
                } catch (cleanupError) {
                    console.warn('Could not remove the temporary gif download:', cleanupError);
                }
            }

            setIsUploading(false);
        }
    }, [currentUser, showStorageComingSoon, uploadAndSendMedia]);

    /**
     * Sends several photos and clips as one message.
     *
     * Every file is uploaded first and the message is written once, at the end, which is the whole reason
     * this is not the single-media path called in a loop. Called in a loop, the reader sees the album arrive
     * a picture at a time and a failure part-way through leaves a room full of photographs that were never
     * meant to be sent separately -- there is no group to take back, only ten documents that were each a
     * valid message in their own right.
     *
     * A file that fails does not sink the album. What already uploaded is sent, and what failed is named
     * afterwards, because eight photographs the sender chose is worth more to them than no album and an
     * error, and because the sender is the only one who can decide whether to go back for the other two.
     */
    const sendAlbum = useCallback(async (assets: PickedAsset[]) => {
        if (!currentUser) {
            Alert.alert('Login required', 'Please log in to send photos.');
            return;
        }
        if (!canUploadChatMedia()) {
            showStorageComingSoon();
            return;
        }

        setIsUploading(true);

        const uploadedUrls: string[] = [];
        const items: AlbumItem[] = [];
        let failedCount = 0;
        // The last thing that went wrong, kept only so the message below can tell "this app has nowhere to
        // store files" from "your connection dropped". It is the reason the reason is still known after the
        // loop has swallowed the individual errors.
        let lastUploadError: unknown;
        // Whether the message landed. Read after the try, because the warning about the files that failed
        // is only true of an album that is in the room: if the write itself failed, the files that did
        // upload were deleted and there is nothing to warn anybody about.
        let didWrite = false;

        try {
            for (const [index, asset] of assets.entries()) {
                try {
                    const uploaded = await uploadAsset(asset);

                    uploadedUrls.push(uploaded.mediaUrl);
                    items.push({
                        // Only where the picker knew it: a clip with no length is a poster claiming nothing
                        // about itself, which is better than a label of zero seconds.
                        ...(typeof asset.durationMs === 'number' && asset.durationMs > 0
                            ? { durationSeconds: Math.round(asset.durationMs / 1000) }
                            : {}),
                        ...(typeof asset.fileSize === 'number' ? { fileSize: asset.fileSize } : {}),
                        fileName: asset.fileName,
                        mediaUrl: uploaded.mediaUrl,
                        type: asset.type,
                    });
                } catch (error) {
                    failedCount += 1;
                    lastUploadError = error;
                    console.error(`Could not upload album item ${index + 1}:`, error);
                }
            }

            // Nothing landed, so there is no album to send and no reason to leave a spinner turning over an
            // empty grid. Nothing was stored either -- these uploads all failed -- so there is nothing to
            // clean up, and the way out is a sentence rather than a second attempt at somebody's photographs.
            if (items.length === 0) {
                Alert.alert(
                    'Nothing was sent',
                    isStorageUnavailable(lastUploadError)
                        ? 'This app has nowhere to store the files yet.'
                        : 'None of the files could be uploaded. Please try again.',
                );

                return;
            }

            try {
                await addDoc(collection(getFirebaseDb(), 'chats', chatId, 'messages'), {
                    albumItems: items,
                    createdAt: serverTimestamp(),
                    ...expiryField(expiresInSeconds),
                    senderId: currentUser.uid,
                    type: 'album',
                });
            } catch (error) {
                // Every file is stored and the message that would point at them is not, so they go. This is
                // the case the single-media path already handles, and it is the expensive one: ten files that
                // nobody can reach.
                discardUploads(uploadedUrls);

                throw error;
            }

            didWrite = true;

            const clips = items.filter((item) => item.type === 'video').length;

            onMessageSent?.(
                clips === items.length
                    ? `Sent ${clips} ${clips === 1 ? 'video' : 'videos'}`
                    : clips === 0
                        ? `Sent ${items.length} ${items.length === 1 ? 'photo' : 'photos'}`
                        : `Sent an album of ${items.length}`,
            );
        } catch (error) {
            console.error('Failed to send the album:', error);

            if (isStorageUnavailable(error)) {
                showStorageComingSoon();
            } else if (isSupabaseStorageConfigured()) {
                Alert.alert('Album not sent', getSupabaseUploadErrorMessage(error));
            } else {
                Alert.alert('Album not sent', describeSendFailure(error));
            }
        } finally {
            setIsUploading(false);
        }

        // Said last and separately, because it is a different thing from the send having worked: the album
        // is in the room, and some of what was chosen is not. A prompt raised on top of the success would be
        // read as the failure, and a prompt raised before the send would be a question about a decision the
        // limit has already made.
        if (didWrite && failedCount > 0) {
            Alert.alert(
                'Some files did not send',
                `${failedCount} of the ${assets.length} you chose could not be uploaded. The rest were sent.`,
            );
        }
    }, [chatId, currentUser, discardUploads, expiresInSeconds, onMessageSent, showStorageComingSoon, uploadAsset]);

    const pickMedia = useCallback(async (kind: Exclude<MediaKind, 'audio'>) => {
        setIsAttachmentMenuVisible(false);

        // An album is several photographs and clips chosen together, and it is the same picker with the
        // multiple selection turned on rather than a screen of its own: the phone's own gallery already does
        // the choosing better than anything this app could rebuild. One photo is an album of one, so this
        // replaces the single-photo path rather than sitting beside it.
        if (kind === 'album') {
            try {
                const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

                if (!permission.granted) {
                    Alert.alert('Permission required', 'Allow access to your photos to send them.');
                    return;
                }

                const result = await ImagePicker.launchImageLibraryAsync({
                    allowsEditing: false,
                    allowsMultipleSelection: true,
                    // Both kinds, so a clip can go into the same album as the photographs around it. The
                    // phone's own picker shows them together as well, which is the only reason a reader
                    // would expect to be able to choose that way here.
                    mediaTypes: ['images', 'videos'],
                    quality: 1,
                });

                if (result.canceled || result.assets === undefined || result.assets.length === 0) {
                    return;
                }

                const chosen = result.assets;
                // Cut to the limit, and the count that did not fit is carried out of here rather than
                // forgotten in a slice. Told to the sender afterwards by name, because a photograph that
                // silently did not arrive is indistinguishable from one that arrived and was then deleted.
                const leftBehind = Math.max(0, chosen.length - MAX_ALBUM_ITEMS);
                const assets = chosen
                    .slice(0, MAX_ALBUM_ITEMS)
                    .map((asset, index) => {
                        const isVideo = isVideoAsset(asset);

                        return {
                            contentType: asset.mimeType
                                || (isVideo ? 'video/mp4' : 'image/jpeg'),
                            durationMs: isVideo ? asset.duration ?? undefined : undefined,
                            fileName: asset.fileName
                                || `attachment-${index + 1}.${isVideo ? 'mp4' : 'jpg'}`,
                            fileSize: asset.fileSize ?? undefined,
                            type: isVideo ? 'video' : 'image',
                            uri: asset.uri,
                        } as const;
                    });

                if (leftBehind > 0) {
                    Alert.alert(
                        'Album limit',
                        `An album holds ${MAX_ALBUM_ITEMS}. ${leftBehind} of the ${chosen.length} you chose will not be sent.`,
                    );
                }

                // One thing chosen is one thing sent, not an album of one. An album of one is drawn exactly
                // like a plain photograph but is not one: it has no save button on the bubble, because the
                // button belongs to a message with a single file on it, and a reader would be looking for
                // it. So the single-item case goes down the single-media path, where it gets the same bubble
                // and the same controls as a photograph sent from the Photo option -- which is what the
                // person who tapped Photos once and chose one thing actually meant.
                const only = assets[0];

                if (assets.length === 1) {
                    await uploadAndSendMedia(
                        only.uri,
                        only.type,
                        only.fileName,
                        only.contentType,
                        only.fileSize,
                        only.durationMs,
                    );

                    return;
                }

                await sendAlbum([...assets]);
            } catch (error) {
                console.error('Could not choose photos:', error);
                Alert.alert('Could not open your photos', 'Please try again.');
            }

            return;
        }

        // A file goes through the document picker rather than the media library, which is the only way to
        // reach anything that is not a photo or a video: a pdf, a spreadsheet, an archive, a document
        // somebody sent you. Copied into the app's own cache first, because the picker's uri is a
        // permission grant for this app rather than a path that can be uploaded from later.
        if (kind === 'file') {
            try {
                const result = await DocumentPicker.getDocumentAsync({
                    // Several at a time, because the reason to send a file is often that there are more
                    // than one of whatever it is.
                    multiple: true,
                    // Copied rather than read in place, so the file still exists by the time the upload
                    // runs on a slow connection.
                    copyToCacheDirectory: true,
                });

                if (result.canceled || result.assets === undefined) {
                    return;
                }

                const first = result.assets[0];
                const size = first.size ?? undefined;

                // Written one at a time. The message is the thing that matters and a file that is too
                // large would fail on its own, so sending the rest is better than abandoning the lot.
                for (const asset of result.assets) {
                    await uploadAndSendMedia(
                        asset.uri,
                        'file',
                        asset.name,
                        asset.mimeType || 'application/octet-stream',
                        asset.size ?? size,
                    );
                }
            } catch (error) {
                console.error('Could not choose a file:', error);
                Alert.alert('Could not open files', 'Please try again.');
            }

            return;
        }

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
            await uploadAndSendMedia(asset.uri, type, fileName, contentType, undefined, asset.duration ?? undefined);
        } catch (error) {
            console.error('Could not choose media:', error);
            Alert.alert('Could not open media library', 'Please try again.');
        }
    }, [sendAlbum, uploadAndSendMedia]);

    /**
     * Sends where this phone is right now.
     *
     * Ask first, because the alternative is a pin in the wrong city: a place sent before the permission
     * was granted would be the user's home address rather than where they are. The coordinate is taken at
     * the moment the button is pressed rather than from a cached fix, and the place name is whatever the
     * device could resolve -- a bare pair of coordinates is still a usable message when it cannot.
     */
    const shareLocation = useCallback(async () => {
        setIsAttachmentMenuVisible(false);

        try {
            const { status } = await Location.requestForegroundPermissionsAsync();

            if (status !== 'granted') {
                Alert.alert('Permission required', 'Allow location access to share where you are.');
                return;
            }

            const position = await Location.getCurrentPositionAsync({
                accuracy: Location.Accuracy.Balanced,
            });
            const { latitude, longitude } = position.coords;
            // The coordinates are the message; the place name is only a nicer way to read them. On
            // Android the geocoder behind this is Play Services, so it rejects on a device or
            // emulator that has none, has it disabled, or has no network for it -- and losing the
            // whole pin over a missing street name would be the wrong trade. The coordinates are
            // sent either way, and the reader gets the name when this phone can resolve one.
            let locationName = '';

            try {
                const [place] = await Location.reverseGeocodeAsync({ latitude, longitude });
                locationName = place
                    ? [place.name, place.street, place.city].filter(Boolean).join(', ')
                    : '';
            } catch (error) {
                console.warn('Could not resolve a place name for these coordinates:', error);
            }

            await sendPlainMessage(
                { latitude, locationName, longitude, type: 'location' },
                locationName ? `Shared ${locationName}` : 'Shared a location',
            );
        } catch (error) {
            console.error('Could not share the location:', error);
            Alert.alert(
                'Could not get your location',
                Platform.OS === 'android'
                    ? 'Turn on location services, then try again. Location services may also be unavailable on this device.'
                    : 'Please try again.',
            );
        }
    }, [sendPlainMessage]);

    const startAudioRecording = useCallback(async () => {
        setIsAttachmentMenuVisible(false);
        if (!canUploadChatMedia()) {
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
    }, [recorder, showStorageComingSoon]);

    const stopAndSendAudio = useCallback(async () => {
        try {
            const recordedUri = recorder.uri;
            // Read before the stop, not after: a recorder zeroes its own clock the moment it stops on
            // both platforms, so afterwards there is nothing left to read. This is the same running
            // total the composer has been showing, so the length on the message is the length the
            // sender watched count up rather than a number that appears from nowhere.
            const durationMs = recorderState.durationMillis;
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
                undefined,
                durationMs,
            );
        } catch (error) {
            isRecordingRef.current = false;
            setIsRecording(false);
            console.error('Could not finish audio recording:', error);
            Alert.alert('Recording failed', 'Could not finish or send the audio recording.');
        }
    }, [recorder.uri, recorderState.durationMillis, stopRecording, uploadAndSendMedia]);

    const cancelAudioRecording = useCallback(async () => {
        try {
            isRecordingRef.current = false;
            await stopRecording();
        } catch (error) {
            console.error('Could not cancel the recording:', error);
        } finally {
            setIsRecording(false);
        }
    }, [stopRecording]);

    const handleAttachmentPress = useCallback(() => {
        // Storage is only required by the four options that upload something. A place and a contact are
        // plain messages, so a room whose Storage is not configured is still allowed to send them.
        setIsAttachmentMenuVisible(true);
    }, []);

    return {
        cancelAudioRecording,
        handleAttachmentPress,
        isAttachmentMenuVisible,
        isRecording,
        isUploading,
        pickMedia,
        recorderDurationSeconds: Math.floor(recorderState.durationMillis / 1000),
        sendGif,
        setIsAttachmentMenuVisible,
        shareLocation,
        startAudioRecording,
        stopAndSendAudio,
    };
}
