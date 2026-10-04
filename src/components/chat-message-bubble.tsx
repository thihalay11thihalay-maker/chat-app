import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { createVideoPlayer, VideoThumbnail } from 'expo-video';
import { useEffect, useState } from 'react';
import { Linking, ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import AudioMessage from '@/components/AudioMessage';
import { AlbumItem, ChatMessage, describeMessage, REACTION_EMOJI } from '@/lib/chat-messages';
import { isHttpUrl } from '@/lib/media-cache';
import VideoMessage from '@/components/VideoMessage';

// The shape lives with the data rather than here, so the screens that read messages and the component
// that draws them cannot drift apart. Re-exported because every screen already imports it from here.
export type { ChatMessage };

/** The emoji row drawn under a message, and the one this account chose. */
export type ReactionTally = {
    count: number;
    emoji: string;
    mine: boolean;
};

export function getMessageTime(value: unknown) {
    const stamp = value as { toDate?: () => Date } | Date | undefined;
    const date = stamp instanceof Date ? stamp : stamp?.toDate?.();

    return date?.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) ?? '';
}

function hasBeenEdited(editedAt: unknown) {
    if (!editedAt) {
        return false;
    }

    const stamp = editedAt as { toDate?: () => Date } | Date;
    const date = stamp instanceof Date ? stamp : stamp.toDate?.();

    return date instanceof Date && date.getTime() > 0;
}

/**
 * Handing a URL to the operating system, from a string anybody in the room wrote.
 *
 * `Linking.openURL` does not fetch anything itself: it asks the OS to find a handler for the scheme and
 * launch it. That is fine for a web address and not fine for anything else, because a message document is
 * attacker-controlled -- the create rule validates no fields, so any member can post a file message whose
 * `mediaUrl` is `intent://...`, and on Android an intent URL can name an exported component rather than a
 * page. A tap on the message is all it takes.
 *
 * So the scheme is checked here, at the last point before the OS sees it, rather than trusting that the
 * value arrived through the upload path. `isHttpUrl` is the same check the media cache uses, so a message
 * can never be renderable as a photo but not openable, or the other way round. Refusing silently is
 * deliberate: there is nothing useful to tell the recipient about a message the sender should not have been
 * able to write.
 */
function openExternalUrl(url: unknown) {
    if (!isHttpUrl(url)) {
        return;
    }

    void Linking.openURL(url);
}

/** Opens a place in the maps app, which is a URL scheme rather than anything Firestore needs. */
function openLocation(latitude?: number, longitude?: number) {
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        return;
    }

    void Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`);
}

function formatFileSize(bytes?: number) {
    if (typeof bytes !== 'number' || bytes <= 0) {
        return '';
    }

    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type MessageBubbleProps = {
    /**
     * Where this photo sits in its album, when it is part of one.
     *
     * Only for an album written the old way, one document per photograph. An album sent now is one
     * message and draws itself from `albumItems`, and needs nothing from the list around it -- which is
     * what stops a group being cut in two by somebody else's message landing in the middle of it.
     */
    album?: {
        count: number;
        position: 'first' | 'last' | 'middle' | 'only';
    };
    /**
     * The copy of this message's media inside the app's own storage, once there is one.
     *
     * Drawn in place of the remote address when it is there, which is what makes a conversation open the
     * second time without a connection and the first time without waiting.
     */
    cachedUrl?: string;
    /** Whether this account has already put a heart on the message, which fills the heart on the bubble. */
    hasMyHeart?: boolean;
    isMine: boolean;
    message: ChatMessage;
    /** Long press, used by the conversation screen to offer everything that can be done to a message. */
    onLongPress?: (message: ChatMessage) => void;
    /**
     * Holding the heart offers the whole set rather than only the heart, because somebody who wants to
     * say something else should not have to press the exact emoji they wanted by accident first.
     */
    onLongPressHeart?: (message: ChatMessage) => void;
    /** Holding a reaction pill says who else chose it, which a count on its own cannot. */
    onLongPressReaction?: (message: ChatMessage, emoji: string) => void;
    /** Tapping the heart puts this account's heart on the message, or takes it back off. */
    onPressHeart?: (message: ChatMessage) => void;
    /** Tapping a reaction takes this account's own back off, so the row is a toggle and not a button. */
    onPressReaction?: (message: ChatMessage, emoji: string) => void;
    /** Tapping one of the six on the strip this bubble is showing. */
    onPressEmoji?: (message: ChatMessage, emoji: string) => void;
    /**
     * Tapping a photograph, a clip or a tile in an album opens the album itself rather than the file.
     *
     * The message's own id travels with it because the viewer names the cached copies of these files after
     * it: without it, two albums in the same room would write over each other's downloads.
     *
     * The conversation screen owns this because the viewer is a modal above the whole conversation rather
     * than something inside a bubble: it has to sit over the header, the composer and every sheet at once.
     */
    onOpenMedia?: (items: AlbumItem[], startIndex: number, messageId: string) => void;
    /**
     * The button that puts a photo or a clip in the phone's own gallery. Only drawn for media, and only
     * when the screen has somewhere to send it.
     */
    onSave?: (message: ChatMessage) => void;
    /** Whether this media is already in the gallery, which turns the button into a check. */
    saveState?: 'idle' | 'saving' | 'saved';
    /** Whether to draw the strip of six reactions above this bubble, which is the long-press answer to
        reacting. Only the message that was pressed gets one. */
    showReactionStrip?: boolean;
    /**
     * Draw this message as a line rather than as the thing itself, for the screens that list messages --
     * search results and the pinned list.
     *
     * Both of those wrap every row in their own press that opens the message in the conversation, and an
     * album drawn properly is up to ten thumbnails: ten of those per row makes a list nobody can scan, and
     * a pressable tile inside their pressable would swallow the tap and go nowhere. An album in a list is
     * therefore named rather than drawn, and the row's own press does what the tile would have done.
     */
    compact?: boolean;
    /** Draws the sender's name above the bubble. Only the conversation screen knows it, because only it
        has worked out whether this room has one person in it or several. */
    showSenderName?: boolean;
    senderName?: string;
    reactions?: ReactionTally[];
};

/**
 * How an album is laid out, given how many things are in it.
 *
 * Two and four are the shapes a reader recognises as a group -- a row of two, a square of four -- and both
 * are drawn at full tile size rather than squeezed into three columns, because two photographs at
 * two-thirds width are two photographs nobody can recognise. Everything else is three across, which is as
 * many as can be told apart at this size and keeps the tallest album to a screen and a half.
 */
function albumLayout(count: number) {
    if (count <= 1) {
        return { columns: 1, rows: 1 };
    }

    if (count === 2) {
        return { columns: 2, rows: 1 };
    }

    if (count === 4) {
        return { columns: 2, rows: 2 };
    }

    return { columns: 3, rows: Math.ceil(count / 3) };
}

/** The width and height of one tile, from the shape the album is drawn in. */
const ALBUM_WIDTH = 220;
const ALBUM_GAP = 2;

type AlbumGridProps = {
    items: AlbumItem[];
    onLongPress?: () => void;
    onPressTile: (index: number) => void;
};

/**
 * The photographs and clips of one album, as one picture rather than as a run of messages.
 *
 * An album of one is not something this build sends -- the composer sends a single choice down the plain
 * photograph path instead, so it arrives with the save button a reader expects -- but the shape is still
 * handled here, because a message written by another build or restored from somewhere else can hold one,
 * and a grid that drew a lone photograph at tile size would look broken rather than like anything.
 */
function AlbumGrid({ items, onLongPress, onPressTile }: AlbumGridProps) {
    const { columns, rows } = albumLayout(items.length);
    // The gap is on the container rather than a margin on each tile. A margin is what a tile on the end of a
    // row must not have, which cannot be known without counting rows, and one that is left on adds to the
    // row's width -- three tiles and two margins in a 220 box came to 222, and the third wrapped to the next
    // line. The gap is only ever drawn between two tiles that are actually adjacent.
    const tile = (ALBUM_WIDTH - ALBUM_GAP * (columns - 1)) / columns;

    // The size a lone photograph has always been, so that an album of one from an older build still looks
    // like the picture it is rather than like a square stretched out of shape.
    const height = columns === 1 ? 210 : rows * tile + ALBUM_GAP * (rows - 1);

    return (
        <View style={[styles.album, { gap: ALBUM_GAP, height, width: ALBUM_WIDTH }]}>
            {items.map((item, itemIndex) => (
                <Pressable
                    accessibilityLabel={item.type === 'video' ? 'Play video' : 'Open photo'}
                    accessibilityRole="button"
                    key={`${item.mediaUrl}-${itemIndex}`}
                    onLongPress={onLongPress}
                    onPress={() => onPressTile(itemIndex)}
                    style={{ height: tile, width: tile }}
                >
                    {item.type === 'video' ? (
                        <VideoTile item={item} />
                    ) : (
                        <Image
                            autoplay
                            cachePolicy="memory-disk"
                            contentFit="cover"
                            source={{ uri: item.mediaUrl }}
                            style={styles.albumTile}
                            transition={150}
                        />
                    )}
                </Pressable>
            ))}
        </View>
    );
}

/**
 * A clip inside an album: the clip's own first frame with a play badge over it.
 *
 * The same frame the standalone video message draws, for the same reason -- a grey box with a triangle on
 * it is a placeholder, and a conversation of them reads as broken rather than as unwatched. No duration
 * here either: the label belongs on the tile only when it fits, and at three across it does not.
 */
function VideoTile({ item }: { item: AlbumItem }) {
    const [poster, setPoster] = useState<VideoThumbnail | null>(null);

    useEffect(() => {
        // Latched rather than cancelled: the grabber is released by `takeThumbnail` itself, and all that is
        // left to do is not hand a picture to a component that has since been given a different clip.
        let isCurrent = true;

        void takeVideoThumbnail(item.mediaUrl, (thumbnail) => {
            if (isCurrent) {
                setPoster(thumbnail);
            }
        });

        return () => {
            isCurrent = false;
        };
    }, [item.mediaUrl]);

    return (
        <View style={styles.albumTile}>
            {poster ? (
                <Image contentFit="cover" source={poster} style={StyleSheet.absoluteFill} transition={120} />
            ) : null}

            <View pointerEvents="none" style={styles.albumPlayBadge}>
                <Ionicons color="#FFFFFF" name="play" size={16} />
            </View>
        </View>
    );
}

/**
 * One frame of one clip, taken with a player that is released immediately.
 *
 * A player per clip is the only way to ask a video for a picture, and an album can hold ten of them, so the
 * grabber has to be given up as soon as it has produced its frame rather than living for as long as the
 * conversation is open.
 */
async function takeVideoThumbnail(videoUrl: string, onReady: (thumbnail: VideoThumbnail) => void) {
    const grabber = createVideoPlayer({ uri: videoUrl });

    try {
        const [thumbnail] = await grabber.generateThumbnailsAsync([0], { maxWidth: 480 });

        if (thumbnail) {
            onReady(thumbnail);
        }
    } catch (error) {
        // Not worth an alert: the poster is a convenience, and the clip itself is what the reader came for.
        console.warn('Could not take a thumbnail for an album video:', error);
    } finally {
        grabber.release();
    }
}

export function MessageBubble({
    album,
    cachedUrl,
    compact = false,
    hasMyHeart,
    isMine,
    message,
    onLongPress,
    onLongPressHeart,
    onLongPressReaction,
    onPressHeart,
    onPressReaction,
    onPressEmoji,
    onOpenMedia,
    onSave,
    saveState = 'idle',
    reactions,
    senderName,
    showReactionStrip,
    showSenderName,
}: MessageBubbleProps) {
    // Offered for every message rather than only your own: the screen decides who may delete one, and
    // a control that appears and disappears per row is a worse answer than an action that then says
    // it cannot be done.
    const handleLongPress = onLongPress ? () => onLongPress(message) : undefined;
    const who = senderName || message.senderName || '';
    const bubbleStyle = isMine ? styles.ownMessageBubble : styles.otherMessageBubble;
    const textStyle = isMine ? styles.ownMessageText : styles.messageText;
    // The local copy once there is one, and the address on the server until then. Read once here rather
    // than at each use, so the picture, the clip and the voice note in one message cannot each decide
    // differently about whether the file is here.
    const mediaUrl = cachedUrl ?? message.mediaUrl;
    // Only photographs and clips get the button. A voice note is saved by holding it and tapping Save, and
    // a document is not something the gallery has any business holding.
    const canSaveToPhone = onSave
      && (message.type === 'image' || message.type === 'video')
      && typeof message.mediaUrl === 'string'
      && message.mediaUrl !== '';

    const body = () => {
        // An album is one message holding every photograph and clip in it, and it draws itself rather than
        // looking at the messages either side: this is the case that a group drawn from the list cannot be
        // trusted to get right, because the list is paginated and other people are posting into it.
        if (message.type === 'album' && message.albumItems?.length && !compact) {
            const items = message.albumItems;

            return (
                <AlbumGrid
                    items={items}
                    onLongPress={handleLongPress}
                    onPressTile={(itemIndex) => onOpenMedia?.(items, itemIndex, message.id)}
                />
            );
        }

        if (message.type === 'image' && mediaUrl) {
            // An album is drawn as one shape: the photos in the middle lose the rounded corners so the
            // group reads as a single picture rather than as several pictures that happened to arrive
            // together, and the last one carries how many there are, because the reader cannot see the
            // ones below the fold without opening the conversation further.
            const corners = album
                ? {
                    borderBottomLeftRadius: album.position === 'last' ? 9 : 0,
                    borderBottomRightRadius: album.position === 'last' ? 9 : 0,
                    borderTopLeftRadius: album.position === 'first' ? 9 : 0,
                    borderTopRightRadius: album.position === 'first' ? 9 : 0,
                }
                : {};

            return (
                // The long press is repeated here rather than left to the bubble around it: a pressable
                // inside another pressable takes the touch for itself, so the outer one never sees the
                // hold and a photo would be the one message type with no way to react to it.
                <Pressable
                    onLongPress={handleLongPress}
                    onPress={() => onOpenMedia
                        ? onOpenMedia(
                            [{ mediaUrl, type: message.type === 'video' ? 'video' : 'image' }],
                            0,
                            message.id,
                        )
                        : openExternalUrl(mediaUrl)}
                >
                    <View>
                        {/*
                          expo-image rather than React Native's Image, because it decodes an animated
                          image: a GIF sent as a message used to arrive as its first frame on Android and
                          sit there looking like a photograph of something. `contentFit="cover"` is what
                          React Native's Image did by default here, and `autoplay` starts an animated
                          image on its own, which is the entire reason a GIF was sent.

                          The disk cache is asked for explicitly rather than left to the default, because
                          the default is memory and this is the one place where the picture has to be
                          there tomorrow as well as today.
                        */}
                        <Image
                            autoplay
                            cachePolicy="memory-disk"
                            contentFit="cover"
                            source={{ uri: mediaUrl }}
                            style={[styles.messageImage, corners]}
                            transition={150}
                        />

                        {album && album.position === 'last' && album.count > 1 ? (
                            <View pointerEvents="none" style={styles.albumCount}>
                                <Text style={styles.albumCountText}>+{album.count - 1}</Text>
                            </View>
                        ) : null}
                    </View>
                </Pressable>
            );
        }

        if (message.type === 'video' && mediaUrl) {
            // Played in the app rather than handed to the browser: a video message that opens a
            // download dialog with a file name in it is not a video message.
            return (
                // Keyed by the message so that forwarding the same clip into a second conversation, where
                // the ids differ, is the one case that remounts the poster and re-takes its frame.
                <VideoMessage
                    key={`${message.id}-${mediaUrl}`}
                    // Milliseconds from the picker, seconds everywhere else.
                    durationSeconds={
                        typeof message.durationSeconds === 'number'
                            ? message.durationSeconds > 1000
                                ? Math.round(message.durationSeconds / 1000)
                                : message.durationSeconds
                            : undefined
                    }
                    onLongPress={handleLongPress}
                    videoUrl={mediaUrl}
                />
            );
        }

        if (message.type === 'audio' && mediaUrl) {
            // Played in the bubble rather than opened in a browser: a voice note that arrives as a
            // download, or as a page that cannot play audio at all, means leaving the conversation to
            // hear what was said in it. Keyed like the video, because forwarding the same recording
            // into a second conversation is the one case that reuses a row for a different file.
            return (
                <AudioMessage
                    key={`${message.id}-${mediaUrl}`}
                    audioUrl={mediaUrl}
                    durationSeconds={message.durationSeconds}
                    isMine={isMine}
                    messageId={message.id}
                    onLongPress={handleLongPress}
                />
            );
        }

        if (message.type === 'file') {
            return (
                <Pressable
                    onLongPress={handleLongPress}
                    onPress={() => message.mediaUrl && openExternalUrl(message.mediaUrl)}
                    style={[styles.mediaLink, !isMine && styles.otherMediaLink]}
                >
                    <Ionicons color={isMine ? '#FFFFFF' : '#363A42'} name="document-text" size={20} />
                    <View style={styles.mediaCopy}>
                        <Text numberOfLines={1} style={[styles.mediaLinkText, !isMine && styles.otherMediaLinkText]}>
                            {message.fileName || 'File'}
                        </Text>
                        {formatFileSize(message.fileSize) ? (
                            <Text style={[styles.mediaMeta, isMine && styles.ownMessageMeta]}>{formatFileSize(message.fileSize)}</Text>
                        ) : null}
                    </View>
                </Pressable>
            );
        }

        if (message.type === 'location') {
            return (
                <Pressable
                    onLongPress={handleLongPress}
                    onPress={() => openLocation(message.latitude, message.longitude)}
                    style={[styles.mediaLink, !isMine && styles.otherMediaLink]}
                >
                    <Ionicons color={isMine ? '#FFFFFF' : '#363A42'} name="location" size={20} />
                    <View style={styles.mediaCopy}>
                        <Text numberOfLines={2} style={[styles.mediaLinkText, !isMine && styles.otherMediaLinkText]}>
                            {message.locationName || 'Shared location'}
                        </Text>
                        {typeof message.latitude === 'number' && typeof message.longitude === 'number' ? (
                            <Text style={[styles.mediaMeta, isMine && styles.ownMessageMeta]}>
                                {message.latitude.toFixed(4)}, {message.longitude.toFixed(4)}
                            </Text>
                        ) : null}
                    </View>
                </Pressable>
            );
        }

        if (message.type === 'contact') {
            return (
                <View style={[styles.contactCard, !isMine && styles.otherContactCard]}>
                    {message.contactPhotoUrl ? (
                        <Image
                            contentFit="cover"
                            source={{ uri: message.contactPhotoUrl }}
                            style={styles.contactPhoto}
                            transition={120}
                        />
                    ) : (
                        <View style={[styles.contactPhoto, styles.contactPhotoFallback]}>
                            <Ionicons color="#8D929C" name="person" size={22} />
                        </View>
                    )}
                    <View style={styles.mediaCopy}>
                        <Text numberOfLines={1} style={[styles.contactName, isMine && styles.ownMessageText]}>
                            {message.contactName || 'Contact'}
                        </Text>
                        {message.contactPhone ? (
                            <Text numberOfLines={1} style={[styles.mediaMeta, isMine && styles.ownMessageMeta]}>
                                {message.contactPhone}
                            </Text>
                        ) : null}
                    </View>
                </View>
            );
        }

        if (message.type !== 'text') {
            return <Text style={textStyle}>{describeMessage(message)}</Text>;
        }

        return <Text style={textStyle}>{message.text}</Text>;
    };

    return (
        <View style={[styles.messageRow, isMine && styles.ownMessageRow]}>
            {showSenderName && !isMine && who !== '' ? (
                <Text style={styles.senderName}>{who}</Text>
            ) : null}

            {/*
              A wrapper that hugs the bubble rather than the row, because two things are positioned against
              the bubble's edges: the heart on its corner, and the strip of reactions above it. Positioned
              against the row they would sit at the corners of the screen, which for a short message is a
              long way from the thing they belong to.
            */}
            <View style={[styles.bubbleWrap, isMine && styles.ownBubbleWrap]}>
                {/*
                  The six reactions, over the message that was pressed rather than in a sheet at the bottom
                  of the screen. Reacting is the thing people reach for the moment they read something, and
                  the message is what they are looking at: an answer that appears next to the message is
                  one tap from the eye, where a sheet two hundred millimetres away is a reach and a hunt.

                  Above the bubble, over whatever row is above it, and drawn over it: it is not part of the
                  conversation and it must not push the rows around while it is up. The bubble's own
                  pressable is not its parent, so a press on one of these six cannot be mistaken for a long
                  press on the message underneath.
                */}
                {showReactionStrip && onPressEmoji ? (
                    <View style={[styles.reactionStrip, isMine && styles.ownReactionStrip]}>
                        {REACTION_EMOJI.map((emoji) => (
                            <Pressable
                                accessibilityLabel={`React ${emoji}`}
                                accessibilityRole="button"
                                hitSlop={4}
                                key={emoji}
                                onPress={() => onPressEmoji(message, emoji)}
                                style={({ pressed }) => [styles.reactionStripButton, pressed && styles.reactionStripPressed]}
                            >
                                <Text style={styles.reactionStripGlyph}>{emoji}</Text>
                            </Pressable>
                        ))}
                    </View>
                ) : null}

            <Pressable
                delayLongPress={400}
                onLongPress={handleLongPress}
                style={[styles.messageBubble, bubbleStyle, isMine && styles.ownMessageRow]}
            >
                {message.forwardedFrom?.roomName ? (
                    // Said in the bubble rather than only in the action bar, because a message that
                    // arrived from somewhere else reads as this room's own if it is passed on without a
                    // word about where it came from.
                    <Text style={[styles.forwardedFrom, isMine && styles.ownMessageMeta]}>
                        ↪ Forwarded from {message.forwardedFrom.roomName}
                    </Text>
                ) : null}

                {message.replyTo ? (
                    <View style={[styles.replyQuote, isMine && styles.ownReplyQuote]}>
                        <Text style={[styles.replyName, isMine && styles.ownMessageText]} numberOfLines={1}>
                            {message.replyTo.senderName}
                        </Text>
                        <Text style={[styles.replyText, isMine && styles.ownMessageMeta]} numberOfLines={2}>
                            {message.replyTo.text}
                        </Text>
                    </View>
                ) : null}

                {body()}

                <View style={styles.footer}>
                    {hasBeenEdited(message.editedAt) ? (
                        <Text style={[styles.edited, isMine && styles.ownMessageMeta]}>edited</Text>
                    ) : null}
                    {message.pinned ? (
                        <Ionicons
                            color={isMine ? '#B9BBC0' : '#8D929C'}
                            name="bookmark"
                            size={11}
                            style={styles.pinMark}
                        />
                    ) : null}
                    <Text style={[styles.messageTime, isMine && styles.ownMessageTime]}>{getMessageTime(message.createdAt)}</Text>
                </View>

                {/*
                  The heart on the corner of the bubble, on every kind of message: words, a photograph,
                  a clip, a voice note. It is drawn rather than left to the long-press menu because a
                  reaction is the one thing people reach for without being asked, and a message you have
                  to hold to say "I like this" is a message most people never react to at all.

                  Inside the bubble's own pressable rather than beside it, because a pressable beside it
                  would be a second target for the same gesture and the two would race: the row's long
                  press would win on some devices and the heart's on others. Inside, the heart takes its
                  own taps and the bubble keeps its own long press, which is how they behave everywhere
                  else in this app.
                */}
                {onPressHeart ? (
                    <Pressable
                        accessibilityLabel={hasMyHeart ? 'Remove your reaction' : 'React with a heart'}
                        accessibilityRole="button"
                        delayLongPress={350}
                        hitSlop={6}
                        onLongPress={onLongPressHeart ? () => onLongPressHeart(message) : undefined}
                        onPress={() => onPressHeart(message)}
                        style={({ pressed }) => [styles.heart, pressed && styles.heartPressed]}
                    >
                        <Ionicons
                            // Outline until this account has reacted, filled once it has: the shape says
                            // whether the heart is yours rather than making the reader count reactions.
                            color={hasMyHeart ? '#FE2C55' : '#A2A7B0'}
                            name={hasMyHeart ? 'heart' : 'heart-outline'}
                            size={13}
                        />
                    </Pressable>
                ) : null}
            </Pressable>

                {/*
                  The save button, on a photograph or a clip: the same two fingers' worth of screen that
                  every other messenger puts one there, in the corner where a thumb is already going.

                  Three states rather than one, because the difference between "press it" and "it is
                  happening" and "it is done" is the whole of what a reader is owed here. It stays a check
                  afterwards rather than disappearing, so a reader who scrolls back can see the file is
                  already on the phone -- and pressing it again saves a second copy, which is what a
                  deliberate second press should do.

                  Inside the bubble's own pressable, so a press on it cannot reach the hold that opens the
                  menu, and above the picture by z-index so the photograph underneath still draws.
                */}
                {canSaveToPhone ? (
                    <Pressable
                        accessibilityLabel={saveState === 'saved' ? 'Saved to your gallery' : 'Save to your gallery'}
                        accessibilityRole="button"
                        disabled={saveState === 'saving'}
                        onPress={() => onSave(message)}
                        style={({ pressed }) => [styles.saveButton, pressed && styles.saveButtonPressed]}
                    >
                        {saveState === 'saving' ? (
                            <ActivityIndicator color="#FFFFFF" size="small" />
                        ) : (
                            <Ionicons
                                color="#FFFFFF"
                                name={saveState === 'saved' ? 'checkmark' : 'download'}
                                size={14}
                            />
                        )}
                    </Pressable>
                ) : null}
            </View>

            {reactions && reactions.length > 0 ? (
                <View style={[styles.reactionRow, isMine && styles.ownReactionRow]}>
                    {reactions.map((reaction) => (
                        <Pressable
                            accessibilityLabel={`${reaction.emoji} ${reaction.count}`}
                            accessibilityRole="button"
                            delayLongPress={350}
                            key={reaction.emoji}
                            onLongPress={onLongPressReaction
                                ? () => onLongPressReaction(message, reaction.emoji)
                                : undefined}
                            onPress={() => onPressReaction?.(message, reaction.emoji)}
                            style={[styles.reactionPill, reaction.mine && styles.reactionPillMine]}
                        >
                            <Text style={styles.reactionEmoji}>{reaction.emoji}</Text>
                            <Text style={[styles.reactionCount, reaction.mine && styles.reactionCountMine]}>
                                {reaction.count}
                            </Text>
                        </Pressable>
                    ))}
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    messageRow: {
        alignItems: 'flex-start',
        marginBottom: 10,
        maxWidth: '100%',
        paddingHorizontal: 2,
    },
    ownMessageRow: {
        alignItems: 'flex-end',
    },
    // Shrinks to the bubble rather than filling the row, so what is positioned against it -- the heart and
    // the strip of reactions -- lands on the bubble's own edges.
    bubbleWrap: {
        alignSelf: 'flex-start',
        position: 'relative',
    },
    ownBubbleWrap: {
        alignSelf: 'flex-end',
    },
    // Drawn over the row above rather than under it: it is a temporary answer, and a reader who has just
    // long-pressed a message in the middle of a conversation must be able to see what came up.
    reactionStrip: {
        alignItems: 'center',
        alignSelf: 'flex-start',
        backgroundColor: '#FFFFFF',
        borderColor: '#E7E2DA',
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        bottom: '100%',
        // Out of the flow, so putting the strip up does not push the conversation down by the height of the
        // strip and move the very message it is about.
        position: 'absolute',
        elevation: 6,
        flexDirection: 'row',
        marginBottom: 6,
        paddingHorizontal: 4,
        paddingVertical: 3,
        shadowColor: '#10131A',
        shadowOffset: { height: 2, width: 0 },
        shadowOpacity: 0.18,
        shadowRadius: 6,
        zIndex: 3,
    },
    // Flipped for this account's own messages so the strip sits above the right-hand edge of the bubble
    // rather than reaching off the left of a bubble that is already against the right edge.
    ownReactionStrip: {
        alignSelf: 'flex-end',
    },
    reactionStripButton: {
        alignItems: 'center',
        borderRadius: 999,
        height: 36,
        justifyContent: 'center',
        width: 36,
    },
    reactionStripPressed: {
        backgroundColor: '#F1EDE6',
    },
    reactionStripGlyph: {
        fontSize: 22,
    },
    senderName: {
        color: '#8D929C',
        fontSize: 11,
        fontWeight: '700',
        marginBottom: 3,
        marginLeft: 14,
    },
    messageBubble: {
        borderRadius: 16,
        maxWidth: '82%',
        minWidth: 80,
        paddingHorizontal: 13,
        paddingTop: 10,
        // The heart is positioned against the bubble rather than the row, which is what keeps it on the
        // corner of the bubble instead of on the corner of the screen.
        position: 'relative',
    },
    ownMessageBubble: {
        backgroundColor: '#20232A',
        borderBottomRightRadius: 5,
    },
    otherMessageBubble: {
        backgroundColor: '#FFFFFF',
        borderBottomLeftRadius: 5,
    },
    forwardedFrom: {
        color: '#8D929C',
        fontSize: 11,
        fontWeight: '600',
        marginBottom: 5,
    },
    replyQuote: {
        backgroundColor: '#F1EDE6',
        borderLeftColor: '#2FBF71',
        borderLeftWidth: 3,
        borderRadius: 6,
        marginBottom: 6,
        paddingHorizontal: 8,
        paddingVertical: 5,
    },
    ownReplyQuote: {
        backgroundColor: '#343841',
    },
    replyName: {
        color: '#2FBF71',
        fontSize: 12,
        fontWeight: '700',
    },
    replyText: {
        color: '#6C7079',
        fontSize: 12,
    },
    messageText: {
        color: '#363A42',
        fontSize: 15,
        lineHeight: 21,
    },
    ownMessageText: {
        color: '#FFFFFF',
    },
    footer: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 5,
        justifyContent: 'flex-end',
        marginTop: 4,
    },
    edited: {
        color: '#8D929C',
        fontSize: 10,
        fontStyle: 'italic',
    },
    ownMessageMeta: {
        color: '#B9BBC0',
    },
    pinMark: {
        marginTop: 1,
    },
    messageTime: {
        color: '#8D929C',
        fontSize: 10,
    },
    ownMessageTime: {
        color: '#B9BBC0',
    },
messageImage: {
    borderRadius: 9,
    height: 210,
    width: 220,
  },
  albumCount: {
    alignItems: 'center',
    backgroundColor: 'rgba(20, 22, 28, 0.55)',
    borderTopLeftRadius: 9,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    position: 'absolute',
    right: 0,
  },
  albumCountText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  // The tiles wrap on their own rather than in a grid component: the shape is fixed for a whole album, so
  // there is nothing here a flexbox wrap cannot do, and no second layout engine to keep in step.
  album: {
    borderRadius: 9,
    flexDirection: 'row',
    flexWrap: 'wrap',
    overflow: 'hidden',
  },
  albumTile: {
    backgroundColor: '#2A2E37',
    height: '100%',
    width: '100%',
  },
  albumPlayBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(20, 22, 28, 0.6)',
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    left: '50%',
    marginLeft: -18,
    marginTop: -18,
    position: 'absolute',
    top: '50%',
    width: 36,
  },
    mediaLink: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 9,
        minHeight: 32,
    },
    otherMediaLink: {
        backgroundColor: '#F7F4EF',
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 6,
    },
    mediaCopy: {
        flex: 1,
        minWidth: 0,
    },
    mediaLinkText: {
        color: '#FFFFFF',
        flexShrink: 1,
        fontSize: 13,
        fontWeight: '700',
    },
    otherMediaLinkText: {
        color: '#363A42',
    },
    mediaMeta: {
        color: '#8D929C',
        fontSize: 11,
        marginTop: 1,
    },
    contactCard: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 9,
        minHeight: 32,
    },
    otherContactCard: {
        backgroundColor: '#F7F4EF',
        borderRadius: 8,
        padding: 8,
    },
    contactPhoto: {
        borderRadius: 20,
        height: 40,
        width: 40,
    },
    contactPhotoFallback: {
        alignItems: 'center',
        backgroundColor: '#E7E2DA',
        justifyContent: 'center',
    },
    contactName: {
        color: '#363A42',
        fontSize: 14,
        fontWeight: '700',
    },
    reactionRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 5,
        marginTop: -6,
        paddingLeft: 6,
        paddingRight: 6,
    },
    ownReactionRow: {
        justifyContent: 'flex-end',
        paddingLeft: 0,
        paddingRight: 10,
    },
    reactionPill: {
        alignItems: 'center',
        backgroundColor: '#FFFFFF',
        borderColor: '#E7E2DA',
        borderRadius: 12,
        borderWidth: 1,
        flexDirection: 'row',
        gap: 3,
        paddingHorizontal: 7,
        paddingVertical: 3,
    },
    reactionPillMine: {
        backgroundColor: '#E8F7EE',
        borderColor: '#2FBF71',
    },
    reactionEmoji: {
        fontSize: 12,
    },
    reactionCount: {
        color: '#6C7079',
        fontSize: 11,
        fontWeight: '700',
    },
    reactionCountMine: {
        color: '#1F9D5B',
    },
    // Half outside the bubble, in the corner nobody reads text into. Ringed in the row's own background so
    // it reads as sitting on the bubble rather than behind it, which is the only cue that says the heart
    // belongs to the message and not to the row.
    heart: {
        alignItems: 'center',
        backgroundColor: '#FFFFFF',
        borderColor: '#E7E2DA',
        borderRadius: 12,
        borderWidth: 1,
        height: 24,
        justifyContent: 'center',
        position: 'absolute',
        right: -9,
        top: -9,
        width: 24,
        zIndex: 2,
    },
    heartPressed: {
        opacity: 0.7,
    },
    // Inside the picture's own corner, top right, where the album count is not: that one is bottom right
    // and the heart is outside the bubble entirely, so this is the one place on a bubble that is free.
    saveButton: {
        alignItems: 'center',
        backgroundColor: 'rgba(20, 22, 28, 0.55)',
        borderRadius: 15,
        height: 30,
        justifyContent: 'center',
        position: 'absolute',
        right: 10,
        top: 10,
        width: 30,
        zIndex: 3,
    },
    saveButtonPressed: {
        backgroundColor: 'rgba(20, 22, 28, 0.75)',
    },
});