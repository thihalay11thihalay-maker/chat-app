import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text } from 'react-native';

/**
 * One of the two answers to "who can join this room".
 *
 * The chosen one is filled rather than merely ticked, because a tick on a greyed row and a tick on an
 * active one are the same mark at a glance, and this is a setting whose whole job is to be read at a
 * glance. The inactive one is what the row offers: pressing it is how the room changes.
 *
 * Its own component because two screens answer this question -- the one that makes a room and the one
 * that changes it -- and two copies of the same pair of buttons is how the two end up disagreeing
 * about what "private" looks like.
 */
export function PrivacyOption({
  active,
  disabled,
  icon,
  label,
  onPress,
}: {
  active: boolean;
  /** Not offered to somebody who cannot change it: an admin sees the answer without being able to move it. */
  disabled?: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="radio"
      accessibilityState={{ checked: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.privacyOption,
        active && styles.privacyOptionActive,
        pressed && styles.pressed,
      ]}
    >
      <Ionicons color={active ? '#FFFFFF' : '#6C7079'} name={icon} size={16} />
      <Text style={[styles.privacyOptionText, active && styles.privacyOptionTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  privacyOption: {
    alignItems: 'center',
    borderColor: '#E7E2DA',
    borderRadius: 12,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 11,
  },
  privacyOptionActive: {
    backgroundColor: '#2FBF71',
    borderColor: '#2FBF71',
  },
  privacyOptionText: {
    color: '#6C7079',
    fontSize: 14,
    fontWeight: '700',
  },
  privacyOptionTextActive: {
    color: '#FFFFFF',
  },
  pressed: {
    opacity: 0.7,
  },
});
