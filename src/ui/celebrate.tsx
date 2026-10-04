/**
 * The moment a swap completes. Two coins, bitcoin and the local currency,
 * slide in from either side and meet in the middle (the swap), fuse into a
 * check, and throw off a ring of sparks (Pontspark). Plays once, with a
 * success haptic; people who turned animations off see the end state.
 */
import { Feather } from "@expo/vector-icons";
import React, { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Modal, Pressable, View } from "react-native";
import { create } from "zustand";

import { Text, success } from "./components";
import { useColors } from "./theme";

const SPARKS = 14;
const SIZE = 132;

export function SwapCelebration({
  fiatCode,
  amountLabel,
  caption,
  play,
  onBrand = false,
}: {
  fiatCode: string;
  amountLabel: string;
  caption?: string;
  play: boolean;
  /** Drawn on the full-screen green takeover rather than the page. */
  onBrand?: boolean;
}) {
  const c = useColors();
  const ink = onBrand ? "#ffffff" : c.primary;
  const meet = useRef(new Animated.Value(play ? 0 : 1)).current;
  const pop = useRef(new Animated.Value(play ? 0 : 1)).current;
  const burst = useRef(new Animated.Value(play ? 0 : 1)).current;
  const [sparks] = useState(() =>
    Array.from({ length: SPARKS }, (_, i) => ({
      angle: (i / SPARKS) * Math.PI * 2 + (i % 2 ? 0.12 : -0.08),
      reach: 70 + ((i * 37) % 30),
      size: 5 + (i % 3) * 2,
      warm: i % 3 === 0,
    })),
  );

  useEffect(() => {
    if (!play) return;
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (!alive) return;
      if (reduce) {
        meet.setValue(1);
        pop.setValue(1);
        burst.setValue(1);
        success();
        return;
      }
      meet.setValue(0);
      pop.setValue(0);
      burst.setValue(0);
      Animated.sequence([
        Animated.timing(meet, { toValue: 1, duration: 520, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.parallel([
          Animated.spring(pop, { toValue: 1, friction: 4, tension: 140, useNativeDriver: true }),
          Animated.timing(burst, { toValue: 1, duration: 900, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        ]),
      ]).start();
      setTimeout(() => alive && success(), 520);
    });
    return () => {
      alive = false;
    };
  }, [play, meet, pop, burst]);

  const coin = (side: -1 | 1, label: string, bg: string, fg: string) => (
    <Animated.View
      style={{
        position: "absolute",
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
        opacity: meet.interpolate({ inputRange: [0, 0.85, 1], outputRange: [1, 1, 0] }),
        transform: [{ translateX: meet.interpolate({ inputRange: [0, 1], outputRange: [side * 92, side * 6] }) }, { rotate: meet.interpolate({ inputRange: [0, 1], outputRange: [`${side * -30}deg`, "0deg"] }) }],
      }}
    >
      <Text variant="label" color={fg}>
        {label}
      </Text>
    </Animated.View>
  );

  return (
    <View style={{ alignItems: "center", gap: 10, paddingVertical: 8 }} accessibilityLabel={`Swap complete. ${amountLabel}`}>
      <View style={{ width: SIZE * 2, height: SIZE + 24, alignItems: "center", justifyContent: "center" }}>
        {sparks.map((s, i) => (
          <Animated.View
            key={i}
            style={{
              position: "absolute",
              width: s.size,
              height: s.size,
              borderRadius: s.size,
              backgroundColor: s.warm ? c.accent : ink,
              opacity: burst.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 1, 0] }),
              transform: [
                { translateX: burst.interpolate({ inputRange: [0, 1], outputRange: [0, Math.cos(s.angle) * s.reach] }) },
                { translateY: burst.interpolate({ inputRange: [0, 1], outputRange: [0, Math.sin(s.angle) * s.reach] }) },
                { scale: burst.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.4, 1.2, 0.6] }) },
              ],
            }}
          />
        ))}
        {coin(-1, "₿", "#f7931a", "#ffffff")}
        {coin(1, fiatCode, onBrand ? "#ffffff" : c.primary, onBrand ? c.primary : "#ffffff")}
        <Animated.View
          style={{
            width: 88,
            height: 88,
            borderRadius: 44,
            backgroundColor: ink,
            alignItems: "center",
            justifyContent: "center",
            opacity: pop,
            transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) }],
          }}
        >
          <Feather name="check" size={44} color={onBrand ? c.primary : "#ffffff"} />
        </Animated.View>
      </View>
      <Animated.View style={{ alignItems: "center", gap: 2, opacity: pop, transform: [{ translateY: pop.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}>
        <Text variant={onBrand ? "hero" : "title"} color={ink}>
          {amountLabel}
        </Text>
        {caption ? (
          onBrand ? (
            <Text variant="body" color="#ffffff" center>
              {caption}
            </Text>
          ) : (
            <Text variant="caption" muted center>
              {caption}
            </Text>
          )
        ) : null}
      </Animated.View>
    </View>
  );
}

// -- full-screen moment ------------------------------------------------------------

export interface Moment {
  fiatCode: string;
  amountLabel: string;
  caption: string;
}

const useMoment = create<{ current: Moment | null }>(() => ({ current: null }));

/** Take over the screen for a couple of seconds, wherever the person is in the app. */
export function celebrate(m: Moment) {
  useMoment.setState({ current: m });
}

export function CelebrationHost() {
  const current = useMoment((s) => s.current);
  const c = useColors();
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!current) return;
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    const t = setTimeout(() => close(), 2800);
    return () => clearTimeout(t);
  }, [current]);
  const close = () => Animated.timing(fade, { toValue: 0, duration: 260, useNativeDriver: true }).start(() => useMoment.setState({ current: null }));
  if (!current) return null;
  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={close}>
      <Animated.View style={{ flex: 1, opacity: fade, backgroundColor: c.primary }}>
        <Pressable onPress={close} style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 12 }} accessibilityRole="button" accessibilityLabel="Close">
          <Text variant="label" color="#ffffff" style={{ opacity: 0.85, letterSpacing: 1 }}>
            SWAP COMPLETE
          </Text>
          <SwapCelebration play onBrand fiatCode={current.fiatCode} amountLabel={current.amountLabel} caption={current.caption} />
        </Pressable>
        <Text variant="caption" color="#ffffff" center style={{ opacity: 0.7, paddingBottom: 48 }}>
          Pontspark
        </Text>
      </Animated.View>
    </Modal>
  );
}
