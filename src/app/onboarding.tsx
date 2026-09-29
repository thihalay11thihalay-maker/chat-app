import DateTimePicker, {
  DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { router } from 'expo-router';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { useState } from 'react';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';

const interests = [
  'Action',
  'Games',
  'Football',
  'Music',
  'Travel',
  'Art',
  'Reading',
  'Movies',
  'Cooking',
  'Photography',
  'Fitness',
  'Technology',
  'Fashion',
  'Nature',
  'Dancing',
  'Writing',
];

const interestedInOptions = ['Male', 'Female', 'Homosexual'];

export default function OnboardingScreen() {
  const [fullName, setFullName] = useState('');
  const [age, setAge] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState(new Date(2000, 0, 1));
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [selectedInterests, setSelectedInterests] = useState<string[]>([]);
  const [interestedIn, setInterestedIn] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const userId = getFirebaseAuth().currentUser?.uid ?? 'guest';
  const profilePictureUrl = `https://i.pravatar.cc/150?u=${userId}`;

  const toggleInterest = (interest: string) => {
    setSelectedInterests((currentInterests) => currentInterests.includes(interest)
      ? currentInterests.filter((item) => item !== interest)
      : [...currentInterests, interest]);
  };

  const handleDateChange = (event: DateTimePickerEvent, selectedDate?: Date) => {
    if (Platform.OS !== 'ios') {
      setShowDatePicker(false);
    }

    if (event.type === 'set' && selectedDate) {
      setDateOfBirth(selectedDate);
    }
  };

  const handleSave = async () => {
    const user = getFirebaseAuth().currentUser;

    if (!user) {
      Alert.alert('Login required', 'Please log in before completing your profile.');
      return;
    }

    if (!fullName.trim() || !age.trim() || !city.trim() || !country.trim()) {
      Alert.alert('Missing information', 'Please complete your name, age, city, and country.');
      return;
    }

    setIsSaving(true);
    setStatusMessage('');

    try {
      await setDoc(doc(getFirebaseDb(), 'users', user.uid), {
        age: Number(age),
        city: city.trim(),
        country: country.trim(),
        dateOfBirth: dateOfBirth.toISOString(),
        displayName: fullName.trim(),
        interestedIn,
        interests: selectedInterests,
        profileComplete: true,
        profilePictureUrl,
        updatedAt: serverTimestamp(),
        userId: user.uid,
      }, { merge: true });

      router.replace('/chat' as never);
    } catch (error) {
      Alert.alert(
        'Could not save profile',
        error instanceof Error ? error.message : 'Please try again.',
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.keyboardView}
        >
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.progressRow}>
              <Text style={styles.progressLabel}>PROFILE SETUP</Text>
              <Text style={styles.progressStep}>1 OF 1</Text>
            </View>

            <View style={styles.header}>
              <Text style={styles.title}>Make it yours</Text>
              <Text style={styles.subtitle}>
                A few details will help us shape your space around you.
              </Text>
            </View>

            <View style={styles.avatarSection}>
              <Image source={{ uri: profilePictureUrl }} style={styles.avatar} />
              <View style={styles.avatarCopy}>
                <Text style={styles.sectionTitle}>Profile picture</Text>
                <Text style={styles.helperText}>Your picture is ready to use.</Text>
              </View>
            </View>

            <View style={styles.form}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Full name</Text>
                <TextInput
                  autoCapitalize="words"
                  onChangeText={setFullName}
                  placeholder="Enter your full name"
                  placeholderTextColor="#8D929C"
                  style={styles.textInput}
                  value={fullName}
                />
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Age</Text>
                <TextInput
                  keyboardType="number-pad"
                  maxLength={3}
                  onChangeText={setAge}
                  placeholder="Enter your age"
                  placeholderTextColor="#8D929C"
                  style={styles.textInput}
                  value={age}
                />
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Date of birth</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setShowDatePicker(true)}
                  style={({ pressed }) => [styles.input, pressed && styles.pressed]}
                >
                  <Text style={styles.inputText}>{dateOfBirth.toLocaleDateString()}</Text>
                  <Text style={styles.calendarIcon}>*</Text>
                </Pressable>
                {showDatePicker ? (
                  <DateTimePicker
                    display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                    maximumDate={new Date()}
                    mode="date"
                    onChange={handleDateChange}
                    value={dateOfBirth}
                  />
                ) : null}
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>City</Text>
                <TextInput
                  autoCapitalize="words"
                  onChangeText={setCity}
                  placeholder="Enter your city"
                  placeholderTextColor="#8D929C"
                  style={styles.textInput}
                  value={city}
                />
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Country</Text>
                <TextInput
                  autoCapitalize="words"
                  onChangeText={setCountry}
                  placeholder="Enter your country"
                  placeholderTextColor="#8D929C"
                  style={styles.textInput}
                  value={country}
                />
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>What is your hobby?</Text>
                <Text style={styles.helperText}>Choose as many as you like.</Text>
                <View style={styles.interestsGrid}>
                  {interests.map((interest) => {
                    const isSelected = selectedInterests.includes(interest);
                    return (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected: isSelected }}
                        key={interest}
                        onPress={() => toggleInterest(interest)}
                        style={({ pressed }) => [
                          styles.interestButton,
                          isSelected && styles.interestButtonSelected,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text style={[styles.interestText, isSelected && styles.interestTextSelected]}>
                          {interest}
                        </Text>
                        {isSelected ? <Text style={styles.checkmark}>+</Text> : null}
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Are you interested in?</Text>
                <Text style={styles.helperText}>Choose one option.</Text>
                <View style={styles.interestsGrid}>
                  {interestedInOptions.map((option) => {
                    const isSelected = interestedIn === option;
                    return (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected: isSelected }}
                        key={option}
                        onPress={() => setInterestedIn(option)}
                        style={({ pressed }) => [
                          styles.interestButton,
                          isSelected && styles.interestButtonSelected,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text style={[styles.interestText, isSelected && styles.interestTextSelected]}>
                          {option}
                        </Text>
                        {isSelected ? <Text style={styles.checkmark}>+</Text> : null}
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              <Pressable
                accessibilityRole="button"
                disabled={isSaving}
                onPress={handleSave}
                style={({ pressed }) => [styles.saveButton, pressed && styles.pressed]}
              >
                                <Text style={styles.saveButtonText}>
                  {isSaving ? 'Saving...' : 'Save & Continue'}
                </Text>
                <Text style={styles.buttonArrow}>{'->'}</Text>
              </Pressable>

              {statusMessage ? <Text style={styles.statusMessage}>{statusMessage}</Text> : null}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#F7F4EF',
    flex: 1,
  },
  safeArea: {
    alignSelf: 'center',
    flex: 1,
    maxWidth: 560,
    width: '100%',
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 28,
    paddingVertical: 28,
  },
  progressRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 44,
  },
  progressLabel: {
    color: '#E56B4C',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.8,
  },
  progressStep: {
    color: '#9B9A96',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  header: {
    marginBottom: 34,
  },
  title: {
    color: '#20232A',
    fontSize: 36,
    fontWeight: '800',
    lineHeight: 42,
    marginBottom: 10,
  },
  subtitle: {
    color: '#656A73',
    fontSize: 16,
    lineHeight: 24,
  },
  avatarSection: {
    alignItems: 'center',
    backgroundColor: '#FFFDFC',
    borderColor: '#E7E2DA',
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: 28,
    padding: 16,
  },
  avatar: {
    backgroundColor: '#E7E2DA',
    borderRadius: 36,
    height: 72,
    width: 72,
  },
  avatarCopy: {
    flex: 1,
    marginLeft: 14,
  },
  sectionTitle: {
    color: '#20232A',
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 5,
  },
  helperText: {
    color: '#8D929C',
    fontSize: 13,
    lineHeight: 19,
  },
  form: {
    gap: 22,
  },
  fieldGroup: {
    gap: 9,
  },
  label: {
    color: '#363A42',
    fontSize: 13,
    fontWeight: '700',
  },
  input: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    height: 54,
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  inputText: {
    color: '#20232A',
    fontSize: 16,
  },
  calendarIcon: {
    color: '#E56B4C',
    fontSize: 20,
    fontWeight: '800',
  },
  textInput: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 12,
    borderWidth: 1,
    color: '#20232A',
    fontSize: 16,
    height: 54,
    paddingHorizontal: 16,
  },
  interestsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  interestButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 46,
    paddingHorizontal: 16,
  },
  interestButtonSelected: {
    backgroundColor: '#20232A',
    borderColor: '#20232A',
  },
  interestText: {
    color: '#363A42',
    fontSize: 14,
    fontWeight: '700',
  },
  interestTextSelected: {
    color: '#FFFFFF',
  },
  checkmark: {
    color: '#E56B4C',
    fontSize: 19,
    fontWeight: '800',
    marginLeft: 8,
  },
  saveButton: {
    alignItems: 'center',
    backgroundColor: '#E56B4C',
    borderRadius: 12,
    flexDirection: 'row',
    height: 56,
    justifyContent: 'center',
    marginTop: 4,
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  buttonArrow: {
    color: '#FFFFFF',
    fontSize: 18,
    marginLeft: 12,
  },
  statusMessage: {
    color: '#3D765B',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.78,
  },
});
