import { View, Text, Image, StyleSheet } from 'react-native';
import { getAvatarColor } from '../../lib/constants';

type AvatarProps = {
  name: string;
  photoUrl?: string;
  size?: number;
};

export const Avatar = ({ name, photoUrl, size = 40 }: AvatarProps) => {
  const color = getAvatarColor(name);
  const borderRadius = size / 2;

  return (
    <View
      style={[
        styles.container,
        {
          width: size,
          height: size,
          borderRadius,
          backgroundColor: color,
        },
      ]}
    >
      {photoUrl ? (
        <Image
          source={{ uri: photoUrl }}
          style={{ width: size, height: size, borderRadius }}
          resizeMode="cover"
        />
      ) : (
        <Text style={[styles.initial, { fontSize: size / 2.5 }]}>
          {name ? name[0].toUpperCase() : '?'}
        </Text>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  initial: {
    color: 'white',
    fontWeight: '700',
  },
});

export default Avatar;