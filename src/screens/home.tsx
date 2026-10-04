import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import React, { useState } from "react";
import { Pressable, View } from "react-native";

import { useActiveSwaps, useFiatOf } from "../hooks";
import { formatSatsShort } from "../lib/money";
import { useSession } from "../store/session";
import { useWallet } from "../store/wallet";
import { ActionTile, Button, Card, Empty, IconButton, Notice, Screen, Section, Spinner, Text } from "../ui/components";
import { SwapRow, TxRow } from "../ui/rows";
import { radius, space, useColors } from "../ui/theme";

export function WalletHero({ showSwap }: { showSwap: boolean }) {
  const c = useColors();
  const nav = useNavigation<any>();
  const { balance, status } = useWallet();
  const hide = useSession((s) => s.hideBalance);
  const toggle = useSession((s) => s.toggleHideBalance);
  const fiatOf = useFiatOf();
  const fiat = balance !== null ? fiatOf(balance) : null;

  return (
    <View style={{ backgroundColor: c.hero, borderRadius: radius.xl, padding: space.xl, gap: space.xl }}>
      <Pressable onPress={toggle} style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text variant="caption" color={c.heroMuted}>
            Balance
          </Text>
          <Feather name={hide ? "eye-off" : "eye"} size={13} color={c.heroMuted} />
        </View>
        {balance === null ? (
          <Text variant="hero" color={c.heroMuted}>
            {status === "error" ? "—" : "…"}
          </Text>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
            <Text variant="hero" color={c.heroText} adjustsFontSizeToFit numberOfLines={1} style={{ flexShrink: 1 }}>
              {hide ? "••••••" : formatSatsShort(balance)}
            </Text>
            <Text variant="heading" color={c.heroMuted} style={{ marginBottom: 8 }}>
              sats
            </Text>
          </View>
        )}
        {fiat && !hide && (
          <Text variant="body" color={c.heroMuted}>
            ≈ {fiat}
          </Text>
        )}
      </Pressable>
      <View style={{ flexDirection: "row" }}>
        <ActionTile tone="hero" icon="arrow-down" label="Receive" onPress={() => nav.navigate("Receive")} />
        <ActionTile tone="hero" icon="arrow-up" label="Send" onPress={() => nav.navigate("Send")} />
        <ActionTile tone="hero" icon="maximize" label="Scan" onPress={() => nav.navigate("Scan")} />
        {showSwap && <ActionTile tone="hero" icon="repeat" label="Swap" onPress={() => nav.navigate("NewSwap", {})} />}
      </View>
    </View>
  );
}

export function HomeScreen() {
  const nav = useNavigation<any>();
  const c = useColors();
  const { txs, status, error, refresh, refreshRates, balance } = useWallet();
  const backedUp = useSession((s) => s.backedUp);
  const name = useSession((s) => s.profile.name);
  const hide = useSession((s) => s.hideBalance);
  const mode = useSession((s) => s.mode);
  const active = useActiveSwaps(mode === "agent" ? undefined : "customer");
  const fiatOf = useFiatOf();
  const [refreshing, setRefreshing] = useState(false);

  return (
    <Screen
      onRefresh={async () => {
        setRefreshing(true);
        await Promise.all([refresh(), refreshRates()]);
        setRefreshing(false);
      }}
      refreshing={refreshing}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.sm }}>
        <View>
          <Text variant="caption" muted>
            {mode === "agent" ? "Agent wallet" : greeting()}
          </Text>
          <Text variant="title">{name || "Your wallet"}</Text>
        </View>
        <IconButton name="clock" label="History" onPress={() => nav.navigate("Transactions")} />
      </View>

      <WalletHero showSwap={mode === "user"} />

      {status === "error" && (
        <Notice tone="danger" title="Wallet offline" action={<Button small kind="secondary" title="Retry" onPress={() => useWallet.getState().start()} />}>
          {error ?? "Couldn't connect to the wallet."}
        </Notice>
      )}

      {!backedUp && (
        <Card tone="accent" onPress={() => nav.navigate("Backup")} style={{ flexDirection: "row", alignItems: "center" }}>
          <Feather name="shield" size={22} color={c.accent} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="label">Back up your wallet</Text>
            <Text variant="caption" muted>
              {balance ? "You have bitcoin here. Save your recovery phrase now." : "Takes a minute. Do it before you receive money."}
            </Text>
          </View>
          <Feather name="chevron-right" size={18} color={c.textMuted} />
        </Card>
      )}

      {mode === "user" && active.length === 0 && (
        <View style={{ flexDirection: "row", gap: space.md }}>
          <Card style={{ flex: 1 }} onPress={() => nav.navigate("NewSwap", { direction: "fiat_to_btc" })}>
            <Feather name="plus-circle" size={22} color={c.primary} />
            <Text variant="heading">Buy bitcoin</Text>
            <Text variant="caption" muted>
              Pay an agent with cash or mobile money
            </Text>
          </Card>
          <Card style={{ flex: 1 }} onPress={() => nav.navigate("NewSwap", { direction: "btc_to_fiat" })}>
            <Feather name="minus-circle" size={22} color={c.accent} />
            <Text variant="heading">Sell bitcoin</Text>
            <Text variant="caption" muted>
              Get cash or mobile money from an agent
            </Text>
          </Card>
        </View>
      )}

      {active.length > 0 && (
        <Section title="In progress">
          <Card style={{ paddingVertical: space.sm, gap: 0 }}>
            {active.slice(0, 4).map((i) => (
              <SwapRow key={i.rec.id} item={i} />
            ))}
          </Card>
        </Section>
      )}

      <Section
        title="Recent activity"
        action={
          txs.length > 0 ? (
            <Pressable onPress={() => nav.navigate("Transactions")}>
              <Text variant="label" color={c.primary}>
                See all
              </Text>
            </Pressable>
          ) : undefined
        }
      >
        {status === "connecting" && txs.length === 0 ? (
          <Spinner label="Opening your wallet…" />
        ) : txs.length === 0 ? (
          <Empty icon="inbox" title="No payments yet" body="Receive bitcoin or buy some from an agent to get started." />
        ) : (
          <Card style={{ paddingVertical: space.sm, gap: 0 }}>
            {txs.slice(0, 6).map((t) => (
              <TxRow key={t.id} tx={t} fiat={fiatOf(t.amountSats)} hidden={hide} />
            ))}
          </Card>
        )}
      </Section>
    </Screen>
  );
}

export function TransactionsScreen() {
  const { txs, refresh } = useWallet();
  const hide = useSession((s) => s.hideBalance);
  const fiatOf = useFiatOf();
  const [refreshing, setRefreshing] = useState(false);
  return (
    <Screen
      back
      title="Payments"
      onRefresh={async () => {
        setRefreshing(true);
        await refresh();
        setRefreshing(false);
      }}
      refreshing={refreshing}
    >
      {txs.length === 0 ? (
        <Empty icon="inbox" title="No payments yet" />
      ) : (
        <Card style={{ paddingVertical: space.sm, gap: 0 }}>
          {txs.map((t) => (
            <TxRow key={t.id} tx={t} fiat={fiatOf(t.amountSats)} hidden={hide} />
          ))}
        </Card>
      )}
    </Screen>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
