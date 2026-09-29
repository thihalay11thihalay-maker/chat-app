import { SymbolView } from 'expo-symbols';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

export type ChatMessage = {
    id: string;
    senderId: string;
    type: 'text' | 'image' | 'video' | 'audio';
    text?: string;
    mediaUrl?: string;
    fileName?: string;
    createdAt?: { toDate?: () => Date } | Date;
};

export function getMessageTime(value: ChatMessage['createdAt']) {
    const date = value instanceof Date ? value : value?.toDate?.();
    return date?.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) ?? '';
}

type MessageBubbleProps = {
    isMine: boolean;
    message: ChatMessage;
};

export function MessageBubble({ isMine, message }: MessageBubbleProps) {
    return (
        <View style={[styles.messageRow, isMine && styles.ownMessageRow]}>
            <View style={[styles.messageBubble, isMine ? styles.ownMessageBubble : styles.otherMessageBubble]}>
                {message.type === 'image' && message.mediaUrl ? (
                    <Pressable onPress={() => void Linking.openURL(message.mediaUrl!)}>
                        <Image source={{ uri: message.mediaUrl }} style={styles.messageImage} />
                    </Pressable>
                ) : message.type === 'video' && message.mediaUrl ? (
                    <Pressable onPress={() => void Linking.openURL(message.mediaUrl!)} style={styles.mediaLink}>
                        <SymbolView name={{ ios: 'play.fill', android: 'play_arrow', web: 'play_arrow' }} size={22} tintColor="#FFFFFF" />
                        <Text style={styles.mediaLinkText}>{message.fileName || 'Video'}</Text>
                    </Pressable>
                ) : message.type === 'audio' && message.mediaUrl ? (
                    <Pressable onPress={() => void Linking.openURL(message.mediaUrl!)} style={styles.mediaLink}>
                        <SymbolView name={{ ios: 'waveform', android: 'graphic_eq', web: 'graphic_eq' }} size={22} tintColor="#FFFFFF" />
                        <Text style={styles.mediaLinkText}>{message.fileName || 'Audio message'}</Text>
                    </Pressable>
                ) : (
                    <Text style={[styles.messageText, isMine && styles.ownMessageText]}>{message.text}</Text>
                )}
                <Text style={[styles.messageTime, isMine && styles.ownMessageTime]}>{getMessageTime(message.createdAt)}</Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    messageRow: {
        alignItems: 'flex-start',
        marginBottom: 10,
        paddingHorizontal: 2,
    },
    ownMessageRow: {
        alignItems: 'flex-end',
    },
    messageBubble: {
        borderRadius: 16,
        maxWidth: '82%',
        minWidth: 80,
        paddingHorizontal: 13,
        paddingTop: 10,
    },
    ownMessageBubble: {
        backgroundColor: '#20232A',
        borderBottomRightRadius: 5,
    },
    otherMessageBubble: {
        backgroundColor: '#FFFFFF',
        borderBottomLeftRadius: 5,
    },
    messageText: {
        color: '#363A42',
        fontSize: 15,
        lineHeight: 21,
    },
    ownMessageText: {
        color: '#FFFFFF',
    },
    messageTime: {
        alignSelf: 'flex-end',
        color: '#8D929C',
        fontSize: 10,
        marginTop: 5,
    },
    ownMessageTime: {
        color: '#B9BBC0',
    },
    messageImage: {
        borderRadius: 9,
        height: 210,
        width: 220,
    },
    mediaLink: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 9,
        minHeight: 32,
    },
    mediaLinkText: {
        color: '#FFFFFF',
        flexShrink: 1,
        fontSize: 13,
        fontWeight: '700',
    },
});
