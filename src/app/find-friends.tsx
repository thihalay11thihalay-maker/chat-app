import { Ionicons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// The slider spans the age range people can be filtered to, so both ends and both thumbs live
// on the same numbers and neither can be dragged past them.
const MIN_AGE = 18;
const MAX_AGE = 80;

export default function FindFriendsScreen() {
  const [minimumAge, setMinimumAge] = useState(MIN_AGE);
  const [maximumAge, setMaximumAge] = useState(MAX_AGE);

  // Two independent thumbs can cross, which would read as an age range of 60 to 24. Each one
  // stops at the other instead, so the range is always a real one.
  const changeMinimumAge = (value: number) => {
    setMinimumAge(Math.min(Math.round(value), maximumAge));
  };

  const changeMaximumAge = (value: number) => {
    setMaximumAge(Math.max(Math.round(value), minimumAge));
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>MEET SOMEONE NEW</Text>
            <Text style={styles.title}>Find friends</Text>
          </View>

          <Pressable
            accessibilityLabel="Refresh suggestions"
            accessibilityRole="button"
            style={({ pressed }) => [styles.refreshButton, pressed && styles.pressed]}
          >
            <Ionicons color="#E56B4C" name="refresh-outline" size={22} />
          </Pressable>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Age range</Text>
            <Text style={styles.cardValue}>{`${minimumAge} - ${maximumAge}`}</Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Minimum age</Text>
            <Slider
              accessibilityLabel="Minimum age"
              maximumTrackTintColor="#E3DED5"
              maximumValue={MAX_AGE}
              minimumTrackTintColor="#E56B4C"
              minimumValue={MIN_AGE}
              onValueChange={changeMinimumAge}
              step={1}
              style={styles.slider}
              thumbTintColor="#E56B4C"
              value={minimumAge}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Maximum age</Text>
            <Slider
              accessibilityLabel="Maximum age"
              maximumTrackTintColor="#E3DED5"
              maximumValue={MAX_AGE}
              minimumTrackTintColor="#E56B4C"
              minimumValue={MIN_AGE}
              onValueChange={changeMaximumAge}
              step={1}
              style={styles.slider}
              thumbTintColor="#E56B4C"
              value={maximumAge}
            />
          </View>
        </View>

        <View style={styles.peopleHeader}>
          <Text style={styles.peopleTitle}>People to meet</Text>
          <Text style={styles.peopleCount}>{maximumAge - minimumAge + 1}</Text>
          <View style={styles.peopleBadge}>
            <Text style={styles.peopleBadgeText}>0</Text>
          </View>
        </View>

        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No friends to show yet</Text>
          <Text style={styles.emptyBody}>Widen the age range or come back later.</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  content: {
    paddingHorizontal: 18,
    paddingTop: 14,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  eyebrow: {
    color: '#E56B4C',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.4,
    marginBottom: 6,
  },
  title: {
    color: '#20232A',
    fontSize: 28,
    fontWeight: '800',
  },
  refreshButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    marginLeft: 12,
    width: 44,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 18,
  },
  cardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  cardTitle: {
    color: '#20232A',
    fontSize: 16,
    fontWeight: '800',
  },
  cardValue: {
    color: '#E56B4C',
    fontSize: 15,
    fontWeight: '800',
  },
  field: {
    marginTop: 10,
  },
  fieldLabel: {
    color: '#656A73',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2,
  },
  slider: {
    height: 34,
    width: '100%',
  },
  peopleHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 24,
  },
  peopleTitle: {
    color: '#20232A',
    fontSize: 17,
    fontWeight: '800',
  },
  peopleCount: {
    color: '#8D929C',
    fontSize: 14,
    fontWeight: '700',
  },
  peopleBadge: {
    alignItems: 'center',
    backgroundColor: '#E56B4C',
    borderRadius: 9,
    height: 18,
    justifyContent: 'center',
    minWidth: 18,
    paddingHorizontal: 5,
  },
  peopleBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
  },
  empty: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingBottom: 90,
    paddingHorizontal: 30,
    paddingTop: 60,
  },
  emptyTitle: {
    color: '#20232A',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 6,
    textAlign: 'center',
  },
  emptyBody: {
    color: '#8D929C',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.7,
  },
});