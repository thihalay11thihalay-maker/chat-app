import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';

/**
 * A person's picture, with a light on it when that person is online.
 *
 * One component for this because it was being drawn four different ways: the chat list had a green dot,
 * the people list had a dot that was grey when offline, and the member list of a room had none at all.
 * Four versions of the same question is four chances to be wrong about the answer, and a grey dot that
 * says "offline" is worse than no dot at all -- it asserts something, from a heartbeat that might simply
 * have been missed.
 *
 * So the rule is the same everywhere: a green light on the corner of the picture, and nothing at all
 * otherwise. Not a grey dot, not a ring, not the word offline. A reader who cannot see a light is not
 * being told a person is not there; they are being told this build does not know, which is the truth
 * whenever presence is unavailable or the answer has not arrived yet.
 *
 * The light is at the bottom left. Bottom left rather than bottom right because the right corner is where
 * the chat list puts its unread count, and two badges on one corner is one too many.
 */
type PersonAvatarProps = {
  /**
   * Whether this person is online right now.
   *
   * Only `true` draws anything. `false` and `undefined` are the same answer on purpose: nobody has to
   * work out the difference between "known to be offline" and "not asked yet", because neither of them
   * has a light.
   */
  isOnline?: boolean;
  /** Used for the initial shown when there is no picture, and for the accessibility label. */
  name: string;
  /** Called when a picture fails to load, so the caller can remember not to try it again. */
  onPhotoError?: () => void;
  /** The picture. Empty or absent draws the initial instead, which beats a broken image box. */
  photoUrl?: string;
  /** The square of it. The light is sized from this, so it never looks pasted on. */
  size?: number;
};

export function PersonAvatar({
  isOnline,
  name,
  onPhotoError,
  photoUrl,
  size = 54,
}: PersonAvatarProps) {
  const dotSize = Math.max(11, Math.round(size * 0.26));
  const initial = name.charAt(0).toUpperCase() || '?';

  return (
    // Relative, because the light is placed against the picture rather than against whatever is next to
    // it: absolutely positioned against a row would put the light in the corner of the screen on a row
    // whose picture is only half the width.
    <View style={{ height: size, width: size }}>
      {photoUrl ? (
        <Image
          contentFit="cover"
          onError={onPhotoError}
          source={{ uri: photoUrl }}
          style={[styles.picture, { borderRadius: size / 2, height: size, width: size }]}
          transition={120}
        />
      ) : (
        <View
          style={[
            styles.fallback,
            { borderRadius: size / 2, height: size, width: size },
          ]}
        >
          <Text style={[styles.initial, { fontSize: Math.round(size * 0.37) }]}>{initial}</Text>
        </View>
      )}

      {isOnline ? (
        // Ringed in the page's own background so it reads as sitting on the picture rather than under it,
        // and lifted on Android so it is not painted behind the picture it belongs to.
        <View
          style={[
            styles.onlineDot,
            {
              borderRadius: dotSize / 2,
              height: dotSize,
              left: 0,
              width: dotSize,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  picture: {
    backgroundColor: '#E7E2DA',
  },
  fallback: {
    alignItems: 'center',
    backgroundColor: '#E7E2DA',
    justifyContent: 'center',
  },
  initial: {
    color: '#656A73',
    fontWeight: '800',
  },
  onlineDot: {
    backgroundColor: '#2FBF71',
    borderColor: '#F7F4EF',
    borderWidth: 2,
    bottom: 0,
    elevation: 2,
    position: 'absolute',
  },
});