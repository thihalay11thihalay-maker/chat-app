import { Ionicons } from '@expo/vector-icons';
import * as Contacts from 'expo-contacts';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { sendContactMessage } from '@/lib/chat-messages';
import { getFirebaseAuth } from '@/lib/firebase';

type ContactRow = {
  id: string;
  name: string;
  phone: string;
};

const FIELDS = [Contacts.ContactField.FULL_NAME, Contacts.ContactField.PHONES] as const;

/**
 * Sends somebody's contact card into a conversation.
 *
 * A list built in the app rather than the system contact sheet, because this version of expo-contacts
 * does not have one. The cost of doing it here is that the whole address book is read rather than the
 * one person, which is why only two fields are asked for and only a bounded page is shown: a name and a
 * number are all a message can display, and the rest of what is on the phone is none of this message's
 * business.
 */
export default function ShareContactScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chatId = Array.isArray(id) ? id[0] : id || '';

  const [rows, setRows] = useState<ContactRow[]>([]);
  const [searchText, setSearchText] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState('');
  const [error, setError] = useState('');

  /**
   * Reads the address book, once, for this screen.
   *
   * The permission is requested here rather than at send time, because it has to be asked before
   * anything can be read and there is nothing to show until it is answered. Everything after that is one
   * query per page rather than one query per keystroke: the list is a bounded page and the search box
   * filters it, which is enough for picking somebody whose name is on this phone.
   */
  const loadContacts = useCallback(async () => {
    try {
      const { status } = await Contacts.requestPermissionsAsync();

      if (status !== 'granted') {
        setError('Allow access to your contacts to share one.');
        return;
      }

      const container = await Contacts.Container.getDefault();

      if (!container) {
        setError('This device has no contacts to share.');
        return;
      }

      const groups = await container.getGroups();
      const group = groups[0];

      if (!group) {
        setError('This device has no contacts to share.');
        return;
      }

      const contacts = await group.getContacts({
        limit: 60,
        sortOrder: Contacts.ContactsSortOrder.FamilyName,
      });

      const loaded = await Promise.all(contacts.map(async (contact) => {
        const details = await contact.getDetails(FIELDS);
        const [phone] = details.phones ?? [];

        return {
          id: contact.id,
          name: details.fullName || 'No name',
          phone: phone?.number ?? '',
        };
      }));

      setRows(loaded.filter((row) => row.name !== 'No name' || row.phone !== ''));
    } catch (readError) {
      console.error('Could not read the contacts:', readError);
      setError('Could not read your contacts.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadContacts();
    }, [loadContacts]),
  );

  const share = useCallback(async (row: ContactRow) => {
    const currentUser = getFirebaseAuth().currentUser;

    if (!currentUser || isSending !== '') {
      return;
    }

    setIsSending(row.id);

    try {
      // Written as a card rather than as the words, so the number arrives as somebody to call.
      await sendContactMessage({ chatId, contactName: row.name, contactPhone: row.phone });

      router.back();
    } catch (error) {
      console.error('Could not share the contact:', error);
      setError('Could not send that contact.');
      setIsSending('');
    }
  }, [chatId, isSending]);

  const needle = searchText.trim().toLowerCase();
  const visibleRows = needle
    ? rows.filter((row) => row.name.toLowerCase().includes(needle) || row.phone.includes(needle))
    : rows;

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="Back" accessibilityRole="button" onPress={() => router.back()}>
          <Text style={styles.back}>←</Text>
        </Pressable>
        <Text style={styles.title}>Share a contact</Text>
      </View>

      <View style={styles.search}>
        <Ionicons color="#8D929C" name="search" size={16} />
        <TextInput
          onChangeText={setSearchText}
          placeholder="Search contacts"
          placeholderTextColor="#8D929C"
          style={styles.searchInput}
          value={searchText}
        />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {isLoading ? (
        <ActivityIndicator color="#2FBF71" style={styles.loading} />
      ) : (
        <FlatList
          contentContainerStyle={styles.list}
          data={visibleRows}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={(
            <Text style={styles.empty}>
              {needle ? 'Nobody here matches that.' : 'No contacts on this device.'}
            </Text>
          )}
          renderItem={({ item }) => (
            <Pressable
              accessibilityLabel={`Share ${item.name}`}
              accessibilityRole="button"
              disabled={isSending !== ''}
              onPress={() => void share(item)}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <View style={styles.avatar}>
                <Text style={styles.initial}>{item.name.charAt(0).toUpperCase()}</Text>
              </View>
              <View style={styles.copy}>
                <Text numberOfLines={1} style={styles.name}>{item.name}</Text>
                {item.phone ? <Text numberOfLines={1} style={styles.phone}>{item.phone}</Text> : null}
              </View>
              {isSending === item.id ? <ActivityIndicator color="#2FBF71" size="small" /> : null}
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
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
  search: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 8,
    marginHorizontal: 16,
    paddingHorizontal: 12,
  },
  searchInput: {
    color: '#20232A',
    flex: 1,
    fontSize: 15,
    paddingVertical: 10,
  },
  error: {
    color: '#C0392B',
    fontSize: 13,
    marginHorizontal: 16,
    marginTop: 10,
  },
  loading: {
    marginTop: 30,
  },
  list: {
    paddingBottom: 24,
    paddingHorizontal: 16,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 9,
  },
  pressed: {
    opacity: 0.6,
  },
  avatar: {
    alignItems: 'center',
    backgroundColor: '#E7E2DA',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  initial: {
    color: '#6C7079',
    fontSize: 15,
    fontWeight: '800',
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    color: '#20232A',
    fontSize: 15,
    fontWeight: '700',
  },
  phone: {
    color: '#8D929C',
    fontSize: 12,
    marginTop: 1,
  },
  empty: {
    color: '#8D929C',
    fontSize: 14,
    paddingTop: 30,
    textAlign: 'center',
  },
});