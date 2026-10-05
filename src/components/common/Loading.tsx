import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { COLORS } from '../../lib/constants';

export const Loading = ({ size = 'large' }: { size?: 'small' | 'large' }) => {
  return (
    <View style={styles.container}>
      <ActivityIndicator size={size} color={COLORS.primary} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.background,
  },
});