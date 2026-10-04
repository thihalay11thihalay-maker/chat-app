import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { readRoomName } from '@/lib/chat-rooms';
import {
  ChatSettings,
  DEFAULT_CHAT_SETTINGS,
  describeDisappearing,
  DISAPPEARING_OPTIONS,
  loadChatSettings,
  NOTIFICATION_SOUNDS,
  saveChatSettings,
} from '@/lib/chat-settings';
import { doc, getDoc } from 'firebase/firestore';
import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';

/**
 * How this account wants to be spoken to in one room.
 *
 * Every choice here is per-person rather than shared, which is why none of it is on the room document:
 * a mute written there would silence the room for everybody in it, and a disappearing-messages timer
 * written there would delete what the other people in the room can still read.
 */
export default function RoomSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chatId = Array.isArray(id) ? id[0] : id || '';

  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_CHAT_SETTINGS);
  const [roomName, setRoomName] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    const currentUser = getFirebaseAuth().currentUser;

    if (!chatId || !currentUser) {
      setIsLoading(false);
      return;
    }

    try {
      const [loaded, room] = await Promise.all([
        loadChatSettings(chatId, currentUser.uid),
        getDoc(doc(getFirebaseDb(), 'chats', chatId)),
      ]);

      setSettings(loaded);
      setRoomName(room.exists() ? readRoomName(room.data(), '') : '');
    } catch (error) {
      console.error('Could not read the room settings:', error);
    } finally {
      setIsLoading(false);
    }
  }, [chatId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const apply = useCallback(async (next: Partial<ChatSettings>) => {
    const currentUser = getFirebaseAuth().currentUser;

    if (!currentUser) {
      return;
    }

    // Shown before it is written, because a settings row that waits for a round trip reads as broken.
    // Reverted on failure, so the row never claims something the server refused.
    const previous = settings;

    setSettings((current) => ({ ...current, ...next }));

    try {
      await saveChatSettings(chatId, currentUser.uid, next);
    } catch (error) {
      console.error('Could not save the room settings:', error);
      setSettings(previous);
    }
  }, [chatId, settings]);

  const openStats = useCallback(() => {
    router.push({ params: { id: chatId }, pathname: '/chat/[id]/stats' } as never);
  }, [chatId]);

  if (isLoading) {
    return (
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <ActivityIndicator color="#2FBF71" style={styles.loading} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="Back" accessibilityRole="button" onPress={() => router.back()}>
          <Text style={styles.back}>←</Text>
        </Pressable>
        <Text style={styles.title}>Notifications</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.scope}>
          {roomName ? `For you only, in ${roomName}.` : 'These settings are yours alone.'}
        </Text>

        <Text style={styles.section}>Alerts</Text>
        <View style={styles.card}>
          <Row
            icon={settings.muted ? 'notifications-off' : 'notifications-outline'}
            label="Mute this conversation"
            onPress={() => void apply({ muted: !settings.muted })}
            value={settings.muted ? 'Muted' : 'On'}
          />
        </View>

        <Text style={styles.section}>Sound</Text>
        <View style={styles.card}>
          {NOTIFICATION_SOUNDS.map((sound, index) => (
            <Choice
              key={sound.value}
              isFirst={index === 0}
              label={sound.label}
              onPress={() => void apply({ notificationSound: sound.value })}
              selected={settings.notificationSound === sound.value}
            />
          ))}
        </View>
        <Text style={styles.note}>
          The sound is used when this conversation announces something on your phone.
        </Text>

        <Text style={styles.section}>Disappearing messages</Text>
        <View style={styles.card}>
          {DISAPPEARING_OPTIONS.map((option, index) => (
            <Choice
              isFirst={index === 0}
              key={option.seconds}
              label={option.label}
              onPress={() => void apply({ disappearingAfterSeconds: option.seconds })}
              selected={settings.disappearingAfterSeconds === option.seconds}
            />
          ))}
        </View>
        <Text style={styles.note}>
          Only messages you send are affected. What you set here deletes what you wrote after that time,
          and nothing anybody else wrote. Currently {describeDisappearing(settings.disappearingAfterSeconds).toLowerCase()}.
        </Text>

        <Text style={styles.section}>Room</Text>
        <View style={styles.card}>
          <Row icon="stats-chart" label="Group information" onPress={openStats} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({
  icon,
  label,
  onPress,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  value?: string;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Ionicons color="#8D929C" name={icon} size={18} />
      <Text style={styles.rowLabel}>{label}</Text>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
      <Ionicons color="#C4C7CD" name="chevron-forward" size={16} />
    </Pressable>
  );
}

function Choice({
  isFirst,
  label,
  onPress,
  selected,
}: {
  isFirst: boolean;
  label: string;
  onPress: () => void;
  selected: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.row, !isFirst && styles.rowDivided, pressed && styles.pressed]}
    >
      <Text style={styles.rowLabel}>{label}</Text>
      {selected ? <Ionicons color="#2FBF71" name="checkmark" size={18} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  loading: {
    marginTop: 60,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  back: {
    color: '#363A42',
    fontSize: 22,
  },
  title: {
    color: '#20232A',
    fontSize: 19,
    fontWeight: '800',
  },
  content: {
    paddingBottom: 32,
  },
  scope: {
    color: '#8D929C',
    fontSize: 13,
    marginBottom: 16,
    marginHorizontal: 16,
  },
  section: {
    color: '#8D929C',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    marginBottom: 8,
    marginLeft: 22,
    marginTop: 14,
    textTransform: 'uppercase',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    marginHorizontal: 16,
    overflow: 'hidden',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowDivided: {
    borderTopColor: '#F0EDE7',
    borderTopWidth: 1,
  },
  rowLabel: {
    color: '#20232A',
    flex: 1,
    fontSize: 15,
  },
  rowValue: {
    color: '#8D929C',
    fontSize: 13,
  },
  pressed: {
    backgroundColor: '#F7F4EF',
  },
  note: {
    color: '#8D929C',
    fontSize: 12,
    lineHeight: 18,
    marginHorizontal: 16,
    marginTop: 8,
  },
});