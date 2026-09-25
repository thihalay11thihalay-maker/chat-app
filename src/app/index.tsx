import type { ConfirmationResult } from 'firebase/auth';
import { useState } from 'react';
import {
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

import {
  confirmPhoneSignIn,
  getAuthErrorMessage,
  signInWithEmail,
  signInWithGoogle,
  signInWithPhoneNumber,
  signUpWithEmail,
} from '@/lib/firebase';

type AuthMode = 'login' | 'signup';

export default function HomeScreen() {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [phoneConfirmation, setPhoneConfirmation] = useState<ConfirmationResult | null>(null);
  const [isPhoneAuth, setIsPhoneAuth] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isLogin = mode === 'login';

  const handleEmailAuth = async () => {
    const normalizedEmail = email.trim();

    if (!normalizedEmail || !password) {
      setStatusMessage('Enter your email and password to continue.');
      return;
    }

    setIsSubmitting(true);
    setStatusMessage('');

    try {
      if (isLogin) {
        await signInWithEmail(normalizedEmail, password);
        setStatusMessage('You are now logged in.');
      } else {
        await signUpWithEmail(normalizedEmail, password);
        setStatusMessage('Your account is ready.');
      }
    } catch (error) {
      setStatusMessage(getAuthErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePhoneAuth = async () => {
    if (phoneConfirmation) {
      if (!verificationCode.trim()) {
        setStatusMessage('Enter the verification code from your SMS.');
        return;
      }

      setIsSubmitting(true);
      setStatusMessage('');

      try {
        await confirmPhoneSignIn(phoneConfirmation, verificationCode.trim());
        setPhoneConfirmation(null);
        setVerificationCode('');
        setStatusMessage('You are now logged in with your phone.');
      } catch (error) {
        setStatusMessage(getAuthErrorMessage(error));
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (!phoneNumber.trim()) {
      setStatusMessage('Enter your phone number with its country code.');
      return;
    }

    setIsSubmitting(true);
    setStatusMessage('');

    try {
      const confirmation = await signInWithPhoneNumber(phoneNumber.trim());
      setPhoneConfirmation(confirmation);
      setStatusMessage('A verification code was sent to your phone.');
    } catch (error) {
      setStatusMessage(getAuthErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoogleAuth = async () => {
    setIsSubmitting(true);
    setStatusMessage('');

    try {
      await signInWithGoogle();
      setStatusMessage('You are now logged in with Google.');
    } catch (error) {
      setStatusMessage(getAuthErrorMessage(error));
    } finally {
      setIsSubmitting(false);
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
            <View style={styles.brandMark}>
              <View style={styles.brandDot} />
              <Text style={styles.brandText}>convo</Text>
            </View>

            <View style={styles.header}>
              <Text style={styles.eyebrow}>{isLogin ? 'WELCOME BACK' : 'GET STARTED'}</Text>
              <Text style={styles.title}>{isLogin ? 'Log in to your space' : 'Create your account'}</Text>
              <Text style={styles.subtitle}>
                {isLogin
                  ? 'Your conversations are waiting for you.'
                  : 'Join the conversation and make it yours.'}
              </Text>
            </View>

            <View style={styles.form}>
              {isPhoneAuth ? (
                <>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.label}>{phoneConfirmation ? 'Verification code' : 'Phone number'}</Text>
                    <TextInput
                      autoCapitalize="none"
                      keyboardType={phoneConfirmation ? 'number-pad' : 'phone-pad'}
                      onChangeText={phoneConfirmation ? setVerificationCode : setPhoneNumber}
                      placeholder={phoneConfirmation ? '123456' : '+1 555 123 4567'}
                      placeholderTextColor="#8D929C"
                      style={styles.input}
                      value={phoneConfirmation ? verificationCode : phoneNumber}
                    />
                  </View>
                  <View nativeID="recaptcha-container" style={styles.recaptchaContainer} />
                </>
              ) : (
                <>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.label}>Email address</Text>
                    <TextInput
                      autoCapitalize="none"
                      autoComplete="email"
                      keyboardType="email-address"
                      onChangeText={setEmail}
                      placeholder="you@example.com"
                      placeholderTextColor="#8D929C"
                      style={styles.input}
                      value={email}
                    />
                  </View>

                  <View style={styles.fieldGroup}>
                    <View style={styles.passwordLabelRow}>
                      <Text style={styles.label}>Password</Text>
                      {isLogin && <Text style={styles.forgotText}>Forgot password?</Text>}
                    </View>
                    <TextInput
                      autoComplete="password"
                      onChangeText={setPassword}
                      placeholder="Enter your password"
                      placeholderTextColor="#8D929C"
                      secureTextEntry
                      style={styles.input}
                      value={password}
                    />
                  </View>
                </>
              )}

              <Pressable
                accessibilityRole="button"
                disabled={isSubmitting}
                onPress={isPhoneAuth ? handlePhoneAuth : handleEmailAuth}
                style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
              >
                <Text style={styles.primaryButtonText}>
                  {isSubmitting
                    ? 'Please wait...'
                    : isPhoneAuth
                      ? phoneConfirmation ? 'Verify phone' : 'Send code'
                      : isLogin ? 'Log in' : 'Create account'}
                </Text>
                <Text style={styles.buttonArrow}>{'->'}</Text>
              </Pressable>

              {statusMessage ? <Text style={styles.statusMessage}>{statusMessage}</Text> : null}

              <View style={styles.dividerRow}>
                <View style={styles.divider} />
                <Text style={styles.dividerText}>OR CONTINUE WITH</Text>
                <View style={styles.divider} />
              </View>

              <View style={styles.socialRow}>
                <Pressable
                  accessibilityRole="button"
                  onPress={handleGoogleAuth}
                  style={({ pressed }) => [styles.socialButton, pressed && styles.pressed]}
                >
                  <Text style={styles.googleMark}>G</Text>
                  <Text style={styles.socialButtonText}>Google</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setIsPhoneAuth(true);
                    setStatusMessage('');
                  }}
                  style={({ pressed }) => [styles.socialButton, pressed && styles.pressed]}
                >
                  <Text style={styles.phoneMark}>+1</Text>
                  <Text style={styles.socialButtonText}>Phone</Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.switchRow}>
              <Text style={styles.switchPrompt}>
                {isLogin ? "Don't have an account?" : 'Already have an account?'}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setStatusMessage('');
                  setIsPhoneAuth(false);
                  setPhoneConfirmation(null);
                  setMode(isLogin ? 'signup' : 'login');
                }}
              >
                <Text style={styles.switchAction}>{isLogin ? 'Sign up' : 'Log in'}</Text>
              </Pressable>
            </View>

            <Text style={styles.termsText}>
              By continuing, you agree to our Terms of Service and Privacy Policy.
            </Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F7F4EF',
  },
  safeArea: {
    flex: 1,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 28,
    paddingVertical: 28,
  },
  brandMark: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 70,
  },
  brandDot: {
    backgroundColor: '#E56B4C',
    borderRadius: 6,
    height: 12,
    width: 12,
  },
  brandText: {
    color: '#20232A',
    fontFamily: Platform.select({ web: 'var(--font-display)', default: undefined }),
    fontSize: 21,
    fontWeight: '700',
    letterSpacing: 0,
  },
  header: {
    marginBottom: 34,
  },
  eyebrow: {
    color: '#E56B4C',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.8,
    marginBottom: 12,
  },
  title: {
    color: '#20232A',
    fontFamily: Platform.select({ web: 'var(--font-display)', default: undefined }),
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: 0,
    lineHeight: 40,
    marginBottom: 10,
  },
  subtitle: {
    color: '#656A73',
    fontSize: 16,
    lineHeight: 24,
  },
  form: {
    gap: 20,
  },
  fieldGroup: {
    gap: 9,
  },
  passwordLabelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  label: {
    color: '#363A42',
    fontSize: 13,
    fontWeight: '700',
  },
  forgotText: {
    color: '#E56B4C',
    fontSize: 13,
    fontWeight: '700',
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 12,
    borderWidth: 1,
    color: '#20232A',
    fontSize: 16,
    height: 54,
    paddingHorizontal: 16,
  },
  recaptchaContainer: {
    minHeight: 78,
    width: '100%',
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#20232A',
    borderRadius: 12,
    flexDirection: 'row',
    height: 56,
    justifyContent: 'center',
    marginTop: 2,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  buttonArrow: {
    color: '#FFFFFF',
    fontSize: 18,
    marginLeft: 12,
  },
  pressed: {
    opacity: 0.78,
  },
  statusMessage: {
    color: '#3D765B',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  dividerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    marginVertical: 3,
  },
  divider: {
    backgroundColor: '#E2DDD5',
    flex: 1,
    height: 1,
  },
  dividerText: {
    color: '#9B9A96',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  socialRow: {
    flexDirection: 'row',
    gap: 12,
  },
  socialButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E7E2DA',
    borderRadius: 12,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: 10,
    height: 52,
    justifyContent: 'center',
  },
  googleMark: {
    color: '#4285F4',
    fontSize: 19,
    fontWeight: '800',
  },
  phoneMark: {
    color: '#E56B4C',
    fontSize: 13,
    fontWeight: '800',
  },
  socialButtonText: {
    color: '#363A42',
    fontSize: 14,
    fontWeight: '700',
  },
  switchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 'auto',
    paddingTop: 54,
  },
  switchPrompt: {
    color: '#656A73',
    fontSize: 14,
  },
  switchAction: {
    color: '#E56B4C',
    fontSize: 14,
    fontWeight: '800',
    marginLeft: 5,
  },
  termsText: {
    color: '#A4A19B',
    fontSize: 11,
    lineHeight: 17,
    marginTop: 24,
    textAlign: 'center',
  },
});
