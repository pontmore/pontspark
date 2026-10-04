import { Feather } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import React, { useEffect, useRef, useState } from "react";
import { Animated, KeyboardAvoidingView, Modal, Pressable, StyleSheet, View } from "react-native";
import QRCode from "react-qr-code";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { create } from "zustand";

import { errorText } from "../lib/errors";
import { radius, space, useColors } from "./theme";
import { Text, tap, success } from "./components";

// -- number pad ------------------------------------------------------------------

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "del"];

export function NumPad({ value, onChange, decimals = 2, max = 12 }: { value: string; onChange: (v: string) => void; decimals?: number; max?: number }) {
  const c = useColors();
  const press = (k: string) => {
    tap();
    if (k === "del") return onChange(value.length <= 1 ? "0" : value.slice(0, -1));
    if (k === ".") {
      if (decimals === 0 || value.includes(".")) return;
      return onChange(value + ".");
    }
    const [, frac] = value.split(".");
    if (frac !== undefined && frac.length >= decimals) return;
    if (value.replace(".", "").length >= max) return;
    onChange(value === "0" ? k : value + k);
  };
  return (
    <View style={styles.pad}>
      {KEYS.map((k) => (
        <Pressable
          key={k}
          onPress={() => press(k)}
          onLongPress={k === "del" ? () => onChange("0") : undefined}
          style={({ pressed }) => [styles.key, { backgroundColor: pressed ? c.surfaceAlt : "transparent" }]}
          disabled={k === "." && decimals === 0}
        >
          {k === "del" ? (
            <Feather name="delete" size={24} color={c.text} />
          ) : (
            <Text variant="title" style={{ fontWeight: "500", opacity: k === "." && decimals === 0 ? 0 : 1 }}>
              {k}
            </Text>
          )}
        </Pressable>
      ))}
    </View>
  );
}

// -- sheet -------------------------------------------------------------------------

export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const y = useRef(new Animated.Value(400)).current;
  useEffect(() => {
    if (visible) Animated.spring(y, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 220 }).start();
    else y.setValue(400);
  }, [visible, y]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {/* A modal is its own window, so Android's adjustResize never reaches it: pad on both platforms. */}
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: c.overlay }]} onPress={onClose} />
        <View style={{ flex: 1 }} pointerEvents="box-none" />
        <Animated.View
          style={[styles.sheet, { backgroundColor: c.bg, paddingBottom: Math.max(insets.bottom, space.lg), transform: [{ translateY: y }] }]}
        >
          <View style={[styles.grabber, { backgroundColor: c.border }]} />
          {title && (
            <Text variant="title" style={{ marginBottom: space.sm }}>
              {title}
            </Text>
          )}
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// -- QR + copy ---------------------------------------------------------------------

export function QR({ value, size = 220 }: { value: string; size?: number }) {
  return (
    <View style={styles.qr}>
      <QRCode value={value} size={size} bgColor="#ffffff" fgColor="#101a13" />
    </View>
  );
}

/** `display` is shown instead of `value` (e.g. masked); `value` is what gets copied. */
export function CopyField({ value, label, short, display }: { value: string; label?: string; short?: boolean; display?: string }) {
  const c = useColors();
  const [copied, setCopied] = useState(false);
  const text = display ?? value;
  const shown = short && text.length > 28 ? `${text.slice(0, 14)}…${text.slice(-10)}` : text;
  return (
    <Pressable
      onPress={async () => {
        await Clipboard.setStringAsync(value);
        success();
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      style={({ pressed }) => [styles.copy, { backgroundColor: c.surface, borderColor: c.border, opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        {label && (
          <Text variant="caption" muted>
            {label}
          </Text>
        )}
        <Text variant="label" numberOfLines={short ? 1 : 4} selectable>
          {shown}
        </Text>
      </View>
      <Feather name={copied ? "check" : "copy"} size={18} color={copied ? c.primary : c.textMuted} />
    </Pressable>
  );
}

// -- toast ---------------------------------------------------------------------------

type ToastKind = "success" | "error" | "info";
const useToastStore = create<{ msg: string | null; kind: ToastKind; n: number }>(() => ({ msg: null, kind: "info", n: 0 }));

export function toast(msg: string, kind: ToastKind = "info") {
  useToastStore.setState((s) => ({ msg, kind, n: s.n + 1 }));
}

export function toastError(e: unknown) {
  toast(errorText(e), "error");
}

export function ToastHost() {
  const { msg, kind, n } = useToastStore();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!msg) return;
    Animated.sequence([
      Animated.spring(v, { toValue: 1, useNativeDriver: true }),
      Animated.delay(kind === "error" ? 3600 : 2200),
      Animated.timing(v, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start();
  }, [n, msg, kind, v]);
  if (!msg) return null;
  const icon = kind === "success" ? "check-circle" : kind === "error" ? "alert-circle" : "info";
  const color = kind === "success" ? c.primary : kind === "error" ? c.danger : c.info;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.toast,
        {
          top: insets.top + 8,
          backgroundColor: c.hero,
          opacity: v,
          transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [-30, 0] }) }],
        },
      ]}
    >
      <Feather name={icon} size={18} color={color} />
      <Text variant="label" color={c.heroText} style={{ flex: 1 }}>
        {msg}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pad: { flexDirection: "row", flexWrap: "wrap" },
  key: { width: "33.33%", height: 64, alignItems: "center", justifyContent: "center", borderRadius: radius.lg },
  sheet: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.lg, gap: space.md, maxHeight: "92%" },
  grabber: { width: 40, height: 5, borderRadius: 3, alignSelf: "center", marginBottom: space.sm },
  qr: { padding: 16, backgroundColor: "#ffffff", borderRadius: radius.lg, alignSelf: "center" },
  copy: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg, borderRadius: radius.md, borderWidth: 1 },
  toast: {
    position: "absolute",
    left: 16,
    right: 16,
    borderRadius: radius.md,
    padding: space.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 6,
  },
});
