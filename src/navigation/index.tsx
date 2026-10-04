import { Feather } from "@expo/vector-icons";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { DarkTheme, DefaultTheme, NavigationContainer, type LinkingOptions } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import * as Linking from "expo-linking";
import React from "react";

import { useActiveSwaps, useMe } from "../hooks";
import { describeSwap } from "../lib/swapView";
import { useSession } from "../store/session";
import { useColors, useIsDark } from "../ui/theme";
import { AgentSetupScreen, DeskScreen } from "../screens/agent";
import { BackupScreen } from "../screens/backup";
import { AgentProfileScreen, DiscoverScreen } from "../screens/discover";
import { HomeScreen, TransactionsScreen } from "../screens/home";
import { ActivityScreen, IdentityScreen, MeScreen, RelaysScreen, SignOutScreen } from "../screens/me";
import { RestoreScreen, WelcomeScreen } from "../screens/onboarding";
import { ReceiveScreen } from "../screens/receive";
import { ScanScreen, SendScreen } from "../screens/send";
import { ChatScreen, SwapDetailScreen } from "../screens/swapDetail";
import { NewSwapScreen, ReviewSwapScreen } from "../screens/swapNew";

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function useActionCount() {
  const me = useMe();
  const active = useActiveSwaps();
  return active.filter((i) => describeSwap(i.rec, i.st, me).myTurn).length;
}

function Tabs() {
  const c = useColors();
  const mode = useSession((s) => s.mode);
  const pending = useActionCount();
  const icon =
    (name: React.ComponentProps<typeof Feather>["name"]) =>
    ({ color }: { color: string }) => <Feather name={name} size={22} color={color} />;
  const badge = pending ? { tabBarBadge: pending, tabBarBadgeStyle: { backgroundColor: c.accent, color: "#1d1408", fontSize: 11 } } : {};

  return (
    <Tab.Navigator
      key={mode}
      initialRouteName={mode === "agent" ? "Desk" : "Home"}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.text,
        tabBarInactiveTintColor: c.textFaint,
        tabBarStyle: { backgroundColor: c.bg, borderTopColor: c.border, height: 88, paddingTop: 8 },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
    >
      {mode === "agent" ? (
        <>
          <Tab.Screen name="Desk" component={DeskScreen} options={{ tabBarIcon: icon("briefcase"), ...badge }} />
          <Tab.Screen name="Wallet" component={HomeScreen} options={{ tabBarIcon: icon("credit-card") }} />
          <Tab.Screen name="Swaps" component={ActivityScreen} options={{ tabBarIcon: icon("repeat") }} />
          <Tab.Screen name="Me" component={MeScreen} options={{ tabBarIcon: icon("user") }} />
        </>
      ) : (
        <>
          <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarIcon: icon("home") }} />
          <Tab.Screen name="Agents" component={DiscoverScreen} options={{ tabBarIcon: icon("map-pin") }} />
          <Tab.Screen name="Swaps" component={ActivityScreen} options={{ tabBarIcon: icon("repeat"), ...badge }} />
          <Tab.Screen name="Me" component={MeScreen} options={{ tabBarIcon: icon("user") }} />
        </>
      )}
    </Tab.Navigator>
  );
}

const linking: LinkingOptions<ReactNavigation.RootParamList> = {
  prefixes: [Linking.createURL("/"), "pontmore://"],
  config: {
    screens: {
      AgentProfile: "agent/:pk",
      SwapDetail: "swap/:id",
    },
  },
};

export function RootNavigator() {
  const phase = useSession((s) => s.phase);
  const c = useColors();
  const dark = useIsDark();
  const base = dark ? DarkTheme : DefaultTheme;
  const theme = { ...base, colors: { ...base.colors, background: c.bg, card: c.bg, text: c.text, border: c.border, primary: c.primary } };

  return (
    <NavigationContainer theme={theme} linking={phase === "ready" ? linking : undefined}>
      <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg } }}>
        {phase !== "ready" ? (
          <>
            <Stack.Screen name="Welcome" component={WelcomeScreen} />
            <Stack.Screen name="Restore" component={RestoreScreen} />
          </>
        ) : (
          <>
            <Stack.Screen name="Main" component={Tabs} />
            <Stack.Screen name="Receive" component={ReceiveScreen} />
            <Stack.Screen name="Send" component={SendScreen} />
            <Stack.Screen name="Scan" component={ScanScreen} options={{ presentation: "fullScreenModal", animation: "fade" }} />
            <Stack.Screen name="Transactions" component={TransactionsScreen} />
            <Stack.Screen name="Backup" component={BackupScreen} />
            <Stack.Screen name="NewSwap" component={NewSwapScreen} />
            <Stack.Screen name="ReviewSwap" component={ReviewSwapScreen} />
            <Stack.Screen name="SwapDetail" component={SwapDetailScreen} />
            <Stack.Screen name="Chat" component={ChatScreen} />
            <Stack.Screen name="AgentProfile" component={AgentProfileScreen} />
            <Stack.Screen name="AgentSetup" component={AgentSetupScreen} />
            <Stack.Screen name="Identity" component={IdentityScreen} />
            <Stack.Screen name="Relays" component={RelaysScreen} />
            <Stack.Screen name="SignOut" component={SignOutScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
