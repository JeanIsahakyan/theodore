/**
 * The top-level error boundary: a render crash is logged as
 * `ui.render_crash` (message, stack, component stack; never props or
 * text), and the screen offers to try again.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { reportJsError } from './errors';

interface Props {
  children: ReactNode;
}

interface State {
  crashed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportJsError('ui.render_crash', error, {
      component_stack: (info.componentStack ?? '').slice(0, 4000),
    });
  }

  render(): ReactNode {
    if (!this.state.crashed) return this.props.children;
    return (
      <View style={styles.root} accessibilityLabel="Something went wrong">
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.hint}>
          The error was noted on this device. Settings → About → Copy
          diagnostics attaches it to a report.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => this.setState({ crashed: false })}
          style={styles.button}
        >
          <Text style={styles.label}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}

// Plain colors: the theme itself may be what crashed.
const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    backgroundColor: '#F2F2F7',
  },
  title: { fontSize: 20, fontWeight: '600', color: '#111' },
  hint: { fontSize: 14, textAlign: 'center', color: '#555', maxWidth: 320 },
  button: {
    marginTop: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: '#2F74C8',
  },
  label: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
