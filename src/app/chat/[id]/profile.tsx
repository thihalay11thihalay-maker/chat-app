import { Ionicons } from '@expo/vector-icons';
import { deleteDoc, doc, getDoc } from 'firebase/firestore';
import * as ImagePicker from 'expo-image-picker';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  banRoomMember,
  canPostToRoom,
  leaveRoom,
  PersonSummary,
  readParticipantIds,
  readPerson,
  readRoomAbout,
  readRoomAdminIds,
  readRoomAvatarUrl,
  readRoomBannedIds,
  readRoomKind,
  readRoomName,
  readRoomOwnerId,
  readRoomPrivacy,
  readRoomRole,
  RoomKind,
  RoomPrivacy,
  RoomRole,
  searchPeople,
  setRoomAdmin,
  unbanRoomMember,
  updateRoomDetails,
  updateRoomMembers,
  uploadRoomAvatar,
} from '@/lib/chat-rooms';
import { PrivacyOption } from '@/components/privacy-option';
import { PersonAvatar } from '@/components/person-avatar';
import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';
import { PresenceMap, subscribeToPresence } from '@/lib/presence';

type Member = {
  id: string;
  isOwner: boolean;
  name: string;
  photoUrl: string;
  role: RoomRole;
};

/** One row of the member actions sheet. */
type MemberAction = {
  destructive?: boolean;
  label: string;
  onPress: () => void;
};

/**
 * A group's or channel's profile.
 *
 * Three things live here that have nowhere else to live: what the room is called and about, who is in it,
 * and the two ways out of it. The last one is the reason this is a screen and not a sheet: leaving cannot
 * be undone, because the rules allow the participant list to change only by removing the caller, and
 * nothing puts them back.
 */
export default function RoomProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chatId = Array.isArray(id) ? id[0] : id || '';

  const [kind, setKind] = useState<RoomKind>('direct');
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [admins, setAdmins] = useState<string[]>([]);
  const [banned, setBanned] = useState<{ uid: string }[]>([]);
  const [privacy, setPrivacy] = useState<RoomPrivacy>('public');
  const [memberSearch, setMemberSearch] = useState('');
  const [isAddingMembers, setIsAddingMembers] = useState(false);
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [peopleSearch, setPeopleSearch] = useState('');
  const [chosenIds, setChosenIds] = useState<string[]>([]);
  const [isWorking, setIsWorking] = useState(false);
  const [memberActions, setMemberActions] = useState<{ actions: MemberAction[]; name: string } | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  // Who is online, for the lights on the member list. One subscription for the whole room rather than one
  // per row, and re-made only when the set of members changes -- a new subscription tears every one of
  // them down and rebuilds, which would make every light in the list blink as somebody was added.
  const [presence, setPresence] = useState<PresenceMap>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftAbout, setDraftAbout] = useState('');
  const [draftAvatarUri, setDraftAvatarUri] = useState('');

  const currentUserId = getFirebaseAuth().currentUser?.uid ?? '';
  const isOwner = ownerId !== '' && ownerId === currentUserId;
  // An admin can run the room without owning it: rename it, remove people, promote people. The two are
  // separated because ownership cannot be given away by the rules at all, and an admin who could not do
  // any of this would be a badge and nothing else.
  const canManage = isOwner || admins.includes(currentUserId);

  /**
   * Reads the room, then its members.
   *
   * The member profiles are read one document at a time rather than as one query, because the ids come
   * from a field on the room and not from anything the account is allowed to query. A room's membership is
   * a handful of people, so this is a handful of reads once, not a live subscription: nobody needs the
   * member list to update while this screen is open.
   */
  /**
   * Set while a read is still in flight and the screen has stopped being the one in front, so a slow
   * answer cannot land on a screen the reader has already left. A local variable would not do: the
   * read outlives the call that started it, and only the effect cleanup knows the screen moved on.
   */
  const isStaleRef = useRef(false);

  const loadRoom = useCallback(async () => {
    if (!chatId) {
      return;
    }

    try {
      const snapshot = await getDoc(doc(getFirebaseDb(), 'chats', chatId));

      if (!snapshot.exists() || isStaleRef.current) {
        return;
      }

      const data = snapshot.data();
      const roomKind = readRoomKind(data);
      const roomOwnerId = readRoomOwnerId(data);
      const participantIds = readParticipantIds(data);

      setKind(roomKind);
      setName(readRoomName(data, ''));
      setAbout(readRoomAbout(data));
      setAvatarUrl(readRoomAvatarUrl(data));
      setOwnerId(roomOwnerId);
      setAdmins(readRoomAdminIds(data));
      setBanned(readRoomBannedIds(data).map((uid) => ({ uid })));
      setPrivacy(readRoomPrivacy(data));
      setDraftName(readRoomName(data, ''));
      setDraftAbout(readRoomAbout(data));

      const profiles = await Promise.all(participantIds.map(async (participantId) => {
        const profileSnapshot = await getDoc(doc(getFirebaseDb(), 'users', participantId));
        const person = readPerson(profileSnapshot.exists() ? profileSnapshot.data() : {}, 'Someone');

        return {
          id: participantId,
          isOwner: participantId === roomOwnerId,
          name: person.name,
          photoUrl: person.photoUrl,
          role: readRoomRole(data, participantId),
        };
      }));

      if (!isStaleRef.current) {
        setMembers(profiles);
      }
    } catch (error) {
      console.error('Could not load the room:', error);
      if (!isStaleRef.current) {
        Alert.alert('Could not load this room', 'Please try again in a moment.');
      }
    } finally {
      if (!isStaleRef.current) {
        setIsLoading(false);
      }
    }
  }, [chatId]);

  // Focus rather than mount, so a rename made here, or a membership change made on the chat screen
  // underneath, is what this screen is looking at when it comes back: the room is re-read on every
  // arrival and the member list is never left describing the room as it was before.
  useFocusEffect(
    useCallback(() => {
      isStaleRef.current = false;
      void loadRoom();

      return () => {
        isStaleRef.current = true;
      };
    }, [loadRoom]),
  );

  const startEditing = () => {
    setDraftName(name);
    setDraftAbout(about);
    setDraftAvatarUri('');
    setIsEditing(true);
  };

  /** Flips the room between a link people can follow and one only its members can reach. */
  const changePrivacy = async (next: RoomPrivacy) => {
    setIsSaving(true);

    try {
      await updateRoomDetails(chatId, { privacy: next });
      setPrivacy(next);
    } catch (error) {
      console.error('Could not change the room privacy:', error);
      Alert.alert('Could not change that', 'Only the owner can make a group public or private.');
    } finally {
      setIsSaving(false);
    }
  };

  /** What can be done to one member, as a sheet rather than a row of buttons per person. */
  const openMemberActions = (member: Member) => {
    if (!canManage || member.id === currentUserId) {
      return;
    }

    const isAdminMember = admins.includes(member.id);
    const actions: MemberAction[] = [];

    // Only the owner may hand out admin, because an admin who could promote people could appoint
    // themselves again after being demoted. The rules enforce this; the sheet does not offer it.
    if (isOwner) {
      actions.push({
        label: isAdminMember ? 'Remove admin' : 'Make admin',
        onPress: () => void runMemberChange(
          () => setRoomAdmin(chatId, member.id, !isAdminMember),
          isAdminMember ? 'Admin removed' : `${member.name} is now an admin`,
        ),
      });
    }

    actions.push({
      destructive: true,
      label: 'Remove from group',
      onPress: () => {
        closeMemberActions();

        Alert.alert(
          `Remove ${member.name}?`,
          'They lose access to this group. They can be added again from your contacts.',
          [
            { style: 'cancel', text: 'Cancel' },
            {
              style: 'destructive',
              text: 'Remove',
              onPress: () => void runMemberChange(
                () => updateRoomMembers(chatId, [], [member.id]),
                `${member.name} was removed.`,
              ),
            },
          ],
        );
      },
    });

    actions.push({
      destructive: true,
      label: 'Block',
      onPress: () => {
        closeMemberActions();

        Alert.alert(
          `Block ${member.name}?`,
          'They are removed and cannot join again through an invite link.',
          [
            { style: 'cancel', text: 'Cancel' },
            {
              style: 'destructive',
              text: 'Block',
              onPress: () => void runMemberChange(
                () => banRoomMember(chatId, member.id),
                `${member.name} was removed and blocked.`,
              ),
            },
          ],
        );
      },
    });

    // A sheet rather than a system alert, because a system alert on Android shows at most three buttons:
    // the fourth, which was the way out, was dropped, and a dialog with no way out is one the reader is
    // stuck in. This has a close button, a backdrop to tap and a back-button handler, and it holds any
    // number of rows.
    setMemberActions({ actions, name: member.name });
  };

  const closeMemberActions = useCallback(() => setMemberActions(null), []);

  /**
   * Runs one change and re-reads the room, so what is on screen is what the document now says.
   *
   * The re-read rather than a local guess: every one of these writes a list that several people can see,
   * and the version this screen was drawn from may already be out of date by the time somebody presses.
   */
  const runMemberChange = async (change: () => Promise<unknown>, successMessage: string) => {
    if (isWorking) {
      return;
    }

    setIsWorking(true);

    try {
      await change();
      await loadRoom();
      Alert.alert('Done', successMessage);
    } catch (error) {
      console.error('Could not change the member:', error);
      Alert.alert('Could not do that', 'Please try again in a moment.');
    } finally {
      setIsWorking(false);
    }
  };

  const unban = async (uid: string) => {
    await runMemberChange(() => unbanRoomMember(chatId, uid), 'They can join again through a link.');
  };

  const toggleChosen = (uid: string) => {
    setChosenIds((current) => (
      current.includes(uid) ? current.filter((id) => id !== uid) : [...current, uid]
    ));
  };

  /** Confirms the people who are not already in the room, then adds them in one write. */
  const addChosenMembers = async () => {
    if (chosenIds.length === 0 || isWorking) {
      return;
    }

    await runMemberChange(
      () => updateRoomMembers(chatId, chosenIds, []),
      `${chosenIds.length} member${chosenIds.length === 1 ? '' : 's'} added.`,
    );
    setChosenIds([]);
    setIsAddingMembers(false);
  };

  /**
   * Loads the people sheet's list once per opening, and searches it in memory.
   *
   * `searchPeople` reads up to 100 profile documents and filters them on the client, because Firestore
   * cannot match a name by substring. Firing that from `onChangeText` meant every keystroke cost up to 100
   * billed reads -- typing a seven-letter name was several hundred reads before the reader saw anything --
   * and the answers could arrive out of order, so the list could settle on results for a prefix rather than
   * for what was on screen.
   *
   * So the bounded slice is read once when the sheet opens, and the text only filters what is already here.
   * The search is as complete as the slice, which is the same limit it always had; only the cost of
   * reaching it changed.
   */
  const openAddMemberSearch = useCallback(async () => {
    setPeopleSearch('');
    setPeople([]);

    try {
      setPeople(await searchPeople('', members.map((member) => member.id)));
    } catch (error) {
      console.error('Could not load people to add:', error);
      setPeople([]);
    }
  }, [members]);

  /**
   * What the sheet actually shows: the slice loaded when it opened, narrowed by what has been typed.
   *
   * Case-insensitive and substring rather than prefix, because that is what somebody searching for a person
   * expects, and doing it here costs nothing. Firestore still cannot do this -- it cannot match a string by
   * substring at all -- which is why the list is read whole and filtered on the device.
   */
  const visiblePeople = useMemo(() => {
    const needle = peopleSearch.trim().toLowerCase();

    if (!needle) {
      return people;
    }

    return people.filter((person) => person.name.toLowerCase().includes(needle));
  }, [people, peopleSearch]);

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
        setDraftAvatarUri(result.assets[0].uri);
      }
    } catch (error) {
      console.error('Could not choose a picture:', error);
      Alert.alert('Could not open photos', 'Please try again.');
    }
  };

  const save = async () => {
    if (draftName.trim() === '') {
      Alert.alert('Name required', 'A room needs a name people can recognise.');
      return;
    }

    setIsSaving(true);

    try {
      // Uploaded first and handed over as a url, because the rules only know about the document and not
      // about the bucket. A failure here leaves the name and about unwritten rather than half applied,
      // which is the right way round: a room with its old name is only untidy, a room that claims a
      // picture it does not have is wrong.
      const uploaded = draftAvatarUri
        ? await uploadRoomAvatar(chatId, currentUserId, draftAvatarUri)
        : '';

      await updateRoomDetails(chatId, {
        about: draftAbout.trim(),
        avatarUrl: uploaded,
        name: draftName.trim(),
      });

      setName(draftName.trim());
      setAbout(draftAbout.trim());

      if (uploaded) {
        setAvatarUrl(uploaded);
      }

      setIsEditing(false);
    } catch (error) {
      console.error('Could not update the room:', error);
      Alert.alert('Could not save', 'Only the owner can change these details. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const confirmLeave = () => {
    // Said here rather than left to be discovered: a channel whose owner has left has nobody who can post
    // into it, and the rules keep it that way, because there is no way to hand ownership on.
    const warning = kind === 'channel' && isOwner
      ? 'You are the only person who can post in this channel. If you leave, nobody can.'
      : 'You will not be able to see this conversation again.';

    Alert.alert(
      isOwner ? 'Leave or delete' : 'Leave',
      warning,
      [
        { style: 'cancel', text: 'Cancel' },
        ...(isOwner
          ? [{
            style: 'destructive' as const,
            text: 'Delete for everyone',
            onPress: () => void removeRoom(),
          }]
          : []),
        {
          style: 'destructive',
          text: 'Leave',
          onPress: () => void exitRoom(),
        },
      ],
    );
  };

  const exitRoom = async () => {
    try {
      await leaveRoom(chatId, currentUserId);
      // Two steps back: the conversation screen is underneath this one, and leaving it behind would
      // return to a room this account can no longer read.
      router.dismissTo('/(tabs)/chat');
    } catch (error) {
      console.error('Could not leave the room:', error);
      Alert.alert('Could not leave', 'Please try again in a moment.');
    }
  };

  const removeRoom = async () => {
    try {
      await deleteDoc(doc(getFirebaseDb(), 'chats', chatId));
      router.dismissTo('/(tabs)/chat');
    } catch (error) {
      console.error('Could not delete the room:', error);
      Alert.alert('Could not delete', 'Please try again in a moment.');
    }
  };

  const isChannel = kind === 'channel';
  const title = kind === 'group' ? 'Group info' : kind === 'channel' ? 'Channel info' : 'Conversation';

  // The member list, filtered by what is typed into it. Every member is already loaded, so this is a
  // filter over the whole list rather than a query, and it cannot miss somebody for a reason about
  // indexes or limits.
  const memberNeedle = memberSearch.trim().toLowerCase();
  const visibleMembers = memberNeedle
    ? members.filter((member) => member.name.toLowerCase().includes(memberNeedle))
    : members;

  // The members to ask about, as one string so the subscription below only changes when the set does.
  // This account is left out: it is obviously online -- the reader is looking at the screen.
  const presenceKey = members
    .map((member) => member.id)
    .filter((id) => id && id !== currentUserId)
    .sort()
    .join(',');

  useEffect(() => subscribeToPresence(
    presenceKey === '' ? [] : presenceKey.split(','),
    setPresence,
  ), [presenceKey]);

  if (isLoading) {
    return (
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <View style={styles.header}>
          <Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => router.back()} style={styles.headerButton}>
            <Ionicons color="#20232A" name="chevron-back" size={24} />
          </Pressable>
          <Text style={styles.headerTitle}>{title}</Text>
        </View>
        <ActivityIndicator color="#2FBF71" style={styles.loading} />
      </SafeAreaView>
    );
  }

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

        <Text style={styles.headerTitle}>{title}</Text>

        {isOwner && !isEditing ? (
          <Pressable accessibilityRole="button" onPress={startEditing} style={({ pressed }) => [styles.editButton, pressed && styles.pressed]}>
            <Text style={styles.editButtonText}>Edit</Text>
          </Pressable>
        ) : null}
      </View>

      {/* What can be done to one member. A sheet rather than a system alert because Android's alert shows
          at most three buttons, and the fourth -- the way out -- was the one that went missing. Three ways
          out here instead of relying on one: the close button, the backdrop, and the system back gesture. */}
      <Modal
        animationType="slide"
        onRequestClose={closeMemberActions}
        transparent
        visible={memberActions !== null}
      >
        <Pressable onPress={closeMemberActions} style={styles.modalBackdrop}>
          <Pressable onPress={(event) => event.stopPropagation()} style={styles.sheet}>
            <View style={styles.sheetHandle} />

            <View style={styles.sheetHeader}>
              <Text numberOfLines={1} style={styles.sheetTitle}>{memberActions?.name}</Text>
              <Pressable
                accessibilityLabel="Close"
                accessibilityRole="button"
                hitSlop={10}
                onPress={closeMemberActions}
                style={({ pressed }) => [styles.sheetClose, pressed && styles.pressed]}
              >
                <Ionicons color="#20232A" name="close" size={20} />
              </Pressable>
            </View>

            {memberActions?.actions.map((action) => (
              <Pressable
                accessibilityLabel={action.label}
                accessibilityRole="button"
                key={action.label}
                onPress={() => {
                  closeMemberActions();
                  action.onPress();
                }}
                style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed]}
              >
                <Text style={[styles.sheetRowText, action.destructive && styles.sheetRowDestructive]}>
                  {action.label}
                </Text>
              </Pressable>
            ))}

            <Pressable
              accessibilityLabel="Cancel"
              accessibilityRole="button"
              onPress={closeMemberActions}
              style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed]}
            >
              <Text style={styles.sheetRowText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Adding people is a sheet rather than a screen because it is one decision with no other purpose:
          pick some people, add them, done. Nothing here needs a header of its own, and a screen would
          hide the room behind it for something this short. */}
      <Modal
        animationType="slide"
        onRequestClose={() => setIsAddingMembers(false)}
        transparent
        visible={isAddingMembers}
      >
        <Pressable onPress={() => setIsAddingMembers(false)} style={styles.modalBackdrop}>
          <Pressable onPress={(event) => event.stopPropagation()} style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Add members</Text>

            <View style={styles.sheetSearch}>
              <Ionicons color="#8D929C" name="search" size={16} />
              <TextInput
                onChangeText={setPeopleSearch}
                placeholder="Search people"
                placeholderTextColor="#A2A7B0"
                style={styles.sheetSearchInput}
                value={peopleSearch}
              />
            </View>

            <ScrollView style={styles.sheetList}>
              {visiblePeople.length === 0 ? (
                <Text style={styles.sheetEmpty}>
                  {peopleSearch ? 'Nobody here matches that.' : 'Start typing a name.'}
                </Text>
              ) : (
                visiblePeople.map((person) => {
                  const chosen = chosenIds.includes(person.id);

                  return (
                    <Pressable
                      accessibilityLabel={person.name}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: chosen }}
                      key={person.id}
                      onPress={() => toggleChosen(person.id)}
                      style={({ pressed }) => [styles.personRow, pressed && styles.pressed]}
                    >
                      {person.photoUrl ? (
                        <Image source={{ uri: person.photoUrl }} style={styles.memberAvatar} />
                      ) : (
                        <View style={[styles.memberAvatar, styles.memberAvatarFallback]}>
                          <Text style={styles.memberInitial}>{person.name.charAt(0).toUpperCase()}</Text>
                        </View>
                      )}
                      <Text numberOfLines={1} style={styles.personName}>{person.name}</Text>
                      <Ionicons
                        color={chosen ? '#2FBF71' : '#D4D7DC'}
                        name={chosen ? 'checkmark-circle' : 'ellipse-outline'}
                        size={21}
                      />
                    </Pressable>
                  );
                })
              )}
            </ScrollView>

            <Pressable
              accessibilityLabel="Add the selected people"
              accessibilityRole="button"
              disabled={chosenIds.length === 0 || isWorking}
              onPress={() => void addChosenMembers()}
              style={({ pressed }) => [
                styles.primaryButton,
                chosenIds.length === 0 && styles.primaryButtonDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryButtonText}>
                {chosenIds.length === 0 ? 'Pick somebody' : `Add ${chosenIds.length}`}
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <KeyboardAvoidingView automaticOffset behavior="padding" style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.identity}>
            {isEditing ? (
              <Pressable accessibilityLabel="Choose a picture" accessibilityRole="button" onPress={() => void pickPicture()}>
                {draftAvatarUri ? (
                  <Image source={{ uri: draftAvatarUri }} style={styles.picture} />
                ) : avatarUrl ? (
                  <Image source={{ uri: avatarUrl }} style={styles.picture} />
                ) : (
                  <View style={[styles.picture, styles.pictureFallback]}>
                    <Ionicons color="#8D929C" name={isChannel ? 'megaphone' : 'people'} size={30} />
                  </View>
                )}
              </Pressable>
            ) : avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={styles.picture} />
            ) : (
              <View style={[styles.picture, styles.pictureFallback]}>
                <Ionicons color="#8D929C" name={isChannel ? 'megaphone' : 'people'} size={30} />
              </View>
            )}

            {isEditing ? (
              <>
                <TextInput
                  onChangeText={setDraftName}
                  placeholder="Name"
                  placeholderTextColor="#A2A7B0"
                  style={styles.nameInput}
                  value={draftName}
                />
                <TextInput
                  maxLength={200}
                  multiline
                  onChangeText={setDraftAbout}
                  placeholder="About"
                  placeholderTextColor="#A2A7B0"
                  style={styles.aboutInput}
                  value={draftAbout}
                />
              </>
            ) : (
              <>
                <Text style={styles.name}>{name || 'Unnamed'}</Text>
                <Text style={styles.about}>
                  {about || (isChannel
                    ? 'Only the owner can post here.'
                    : 'Nothing about this group yet.')}
                </Text>
              </>
            )}

            {isChannel ? (
              <View style={styles.badge}>
                <Ionicons color="#8D929C" name="megaphone" size={12} />
                <Text style={styles.badgeText}>
                  {canPostToRoom(kind, ownerId, admins, currentUserId)
                    ? 'You can post'
                    : 'Only the owner and admins can post'}
                </Text>
              </View>
            ) : null}

            {canManage ? (
              /* The two states side by side rather than one button that toggles between them. A toggle
                 says what will happen; two options say what the choices are, and the answer is still
                 visible after the tap instead of only being inferred from the label that replaced it. */
              <View style={styles.privacySection}>
                <Text style={styles.privacyHeading}>Who can join</Text>

                <View style={styles.privacySegment}>
                  <PrivacyOption
                    active={privacy === 'public'}
                    disabled={!isOwner || isSaving}
                    icon="globe-outline"
                    // A channel is not a group with a different name, and calling it one here would be a
                    // small lie in the one place a member looks to find out what this room is.
                    label={isChannel ? 'Public channel' : 'Public group'}
                    onPress={() => void changePrivacy('public')}
                  />
                  <PrivacyOption
                    active={privacy === 'private'}
                    disabled={!isOwner || isSaving}
                    icon="lock-closed"
                    label="Make private"
                    onPress={() => void changePrivacy('private')}
                  />
                </View>

                <Text style={styles.privacyHint}>
                  {privacy === 'public'
                    ? `Anyone with an invite link can join this ${isChannel ? 'channel' : 'group'}. Nobody else can find it.`
                    : `Only the people already in this ${isChannel ? 'channel' : 'group'} can see it. Invite links stop working.`}
                  {isOwner ? '' : ' Only the owner can change this.'}
                </Text>
              </View>
            ) : null}

            {isEditing ? (
              <View style={styles.editActions}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setIsEditing(false)}
                  style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                >
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={isSaving}
                  onPress={() => void save()}
                  style={({ pressed }) => [styles.primaryButton, isSaving && styles.primaryButtonDisabled, pressed && styles.pressed]}
                >
                  {isSaving ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Text style={styles.primaryButtonText}>Save</Text>
                  )}
                </Pressable>
              </View>
            ) : null}
          </View>

          <Text style={styles.sectionTitle}>Members · {members.length}</Text>

          {/* Search over the members already loaded. Every member is loaded on this screen -- the whole
              list, not a page of it -- so this is a filter rather than a query, which is also why it
              cannot miss somebody whose name the backend cannot match on. */}
          {members.length > 6 ? (
            <View style={styles.memberSearch}>
              <Ionicons color="#8D929C" name="search" size={16} />
              <TextInput
                onChangeText={setMemberSearch}
                placeholder="Search members"
                placeholderTextColor="#A2A7B0"
                style={styles.memberSearchInput}
                value={memberSearch}
              />
            </View>
          ) : null}

          {visibleMembers.map((member) => (
            <Pressable
              accessibilityLabel={`${member.name}, ${member.role}`}
              accessibilityRole="button"
              disabled={!canManage}
              key={member.id}
              onPress={() => member.id === currentUserId ? undefined : openMemberActions(member)}
              style={({ pressed }) => [styles.memberRow, pressed && canManage && styles.pressed]}
            >
              {/* The same avatar as everywhere else, so the light on a member here is the light on that person in
                  the chat list and in the people list. Green when they are online, nothing when not. */}
              <PersonAvatar
                isOnline={presence[member.id] === true}
                name={member.name}
                photoUrl={member.photoUrl}
                size={40}
              />

              <View style={styles.memberCopy}>
                <Text numberOfLines={1} style={styles.memberName}>
                  {member.name}{member.id === currentUserId ? ' (you)' : ''}
                </Text>
                <Text style={styles.memberRole}>
                  {member.role === 'member' ? 'Member' : member.role === 'admin' ? 'Admin' : 'Owner'}
                </Text>
              </View>

              {/* Only drawn where it means something. A badge on every row would be a wall of the same
                  word, and the row already says who runs the room. */}
              {member.role !== 'member' ? (
                <View style={styles.ownerBadge}>
                  <Text style={styles.ownerBadgeText}>
                    {member.role === 'admin' ? 'Admin' : 'Owner'}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          ))}

          {visibleMembers.length === 0 && members.length > 0 ? (
            <Text style={styles.noMembers}>Nobody here matches that.</Text>
          ) : null}

          {canManage && members.length > 0 ? (
            <Pressable
              accessibilityLabel="Add members"
              accessibilityRole="button"
              onPress={() => {
                  setIsAddingMembers(true);
                  void openAddMemberSearch();
                }}
              style={({ pressed }) => [styles.addRow, pressed && styles.pressed]}
            >
              <Ionicons color="#2FBF71" name="person-add" size={17} />
              <Text style={styles.addText}>Add members</Text>
            </Pressable>
          ) : null}

          {canManage ? (
            <Pressable
              accessibilityLabel="Invite people"
              accessibilityRole="button"
              onPress={() => router.push({ params: { id: chatId }, pathname: '/chat/[id]/invite' } as never)}
              style={({ pressed }) => [styles.addRow, pressed && styles.pressed]}
            >
              <Ionicons color="#2FBF71" name="qr-code-outline" size={17} />
              <Text style={styles.addText}>Invite people with a link or QR</Text>
            </Pressable>
          ) : null}

          {banned.length > 0 && canManage ? (
            <>
              <Text style={styles.sectionTitle}>Blocked · {banned.length}</Text>
              {banned.map((entry) => (
                <View key={entry.uid} style={styles.memberRow}>
                  <View style={[styles.memberAvatar, styles.memberAvatarFallback]}>
                    <Ionicons color="#8D929C" name="ban" size={17} />
                  </View>
                  <View style={styles.memberCopy}>
                    <Text numberOfLines={1} style={styles.memberName}>{entry.uid.slice(0, 14)}</Text>
                    <Text style={styles.memberRole}>Cannot join</Text>
                  </View>
                  <Pressable
                    accessibilityLabel="Unblock"
                    accessibilityRole="button"
                    onPress={() => void unban(entry.uid)}
                    style={({ pressed }) => [styles.unbanButton, pressed && styles.pressed]}
                  >
                    <Text style={styles.unbanText}>Unblock</Text>
                  </Pressable>
                </View>
              ))}
            </>
          ) : null}

          <Pressable
            accessibilityLabel="Notifications and disappearing messages"
            accessibilityRole="button"
            onPress={() => router.push({ params: { id: chatId }, pathname: '/chat/[id]/settings' } as never)}
            style={({ pressed }) => [styles.addRow, pressed && styles.pressed]}
          >
            <Ionicons color="#2FBF71" name="notifications-outline" size={17} />
            <Text style={styles.addText}>Notifications and disappearing messages</Text>
          </Pressable>

          <Pressable
            accessibilityLabel="Group information"
            accessibilityRole="button"
            onPress={() => router.push({ params: { id: chatId }, pathname: '/chat/[id]/stats' } as never)}
            style={({ pressed }) => [styles.addRow, pressed && styles.pressed]}
          >
            <Ionicons color="#2FBF71" name="stats-chart-outline" size={17} />
            <Text style={styles.addText}>Group information</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={confirmLeave}
            style={({ pressed }) => [styles.dangerRow, pressed && styles.pressed]}
          >
            <Ionicons color="#D64545" name={isOwner ? 'trash-outline' : 'exit-outline'} size={18} />
            <Text style={styles.dangerText}>{isOwner ? 'Leave or delete this room' : 'Leave'}</Text>
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
  editButton: {
    padding: 6,
  },
  editButtonText: {
    color: '#2FBF71',
    fontSize: 15,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.7,
  },
  loading: {
    marginTop: 40,
  },
  content: {
    paddingBottom: 48,
    paddingHorizontal: 20,
  },
  identity: {
    alignItems: 'center',
    paddingTop: 12,
  },
  picture: {
    borderRadius: 45,
    height: 90,
    width: 90,
  },
  pictureFallback: {
    alignItems: 'center',
    backgroundColor: '#E7E2DA',
    justifyContent: 'center',
  },
  name: {
    color: '#20232A',
    fontSize: 21,
    fontWeight: '700',
    marginTop: 14,
    textAlign: 'center',
  },
  about: {
    color: '#656A73',
    fontSize: 14,
    marginTop: 6,
    textAlign: 'center',
  },
  nameInput: {
    borderBottomColor: '#E3DED5',
    borderBottomWidth: StyleSheet.hairlineWidth,
    color: '#20232A',
    fontSize: 19,
    fontWeight: '700',
    marginTop: 14,
    paddingVertical: 10,
    textAlign: 'center',
    width: '100%',
  },
  aboutInput: {
    borderBottomColor: '#E3DED5',
    borderBottomWidth: StyleSheet.hairlineWidth,
    color: '#656A73',
    fontSize: 14,
    minHeight: 60,
    paddingVertical: 10,
    textAlign: 'center',
    width: '100%',
  },
  badge: {
    alignItems: 'center',
    backgroundColor: '#EFEAE2',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 5,
    marginTop: 10,
    paddingHorizontal: 11,
    paddingVertical: 5,
  },
  badgeText: {
    color: '#8D929C',
    fontSize: 12,
    fontWeight: '600',
  },
  editActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
  },
  secondaryButton: {
    borderColor: '#E3DED5',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  secondaryButtonText: {
    color: '#363A42',
    fontSize: 14,
    fontWeight: '700',
  },
  primaryButton: {
    backgroundColor: '#2FBF71',
    borderRadius: 999,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  primaryButtonDisabled: {
    backgroundColor: '#C9C4BB',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  sectionTitle: {
    color: '#20232A',
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 6,
    marginTop: 28,
  },
  memberRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 9,
  },
  memberRole: {
    color: '#8D929C',
    fontSize: 11,
    marginTop: 1,
  },
  noMembers: {
    color: '#8D929C',
    fontSize: 13,
    paddingVertical: 14,
  },
  memberSearch: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
    marginTop: 6,
    paddingHorizontal: 12,
  },
  memberSearchInput: {
    color: '#20232A',
    flex: 1,
    fontSize: 14,
    paddingVertical: 9,
  },
  addRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 11,
  },
  addText: {
    color: '#1F9D5B',
    fontSize: 14,
    fontWeight: '700',
  },
  unbanButton: {
    borderColor: '#E7E2DA',
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  unbanText: {
    color: '#363A42',
    fontSize: 12,
    fontWeight: '700',
  },
  modalBackdrop: {
    backgroundColor: 'rgba(32, 35, 42, 0.45)',
    flex: 1,
    justifyContent: 'flex-end',
  },
  privacySection: {
    marginTop: 26,
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
  sheet: {
    backgroundColor: '#F7F4EF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
    paddingBottom: 24,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  sheetHandle: {
    alignSelf: 'center',
    backgroundColor: '#D4D7DC',
    borderRadius: 2,
    height: 4,
    marginBottom: 10,
    width: 40,
  },
  sheetTitle: {
    color: '#20232A',
    fontSize: 17,
    fontWeight: '800',
    marginBottom: 10,
  },
  sheetHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  sheetClose: {
    alignItems: 'center',
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  sheetRow: {
    borderTopColor: '#E7E2DA',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 14,
  },
  sheetRowText: {
    color: '#20232A',
    fontSize: 15,
    fontWeight: '600',
  },
  sheetRowDestructive: {
    color: '#C0392B',
  },
  sheetSearch: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
    paddingHorizontal: 12,
  },
  sheetSearchInput: {
    color: '#20232A',
    flex: 1,
    fontSize: 15,
    paddingVertical: 9,
  },
  sheetList: {
    marginBottom: 12,
  },
  sheetEmpty: {
    color: '#8D929C',
    fontSize: 13,
    paddingVertical: 24,
    textAlign: 'center',
  },
  personRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 8,
  },
  personName: {
    color: '#20232A',
    flex: 1,
    fontSize: 15,
  },
  memberAvatar: {
    borderRadius: 20,
    height: 40,
    width: 40,
  },
  memberAvatarFallback: {
    alignItems: 'center',
    backgroundColor: '#E7E2DA',
    justifyContent: 'center',
  },
  memberInitial: {
    color: '#656A73',
    fontSize: 15,
    fontWeight: '700',
  },
  memberCopy: {
    flex: 1,
    minWidth: 0,
  },
  memberName: {
    color: '#20232A',
    fontSize: 15,
  },
  ownerBadge: {
    backgroundColor: '#EFEAE2',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  ownerBadgeText: {
    color: '#8D929C',
    fontSize: 11,
    fontWeight: '700',
  },
  dangerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
    marginTop: 32,
    paddingVertical: 12,
  },
  dangerText: {
    color: '#D64545',
    fontSize: 15,
    fontWeight: '700',
  },
});
