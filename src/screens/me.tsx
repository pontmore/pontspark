import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import Constants from "expo-constants";
import React, { useState } from "react";
import { Linking, ScrollView, View } from "react-native";

import { useNow, useSwapList } from "../hooks";
import { currencyInfo, CURRENCIES } from "../lib/channels";
import { npub } from "../lib/links";
import { isTerminal } from "../protocol/swap";
import { BREEZ_NETWORK } from "../services/config";
import { publish, relayStatus, sign } from "../services/nostr";
import { profileTemplate } from "../protocol/events";
import { useAgent } from "../store/agent";
import { useSession } from "../store/session";
import { useSwaps } from "../store/swaps";
import { useWallet } from "../store/wallet";
import { Avatar, Badge, Button, Card, Divider, Empty, Field, Notice, Row, Screen, Section, Segmented, Text, success } from "../ui/components";
import { CopyField, Sheet, confirm, toast } from "../ui/extras";
import { SwapRow } from "../ui/rows";
import { space, useColors } from "../ui/theme";
import { useConfirmLeaveAgent } from "./agent";
import { ClaimAddressSheet } from "./receive";
import { setAgentOnline } from "../services/agentLoop";

export function ActivityScreen() {
  const now = useNow(30000);
  const mode = useSession((s) => s.mode);
  const [tab, setTab] = useState<"active" | "past">("active");
  const list = useSwapList((i) => (mode === "agent" ? true : i.rec.role === "customer"));
  const isActive = (st: (typeof list)[number]["st"]) => !isTerminal(st) && !(st.status === "proposed" && now >= st.root.expiresAt);
  const shown = list.filter((i) => (tab === "active" ? isActive(i.st) : !isActive(i.st)));
  return (
    <Screen large title="Swaps">
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: "active", label: "Active" },
          { value: "past", label: "Past" },
        ]}
      />
      {shown.length === 0 ? (
        <Empty icon="repeat" title={tab === "active" ? "No active swaps" : "No past swaps"} body="Swaps you start or take appear here." />
      ) : (
        <Card style={{ paddingVertical: space.sm, gap: 0 }}>
          {shown.map((i) => (
            <SwapRow key={i.rec.id} item={i} />
          ))}
        </Card>
      )}
    </Screen>
  );
}

export function MeScreen() {
  const nav = useNavigation<any>();
  const c = useColors();
  const { keys, profile, mode, setMode, backedUp, currency, setCurrency, setProfile } = useSession();
  const configured = useAgent((s) => s.configured);
  const lnAddress = useWallet((s) => s.lightningAddress);
  const leaveAgent = useConfirmLeaveAgent();
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  const [name, setName] = useState(profile.name);
  if (!keys) return null;

  return (
    <Screen large title="Me">
      <Card style={{ flexDirection: "row", alignItems: "center" }} onPress={() => setNameOpen(true)}>
        <Avatar pk={keys.identity.pk} name={profile.name} size={52} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="heading">{profile.name || "Add your name"}</Text>
          <Text variant="caption" muted numberOfLines={1}>
            {lnAddress ?? `${npub(keys.identity.pk).slice(0, 18)}…`}
          </Text>
        </View>
        <Feather name="edit-2" size={16} color={c.textMuted} />
      </Card>

      <Card tone={mode === "agent" ? "primary" : "accent"}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <Feather name={mode === "agent" ? "user" : "briefcase"} size={22} color={mode === "agent" ? c.primary : c.accent} />
          <View style={{ flex: 1 }}>
            <Text variant="heading">{mode === "agent" ? "Switch to personal mode" : configured ? "Switch to agent mode" : "Become an agent"}</Text>
            <Text variant="caption" muted>
              {mode === "agent" ? "Use your wallet and swap as a customer." : "Earn by swapping bitcoin for cash with people near you."}
            </Text>
          </View>
        </View>
        <Button
          small
          kind={mode === "agent" ? "secondary" : "accent"}
          title={mode === "agent" ? "Personal mode" : configured ? "Agent mode" : "Get started"}
          onPress={() => {
            if (mode === "agent") return leaveAgent();
            if (!configured) return nav.navigate("AgentSetup");
            setMode("agent");
            success();
          }}
        />
      </Card>

      <Section title="Wallet">
        <Card style={{ paddingVertical: space.sm, gap: 0 }}>
          <Row
            icon="shield"
            title="Recovery phrase"
            subtitle={backedUp ? "Backed up" : "Not backed up yet"}
            right={backedUp ? <Badge label="Safe" tone="success" /> : <Badge label="Do this" tone="warning" />}
            chevron
            onPress={() => nav.navigate("Backup")}
          />
          <Divider />
          <Row icon="at-sign" title="Lightning address" subtitle={lnAddress ?? "Claim a reusable address"} chevron onPress={() => (lnAddress ? undefined : setClaimOpen(true))} />
          <Divider />
          <Row
            icon="dollar-sign"
            title="Display currency"
            subtitle={`${currencyInfo(currency).flag} ${currency}`}
            chevron
            onPress={() => setCurrencyOpen(true)}
          />
          <Divider />
        </Card>
      </Section>

      <Section title="Nostr">
        <Card style={{ paddingVertical: space.sm, gap: 0 }}>
          <Row icon="key" title="Identity" subtitle="Your public key, derived from your recovery phrase" chevron onPress={() => nav.navigate("Identity")} />
          <Divider />
          <Row icon="radio" title="Relays" subtitle="Where offers, swaps and messages travel" chevron onPress={() => nav.navigate("Relays")} />
          {mode === "agent" && (
            <>
              <Divider />
              <Row icon="sliders" title="Agent setup" subtitle="Markets, pricing and payment details" chevron onPress={() => nav.navigate("AgentSetup")} />
            </>
          )}
        </Card>
      </Section>

      <Section title="About">
        <Card style={{ paddingVertical: space.sm, gap: 0 }}>
          <Row icon="book-open" title="Pontmore protocol" subtitle="PIP-00, PIP-01, PIP-02 · pontmore/swap@1" chevron onPress={() => void Linking.openURL("https://github.com/pontmore/protocol")} />
          <Divider />
          <Row icon="cpu" title="Version" subtitle={`${Constants.expoConfig?.version ?? "dev"} · Breez Spark ${BREEZ_NETWORK}`} />
        </Card>
      </Section>

      <Button kind="danger" title="Remove wallet from this phone" icon="log-out" onPress={() => nav.navigate("SignOut")} />

      <Sheet visible={currencyOpen} onClose={() => setCurrencyOpen(false)} title="Display currency">
        <ScrollView style={{ maxHeight: 420 }}>
          {CURRENCIES.map((cur) => (
            <Row
              key={cur.code}
              left={<Text variant="title">{cur.flag}</Text>}
              title={`${cur.code} · ${cur.name}`}
              right={cur.code === currency ? <Feather name="check" size={18} color={c.primary} /> : undefined}
              onPress={() => {
                setCurrency(cur.code);
                setCurrencyOpen(false);
              }}
            />
          ))}
        </ScrollView>
      </Sheet>
      <Sheet visible={nameOpen} onClose={() => setNameOpen(false)} title="Your name">
        <Field value={name} onChangeText={setName} placeholder="What agents see in chat" maxLength={48} autoFocus />
        <Button
          title="Save"
          onPress={() => {
            const next = { ...profile, name: name.trim() };
            setProfile(next);
            setNameOpen(false);
            // Lets counterparties see who they're swapping with.
            void publish(sign(profileTemplate({ name: next.name, about: next.about, lud16: lnAddress ?? undefined }), keys.identity.sk)).catch(() => undefined);
          }}
        />
      </Sheet>
      <ClaimAddressSheet visible={claimOpen} onClose={() => setClaimOpen(false)} />
    </Screen>
  );
}

export function IdentityScreen() {
  const keys = useSession((s) => s.keys);
  if (!keys) return null;
  return (
    <Screen back title="Identity">
      <Text muted>
        Your Nostr identity is derived from your recovery phrase (NIP-06), so restoring your wallet restores it too. Agent mode adds two more derived keys.
      </Text>
      <CopyField value={npub(keys.identity.pk)} label="Your npub" />
      <CopyField value={npub(keys.escrow.pk)} label="Escrow key (agent mode)" short />
      <CopyField value={npub(keys.resolver.pk)} label="Resolver key (agent mode)" short />
      <Notice tone="info">The escrow key signs your agent's lock, settle and refund records. The resolver key signs dispute resolutions for your swaps.</Notice>
    </Screen>
  );
}

export function RelaysScreen() {
  const { relays, setRelays } = useSession();
  const [list, setList] = useState(relays);
  const [input, setInput] = useState("");
  const status = relayStatus();
  return (
    <Screen
      back
      title="Relays"
      footer={
        <Button
          title="Save"
          onPress={() => {
            setRelays(list);
            toast("Relays saved. Restart the app to reconnect everything.", "success");
          }}
        />
      }
    >
      <Text muted>Your offers, swaps and private messages are published to these relays. Both sides of a swap need at least one in common.</Text>
      <Card style={{ paddingVertical: space.sm, gap: 0 }}>
        {list.map((r) => (
          <Row
            key={r}
            icon="radio"
            iconColor={status.get(r) ? "#2f9e44" : undefined}
            title={r.replace("wss://", "")}
            subtitle={status.get(r) ? "Connected" : "Not connected"}
            right={<Button small kind="ghost" title="Remove" onPress={() => setList(list.filter((x) => x !== r))} />}
          />
        ))}
      </Card>
      <Field value={input} onChangeText={setInput} placeholder="wss://relay.example.com" autoCapitalize="none" autoCorrect={false} />
      <Button
        kind="secondary"
        title="Add relay"
        disabled={!/^wss:\/\/[^\s]+\.[^\s]+$/.test(input.trim())}
        onPress={() => {
          setList([...new Set([...list, input.trim()])]);
          setInput("");
        }}
      />
    </Screen>
  );
}

export function SignOutScreen() {
  const nav = useNavigation<any>();
  const signOut = useSession((s) => s.signOut);
  const balance = useWallet((s) => s.balance);
  const backedUp = useSession((s) => s.backedUp);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Screen
      back
      title="Remove wallet"
      footer={
        <Button
          kind="danger"
          title="Remove from this phone"
          disabled={typed.trim().toLowerCase() !== "remove" || busy}
          loading={busy}
          onPress={async () => {
            const ok = await confirm({
              title: "Remove wallet?",
              message: "Without your recovery phrase this wallet is gone for good.",
              confirmLabel: "Remove wallet",
              cancelLabel: "Keep it",
              tone: "danger",
              icon: "trash-2",
            });
            if (!ok) return;
            setBusy(true);
            if (useAgent.getState().online) await setAgentOnline(false).catch(() => undefined);
            useAgent.getState().reset();
            useSwaps.getState().clear();
            useWallet.getState().reset();
            await signOut();
          }}
        />
      }
    >
      <Notice tone="danger" title="This deletes your keys from this phone">
        {`You can restore later only with your recovery phrase.${balance ? ` This wallet holds ${balance.toLocaleString()} sats.` : ""}`}
      </Notice>
      {!backedUp && (
        <Notice tone="warning" title="You haven't backed up" action={<Button small kind="secondary" title="Back up first" onPress={() => nav.navigate("Backup")} />}>
          Back up before removing, or you'll lose access.
        </Notice>
      )}
      <Field label='Type "remove" to confirm' value={typed} onChangeText={setTyped} autoCapitalize="none" autoCorrect={false} />
    </Screen>
  );
}
