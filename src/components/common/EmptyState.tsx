import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../../lib/constants';

export const EmptyState = ({ title, subtitle }: { title: string; subtitle?: string }) => {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: COLORS.placeholder,
    textAlign: 'center',
    marginTop: 8,
  },
});