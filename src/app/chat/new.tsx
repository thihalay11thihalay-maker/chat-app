import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrivacyOption } from '@/components/privacy-option';
import {
  createRoom,
  PersonSummary,
  RoomKind,
  RoomPrivacy,
  searchPeople,
} from '@/lib/chat-rooms';
import { getFirebaseAuth } from '@/lib/firebase';

/**
 * Creates a group or a channel.
 *
 * Both are the same document with a different rule about who may post into them, so they share this
 * screen rather than having one each: the difference is which button led here and one line of explanation
 * under the name field. Splitting them would duplicate the member picker and the picture picker for the
 * sake of a difference that is one word long.
 *
 * The kind arrives as a route param rather than as a toggle here, so the chat list's two buttons are the
 * only place that offers the choice, and there is no way to reach this screen and pick the wrong one.
 */
export default function NewRoomScreen() {
  const { kind } = useLocalSearchParams<{ kind?: string }>();
  const roomKind: Exclude<RoomKind, 'direct'> = kind === 'channel' ? 'channel' : 'group';

  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [avatarUri, setAvatarUri] = useState('');
  // Public to begin with, because that is the room most people are making when they make one here: a
  // channel or a group whose point is that other people can find it. Asked now rather than left to the
  // room profile afterwards, because making a room public by accident and then having to remember to go
  // and close it is the way a room ends up open when it was never meant to be.
  const [privacy, setPrivacy] = useState<RoomPrivacy>('public');
  const [search, setSearch] = useState('');
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isLoadingPeople, setIsLoadingPeople] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const currentUserId = getFirebaseAuth().currentUser?.uid ?? '';

  // Loaded once rather than searched on every keystroke. The list is bounded and already in memory, so
  // filtering it as the user types is instant and costs nothing, where a query per character would be a
  // round trip per character to look at data that has not changed.
  useEffect(() => {
    let isCancelled = false;

    void (async () => {
      try {
        const found = await searchPeople('', currentUserId ? [currentUserId] : []);

        if (!isCancelled) {
          setPeople(found);
        }
      } catch (error) {
        console.error('Could not load people:', error);
        if (!isCancelled) {
          Alert.alert('Could not load people', 'Check your connection and try again.');
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingPeople(false);
        }
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [currentUserId]);

  const selectedPeople = useMemo(
    () => selectedIds
      .map((id) => people.find((person) => person.id === id))
      .filter((person): person is PersonSummary => Boolean(person)),
    [people, selectedIds],
  );

  const needle = search.trim().toLowerCase();
  const matches = useMemo(
    () => people.filter((person) => (
      !needle || person.name.toLowerCase().includes(needle)
    )),
    [needle, people],
  );

  const trimmedName = name.trim();
  // Both are hard requirements rather than warnings: a room with no name is unrecognisable in the inbox,
  // and a room of one person is a conversation with yourself that the rules refuse outright.
  const canCreate = trimmedName !== '' && selectedIds.length > 0 && !isSaving;

  const togglePerson = (id: string) => {
    setSelectedIds((current) => (
      current.includes(id) ? current.filter((personId) => personId !== id) : [...current, id]
    ));
  };

  const pickPicture = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        Alert.alert('Permission required', 'Allow access to your photos to choose a picture.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: true,
        aspect: [1, 1],
        mediaTypes: ['images'],
        quality: 0.8,
      });

      if (!result.canceled) {
        setAvatarUri(result.assets[0].uri);
      }
    } catch (error) {
      console.error('Could not choose a picture:', error);
      Alert.alert('Could not open photos', 'Please try again.');
    }
  };

  const submit = async () => {
    if (!canCreate) {
      return;
    }

    setIsSaving(true);

    try {
      const roomId = await createRoom({
        about,
        avatarUri,
        kind: roomKind,
        name: trimmedName,
        participantIds: selectedIds,
        privacy,
      });

      // Replaced rather than pushed, so the create screen is not left in the back stack to be returned
      // to. The room opens on its own because it is empty and the person made it to say something in it.
      router.replace({ params: { id: roomId }, pathname: '/chat/[id]' } as never);
    } catch (error) {
      console.error('Could not create the room:', error);
      Alert.alert(
        roomKind === 'channel' ? 'Could not create the channel' : 'Could not create the group',
        error instanceof Error ? error.message : 'Please try again in a moment.',
      );
      setIsSaving(false);
    }
  };

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Go back"
          accessibilityRole="button"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
        >
          <Ionicons color="#20232A" name="chevron-back" size={24} />
        </Pressable>

        <Text style={styles.headerTitle}>{roomKind === 'channel' ? 'New channel' : 'New group'}</Text>

        <Pressable
          accessibilityRole="button"
          disabled={!canCreate}
          onPress={() => void submit()}
          style={({ pressed }) => [
            styles.createButton,
            !canCreate && styles.createButtonDisabled,
            pressed && canCreate && styles.pressed,
          ]}
        >
          {isSaving ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Text style={styles.createButtonText}>Create</Text>
          )}
        </Pressable>
      </View>

      {/* `padding` rather than the chat screen's `translate-with-padding`: this is a scrolling form, and
          the mode meant for a scroll view is the one that resizes the content above the keyboard. */}
      <KeyboardAvoidingView automaticOffset behavior="padding" style={styles.flex}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Pressable
            accessibilityLabel="Choose a picture"
            accessibilityRole="button"
            onPress={() => void pickPicture()}
            style={({ pressed }) => [styles.pictureWrap, pressed && styles.pressed]}
          >
            {avatarUri ? (
              <Image source={{ uri: avatarUri }} style={styles.picture} />
            ) : (
              <Ionicons
                color="#8D929C"
                name={roomKind === 'channel' ? 'megaphone' : 'people'}
                size={26}
              />
            )}
          </Pressable>
          <Text style={styles.pictureHint}>Tap to choose a picture</Text>

          <TextInput
            onChangeText={setName}
            placeholder={roomKind === 'channel' ? 'Channel name' : 'Group name'}
            placeholderTextColor="#A2A7B0"
            style={styles.nameInput}
            value={name}
          />

          <TextInput
            maxLength={200}
            multiline
            onChangeText={setAbout}
            placeholder="About"
            placeholderTextColor="#A2A7B0"
            style={styles.aboutInput}
            value={about}
          />

          {/* Said once, here, because it is the only thing that is actually different about a channel,
              and somebody making one should not have to work it out from a missing composer later. */}
          <Text style={styles.hint}>
            {roomKind === 'channel'
              ? 'Only you can post in a channel. Everyone you add can read it.'
              : 'Everyone you add can post and reply.'}
          </Text>

          {/* The same two buttons the room profile offers, asked here rather than only afterwards. The
              default is the open one, so somebody who wanted a private room and did not think to go back
              and close it would be handing out a link to a room they meant to keep to themselves. */}
          <View style={styles.privacySection}>
            <Text style={styles.privacyHeading}>Who can join</Text>

            <View style={styles.privacySegment}>
              <PrivacyOption
                active={privacy === 'public'}
                icon="globe-outline"
                // A channel is not a group with a different name, and calling it one here would be a
                // small lie in the one place somebody looks to find out what they are making.
                label={roomKind === 'channel' ? 'Public channel' : 'Public group'}
                onPress={() => setPrivacy('public')}
              />
              <PrivacyOption
                active={privacy === 'private'}
                icon="lock-closed"
                label="Make private"
                onPress={() => setPrivacy('private')}
              />
            </View>

            <Text style={styles.privacyHint}>
              {privacy === 'public'
                ? `Anyone with an invite link can join this ${roomKind === 'channel' ? 'channel' : 'group'}. Nobody else can find it.`
                : `Only the people you add can see this ${roomKind === 'channel' ? 'channel' : 'group'}. Invite links stop working.`}
            </Text>
          </View>

          <Text style={styles.sectionTitle}>Members</Text>

          {selectedPeople.length > 0 ? (
            <View style={styles.chips}>
              {selectedPeople.map((person) => (
                <Pressable
                  accessibilityLabel={`Remove ${person.name}`}
                  accessibilityRole="button"
                  key={person.id}
                  onPress={() => togglePerson(person.id)}
                  style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
                >
                  {person.photoUrl ? (
                    <Image source={{ uri: person.photoUrl }} style={styles.chipAvatar} />
                  ) : (
                    <View style={[styles.chipAvatar, styles.chipAvatarFallback]}>
                      <Text style={styles.chipInitial}>{person.name.charAt(0).toUpperCase()}</Text>
                    </View>
                  )}
                  <Text numberOfLines={1} style={styles.chipName}>{person.name}</Text>
                  <Ionicons color="#8D929C" name="close" size={14} />
                </Pressable>
              ))}
            </View>
          ) : null}

          <View style={styles.searchField}>
            <Ionicons color="#A2A7B0" name="search" size={16} />
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setSearch}
              placeholder="Search people"
              placeholderTextColor="#A2A7B0"
              style={styles.searchInput}
              value={search}
            />
          </View>

          {isLoadingPeople ? (
            <ActivityIndicator color="#2FBF71" style={styles.loading} />
          ) : matches.length === 0 ? (
            <Text style={styles.empty}>Nobody here by that name.</Text>
          ) : (
            matches.map((person) => {
              const isSelected = selectedIds.includes(person.id);

              return (
                <Pressable
                  accessibilityRole="button"
                  key={person.id}
                  onPress={() => togglePerson(person.id)}
                  style={({ pressed }) => [styles.personRow, pressed && styles.pressed]}
                >
                  {person.photoUrl ? (
                    <Image source={{ uri: person.photoUrl }} style={styles.personAvatar} />
                  ) : (
                    <View style={[styles.personAvatar, styles.personAvatarFallback]}>
                      <Text style={styles.personInitial}>{person.name.charAt(0).toUpperCase()}</Text>
                    </View>
                  )}

                  <Text numberOfLines={1} style={styles.personName}>{person.name}</Text>

                  <Ionicons
                    color={isSelected ? '#2FBF71' : '#C9C4BB'}
                    name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                    size={21}
                  />
                </Pressable>
              );
            })
          )}
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
  flex: {
    flex: 1,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  headerButton: {
    padding: 4,
  },
  headerTitle: {
    color: '#20232A',
    flex: 1,
    fontSize: 19,
    fontWeight: '700',
  },
  createButton: {
    backgroundColor: '#2FBF71',
    borderRadius: 999,
    minWidth: 76,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  createButtonDisabled: {
    backgroundColor: '#C9C4BB',
  },
  createButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.7,
  },
  content: {
    paddingBottom: 48,
    paddingHorizontal: 20,
  },
  pictureWrap: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: '#E7E2DA',
    borderRadius: 40,
    height: 80,
    justifyContent: 'center',
    marginTop: 8,
    overflow: 'hidden',
    width: 80,
  },
  picture: {
    height: '100%',
    width: '100%',
  },
  pictureHint: {
    color: '#A2A7B0',
    fontSize: 12,
    marginTop: 8,
    textAlign: 'center',
  },
  nameInput: {
    borderBottomColor: '#E3DED5',
    borderBottomWidth: StyleSheet.hairlineWidth,
    color: '#20232A',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 20,
    paddingVertical: 12,
  },
  aboutInput: {
    borderBottomColor: '#E3DED5',
    borderBottomWidth: StyleSheet.hairlineWidth,
    color: '#656A73',
    fontSize: 15,
    minHeight: 64,
    paddingVertical: 12,
    textAlignVertical: 'top',
  },
  hint: {
    color: '#8D929C',
    fontSize: 12,
    marginTop: 10,
  },
  privacySection: {
    marginTop: 22,
  },
  privacyHeading: {
    color: '#20232A',
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 8,
  },
  privacySegment: {
    flexDirection: 'row',
    gap: 8,
  },
  privacyHint: {
    color: '#8D929C',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 8,
  },
  sectionTitle: {
    color: '#20232A',
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 10,
    marginTop: 26,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  chip: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 7,
    maxWidth: '100%',
    paddingRight: 12,
    paddingVertical: 6,
    paddingLeft: 6,
  },
  chipAvatar: {
    borderRadius: 15,
    height: 30,
    width: 30,
  },
  chipAvatarFallback: {
    alignItems: 'center',
    backgroundColor: '#E7E2DA',
    justifyContent: 'center',
  },
  chipInitial: {
    color: '#656A73',
    fontSize: 13,
    fontWeight: '700',
  },
  chipName: {
    color: '#363A42',
    flexShrink: 1,
    fontSize: 13,
    fontWeight: '600',
  },
  searchField: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 9,
    marginBottom: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  searchInput: {
    color: '#20232A',
    flex: 1,
    fontSize: 15,
    padding: 0,
  },
  personRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 10,
  },
  personAvatar: {
    borderRadius: 21,
    height: 42,
    width: 42,
  },
  personAvatarFallback: {
    alignItems: 'center',
    backgroundColor: '#E7E2DA',
    justifyContent: 'center',
  },
  personInitial: {
    color: '#656A73',
    fontSize: 16,
    fontWeight: '700',
  },
  personName: {
    color: '#20232A',
    flex: 1,
    fontSize: 15,
  },
  loading: {
    marginTop: 24,
  },
  empty: {
    color: '#8D929C',
    fontSize: 14,
    paddingVertical: 20,
    textAlign: 'center',
  },
});
