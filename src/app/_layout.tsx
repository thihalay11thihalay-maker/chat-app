import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider } from 'expo-router';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, useColorScheme, View } from 'react-native';

import { getFirebaseAuth, getFirebaseDb } from '@/lib/firebase';

export default function RootLayout() {
	const colorScheme = useColorScheme();
	const [isCheckingAuth, setIsCheckingAuth] = useState(true);

	useEffect(() => {
		let isMounted = true;

		const unsubscribe = onAuthStateChanged(getFirebaseAuth(), async (user) => {
			if (!user) {
				if (isMounted) {
					setIsCheckingAuth(false);
					router.replace('/login');
				}
				return;
			}

			try {
				const profileSnapshot = await getDoc(doc(getFirebaseDb(), 'users', user.uid));
				const profileComplete = profileSnapshot.exists()
					&& profileSnapshot.data().profileComplete === true;

				if (isMounted) {
					setIsCheckingAuth(false);
					router.replace(profileComplete ? '/chat' : '/onboarding');
				}
			} catch (error) {
				console.error('Failed to load the user profile:', error);
				if (isMounted) {
					setIsCheckingAuth(false);
					router.replace('/onboarding');
				}
			}
		});

		return () => {
			isMounted = false;
			unsubscribe();
		};
	}, []);

	return (
		<ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
			{isCheckingAuth ? (
				<View style={styles.loadingScreen}>
					<ActivityIndicator color="#E56B4C" size="large" />
				</View>
			) : (
				<Stack screenOptions={{ headerShown: false }} />
			)}
		</ThemeProvider>
	);
}

const styles = StyleSheet.create({
	loadingScreen: {
		alignItems: 'center',
		backgroundColor: '#F7F4EF',
		flex: 1,
		justifyContent: 'center',
	},
});
