import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import React, { useEffect } from "react";
import { AppState, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { RootNavigator } from "./navigation";
import { resumeAgent, suspendAgent } from "./services/agentLoop";
import { installDevProbe } from "./services/devProbe";
import { resumeEngine, startEngine, stopEngine } from "./services/swapEngine";
import { useSession } from "./store/session";
import { useWallet } from "./store/wallet";
import { Logo } from "./ui/components";
import { ConfirmHost, ToastHost } from "./ui/extras";
import { useColors, useIsDark } from "./ui/theme";

function useBoot() {
  const hydrated = useSession((s) => s.hydrated);
  const phase = useSession((s) => s.phase);
  const keys = useSession((s) => s.keys);
  const boot = useSession((s) => s.boot);

  useEffect(() => {
    if (hydrated && phase === "loading") void boot();
  }, [hydrated, phase, boot]);

  // Wallet, swap engine and agent loop run whenever a wallet is present.
  useEffect(() => {
    if (phase !== "ready" || !keys) return;
    void useWallet.getState().start();
    startEngine(keys);
    resumeAgent();
    return () => {
      stopEngine();
      suspendAgent();
      useWallet.getState().reset();
    };
  }, [phase, keys]);

  // Catch up after the app was in the background.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active" || useSession.getState().phase !== "ready") return;
      void useWallet.getState().refresh();
      resumeEngine();
    });
    return () => sub.remove();
  }, []);
}

installDevProbe();

export default function App() {
  const c = useColors();
  const dark = useIsDark();
  const phase = useSession((s) => s.phase);
  useBoot();

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(c.bg);
  }, [c.bg]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: c.bg }}>
      <SafeAreaProvider>
        <StatusBar style={dark ? "light" : "dark"} />
        {phase === "loading" ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bg }}>
            <Logo size={72} />
          </View>
        ) : (
          <RootNavigator />
        )}
        <ConfirmHost />
        <ToastHost />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
