// Adapted from EvanBacon/chat-template (MIT)
/**
 * The app's drawer (iOS, Android), forked from react-native-drawer-layout
 * by the template: left side, LTR, a pan from the left edge opens it, a
 * pan anywhere or a tap on the content closes it.
 *
 * ```text
 * iOS      "back": the drawer lies behind; the content (rounded corners)
 *          slides right off it, the drawer grows from 95 % to full size
 * Android  "front": Material 3 modal navigation drawer; the sheet slides
 *          in over the content, a 32 % scrim behind it, Back closes it
 * ```
 */
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import {
  BackHandler,
  Keyboard,
  Pressable,
  View,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  ReduceMotion,
  interpolate,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

/** Reanimated takes hook dependencies on the web only; on native they're
 * ignored and warn on every render. */
const webDeps = <T extends unknown[]>(deps: T): T | undefined =>
  process.env.EXPO_OS === 'web' ? deps : undefined;

const APPROX_APP_BAR_HEIGHT = 56;
const DEFAULT_DRAWER_WIDTH = 360;
const SWIPE_EDGE_WIDTH = 32;
const SWIPE_MIN_OFFSET = 5;
const SWIPE_MIN_DISTANCE = 60;
const SWIPE_MIN_VELOCITY = 500;
const PROGRESS_EPSILON = 0.05;

const ios = process.env.EXPO_OS === 'ios';
const FRONT = process.env.EXPO_OS === 'android';

function drawerWidthFor(layoutWidth: number): number {
  return Math.min(layoutWidth - APPROX_APP_BAR_HEIGHT, DEFAULT_DRAWER_WIDTH);
}

const minmax = (value: number, start: number, end: number) => {
  'worklet';
  return Math.min(Math.max(value, start), end);
};

export interface DrawerLayoutProps {
  open: boolean;
  /** Stable callbacks (useCallback): the gesture is rebuilt when they change. */
  onOpen: () => void;
  onClose: () => void;
  drawerContent: ReactNode;
  /** Off on pushed screens: the left edge is the system's back swipe. */
  swipeEnabled?: boolean;
  children: ReactNode;
}

export function DrawerLayout({
  open,
  onOpen,
  onClose,
  drawerContent,
  swipeEnabled = true,
  children,
}: DrawerLayoutProps) {
  const { width: layoutWidth } = useWindowDimensions();
  const drawerWidth = drawerWidthFor(layoutWidth);

  const translationX = useSharedValue(open ? 0 : -drawerWidth);
  const startX = useSharedValue(0);
  const openValue = useSharedValue(open);

  const toggleDrawer = useCallback(
    (isOpen: boolean, velocity?: number) => {
      'worklet';
      translationX.set(
        withSpring(isOpen ? 0 : -drawerWidth, {
          velocity,
          stiffness: 1000,
          damping: 500,
          mass: 3,
          overshootClamping: true,
          reduceMotion: ReduceMotion.Never,
        }),
      );
      scheduleOnRN(isOpen ? onOpen : onClose);
    },
    [drawerWidth, onOpen, onClose, translationX],
  );

  // Follow the `open` prop.
  useEffect(() => {
    openValue.set(open);
    toggleDrawer(open);
    if (open) Keyboard.dismiss();
  }, [open, toggleDrawer, openValue]);

  // Android: Back closes an open drawer first.
  useEffect(() => {
    if (!open) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [open, onClose]);

  const onGestureBegin = useCallback(() => Keyboard.dismiss(), []);
  const onGestureFinish = useCallback(() => {
    if (process.env.EXPO_OS !== 'web')
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const pan = useMemo(() => {
    const gesture = Gesture.Pan()
      .onBegin(() => {
        'worklet';
        startX.set(translationX.get());
      })
      .onStart(() => {
        'worklet';
        scheduleOnRN(onGestureBegin);
      })
      .onChange((event) => {
        'worklet';
        translationX.set(
          minmax(startX.get() + event.translationX, -drawerWidth, 0),
        );
      })
      .onEnd((event) => {
        'worklet';
        const flung =
          (Math.abs(event.translationX) > SWIPE_MIN_OFFSET &&
            Math.abs(event.velocityX) > SWIPE_MIN_VELOCITY) ||
          Math.abs(event.translationX) > SWIPE_MIN_DISTANCE;
        const nextOpen = flung
          ? (event.velocityX === 0 ? event.translationX : event.velocityX) > 0
          : openValue.get();
        toggleDrawer(nextOpen, event.velocityX);
        scheduleOnRN(onGestureFinish);
      })
      .activeOffsetX([-SWIPE_MIN_OFFSET, SWIPE_MIN_OFFSET])
      .failOffsetY([-SWIPE_MIN_OFFSET, SWIPE_MIN_OFFSET])
      .enabled(swipeEnabled || open);
    // Closed: only from the left edge. Open: from anywhere.
    if (!open) gesture.hitSlop({ left: 0, width: SWIPE_EDGE_WIDTH });
    return gesture;
  }, [
    drawerWidth,
    onGestureBegin,
    onGestureFinish,
    open,
    openValue,
    startX,
    swipeEnabled,
    toggleDrawer,
    translationX,
  ]);

  const translateX = useDerivedValue(() =>
    minmax(translationX.value, -drawerWidth, 0),
  );
  const progress = useDerivedValue(() =>
    drawerWidth === 0
      ? 0
      : interpolate(translateX.value, [-drawerWidth, 0], [0, 1]),
  );

  const contentStyle = useAnimatedStyle(
    () =>
      FRONT
        ? {}
        : {
            zIndex: translateX.value === -drawerWidth ? 0 : 2,
            transform: [{ translateX: translateX.value + drawerWidth }],
          },
    webDeps([drawerWidth, translateX]),
  );

  const drawerStyle = useAnimatedStyle(
    () =>
      FRONT
        ? {
            zIndex: 3,
            transform: [{ translateX: translateX.value }],
          }
        : {
            // Forces a commit to the shadow tree so its pressables work.
            zIndex: translateX.value === -drawerWidth ? -1 : 0,
            transform: [
              {
                scale: interpolate(
                  drawerWidth === 0
                    ? 0
                    : (translateX.value + drawerWidth) / drawerWidth,
                  [0, 1],
                  [0.95, 1],
                ),
              },
            ],
          },
    webDeps([drawerWidth, translateX]),
  );

  return (
    <GestureDetector gesture={pan}>
      <Animated.View className="flex-1 overflow-hidden bg-sidebar">
        <Animated.View
          className="flex-1 overflow-hidden"
          style={[
            ios
              ? {
                  borderRadius: 53,
                  borderCurve: 'continuous',
                  boxShadow: '0px 0px 16px rgba(0, 0, 0, 0.15)',
                }
              : null,
            contentStyle,
          ]}
        >
          <View
            aria-hidden={open}
            importantForAccessibility={open ? 'no-hide-descendants' : 'auto'}
            className="flex-1 overflow-hidden"
          >
            {children}
          </View>
          <Overlay progress={progress} onPress={() => toggleDrawer(false)} />
        </Animated.View>
        <Animated.View
          aria-hidden={!open}
          importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
          className={
            FRONT
              ? 'absolute top-0 bottom-0 overflow-hidden rounded-r-2xl bg-sidebar'
              : 'absolute top-0 bottom-0'
          }
          style={[
            { width: drawerWidth, transformOrigin: 'left top' },
            drawerStyle,
          ]}
        >
          {drawerContent}
          {FRONT ? null : <DrawerDim progress={progress} />}
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

/** Over the content while the drawer shows: a tap closes it. */
function Overlay({
  progress,
  onPress,
}: {
  progress: SharedValue<number>;
  onPress: () => void;
}) {
  const style = useAnimatedStyle(
    () => ({ opacity: FRONT ? progress.value * 0.32 : progress.value }),
    webDeps([progress]),
  );
  const props = useAnimatedProps(
    () => {
      const active = progress.value > PROGRESS_EPSILON;
      return {
        pointerEvents: active ? 'auto' : 'none',
        'aria-hidden': !active,
      } as const;
    },
    webDeps([progress]),
  );
  return (
    <Animated.View
      style={style}
      className={
        FRONT ? 'absolute inset-0 bg-black' : 'absolute inset-0 bg-card/80'
      }
      animatedProps={props}
    >
      <Pressable
        onPress={onPress}
        className="flex-1"
        accessibilityRole="button"
        accessibilityLabel="Close menu"
      />
    </Animated.View>
  );
}

/** iOS: the drawer darkens while it is still small behind the content. */
function DrawerDim({ progress }: { progress: SharedValue<number> }) {
  const style = useAnimatedStyle(
    () => {
      const parentScale = interpolate(progress.value, [0, 1], [0.95, 1]);
      return {
        opacity: interpolate(progress.value, [0, 1], [0.5, 0]),
        transform: [{ scale: 1 / parentScale }],
      };
    },
    webDeps([progress]),
  );
  return (
    <Animated.View
      pointerEvents="none"
      className="absolute inset-0 bg-black"
      style={[{ transformOrigin: 'left top' }, style]}
    />
  );
}
