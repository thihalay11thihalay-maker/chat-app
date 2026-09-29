import { ErrorInfo, PureComponent } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

type ErrorBoundaryProps = {
    children: React.ReactNode;
};

type ErrorBoundaryState = {
    error: Error | null;
};

/**
 * Without this, any render-time throw anywhere in the app tree produces a blank
 * white screen on native and an empty page on web. Showing the message turns an
 * invisible crash into a debuggable one.
 */
export class ErrorBoundary extends PureComponent<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('Unhandled UI error:', error, errorInfo.componentStack);
    }

    private readonly handleReset = () => {
        this.setState({ error: null });
    };

    render() {
        const { error } = this.state;
        const { children } = this.props;

        if (!error) {
            return children;
        }

        return (
            <View style={styles.container}>
                <Text style={styles.title}>Something went wrong</Text>
                <Text style={styles.message}>{error.message}</Text>
                <Pressable onPress={this.handleReset} style={styles.button}>
                    <Text style={styles.buttonText}>Try again</Text>
                </Pressable>
            </View>
        );
    }
}

const styles = StyleSheet.create({
    container: {
        alignItems: 'center',
        backgroundColor: '#F7F4EF',
        flex: 1,
        justifyContent: 'center',
        padding: 28,
    },
    title: {
        color: '#20232A',
        fontSize: 22,
        fontWeight: '800',
        marginBottom: 12,
        textAlign: 'center',
    },
    message: {
        color: '#B84141',
        fontSize: 14,
        lineHeight: 20,
        marginBottom: 20,
        textAlign: 'center',
    },
    button: {
        backgroundColor: '#20232A',
        borderRadius: 10,
        paddingHorizontal: 20,
        paddingVertical: 12,
    },
    buttonText: {
        color: '#FFFFFF',
        fontSize: 14,
        fontWeight: '800',
    },
});
