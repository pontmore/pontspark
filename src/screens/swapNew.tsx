import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { channelInfo, currencyInfo, CURRENCIES, detailsComplete, validateDetails, type ChannelDetails } from "../lib/channels";
import { formatDecimal, formatSats, parseFiatInput } from "../lib/money";
import { checkLimits, offerSide, quote } from "../protocol/offer";
import { SWAP_TIMING } from "../protocol/constants";
import type { Direction } from "../protocol/swap";
import { createSwap } from "../services/swapEngine";
import { rankOffers, useDiscovery, usePayouts, type Match } from "../store/discovery";
import { useSession } from "../store/session";
import { useWallet } from "../store/wallet";
import { Avatar, Badge, Button, Card, Chip, Field, Notice, Row, Screen, Segmented, Spinner, Text, success } from "../ui/components";
import { NumPad, Sheet, toastError } from "../ui/extras";
import { ChannelFields } from "../ui/channelFields";
import { KeyValue } from "../ui/rows";
import { space, useColors } from "../ui/theme";

export function NewSwapScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const c = useColors();
  const sessionCurrency = useSession((s) => s.currency);
  const balance = useWallet((s) => s.balance);
  const [direction, setDirection] = useState<Direction>(route.params?.direction ?? "fiat_to_btc");
  const fixedAgent: string | undefined = route.params?.agentPk;
  const { load, loading, byCurrency, agents, loadAgent } = useDiscovery();
  const [currency, setCurrency] = useState<string>(route.params?.currency ?? sessionCurrency);
  const [amount, setAmount] = useState<string>(route.params?.amount ?? "0");
  // After a decline, suggest someone else first (the same agent stays available last).
  const avoid: string | undefined = route.params?.avoidAgent;
  const [picked, setPicked] = useState<Match | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const info = currencyInfo(currency);

  useEffect(() => {
    if (fixedAgent) void loadAgent(fixedAgent);
    else void load(currency);
  }, [currency, fixedAgent, load, loadAgent]);

  const listings = fixedAgent ? (agents[fixedAgent] ? [agents[fixedAgent]] : []) : (byCurrency[currency]?.listings ?? []);
  const fiatAmount = parseFiatInput(amount) ?? "0";
  const anyAmount = rankOffers(listings, currency, direction);
  const ranked = rankOffers(listings, currency, direction, Number(fiatAmount) > 0 ? fiatAmount : undefined);
  const fitting = avoid ? [...ranked.filter((m) => m.listing.pk !== avoid), ...ranked.filter((m) => m.listing.pk === avoid)] : ranked;
  const match = picked && fitting.some((m) => m.offer.event.id === picked.offer.event.id) ? picked : (fitting[0] ?? null);
  const side = match ? offerSide(match.offer, direction) : undefined;
  const q = match && Number(fiatAmount) > 0 ? quote(match.offer, direction, fiatAmount) : null;

  // Agent currencies, when locked to one agent.
  useEffect(() => {
    if (fixedAgent && agents[fixedAgent] && !agents[fixedAgent].offers.some((o) => o.currency === currency)) {
      setCurrency(agents[fixedAgent].offers[0].currency);
    }
  }, [fixedAgent, agents, currency]);

  useEffect(() => {
    if (match && (!channel || !match.offer.channels.includes(channel))) setChannel(match.offer.channels[0]);
  }, [match, channel]);

  const limits = useMemo(() => {
    if (!anyAmount.length) return null;
    const mins = anyAmount.map((m) => Number(offerSide(m.offer, direction)!.min));
    const maxs = anyAmount.map((m) => Number(offerSide(m.offer, direction)!.max));
    return { min: Math.min(...mins), max: Math.max(...maxs) };
  }, [anyAmount, direction]);

  let problem: string | null = null;
  if (Number(fiatAmount) > 0 && !match && limits) {
    problem =
      Number(fiatAmount) < limits.min
        ? `Minimum is ${currency} ${formatDecimal(String(limits.min))}`
        : `Maximum is ${currency} ${formatDecimal(String(limits.max))}`;
  }
  if (q && direction === "btc_to_fiat" && balance !== null && Number(q.sats) > balance) problem = "More than your balance";

  return (
    <Screen
      back
      title={fixedAgent ? (agents[fixedAgent]?.profile.name ?? "Swap") : "Swap"}
      scroll={false}
      footer={
        <Button
          title="Continue"
          disabled={!match || !q || !!problem || !channel}
          onPress={() =>
            nav.navigate("ReviewSwap", { agentPk: match!.listing.pk, offerId: match!.offer.event.id, direction, amount: fiatAmount, channel })
          }
        />
      }
    >
      <Segmented
        value={direction}
        onChange={(d) => {
          setDirection(d);
          setPicked(null);
        }}
        options={[
          { value: "fiat_to_btc", label: "Buy bitcoin" },
          { value: "btc_to_fiat", label: "Sell bitcoin" },
        ]}
      />

      <View style={{ alignItems: "center", gap: 6 }}>
        <Pressable onPress={() => !fixedAgent && setCurrencyOpen(true)} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 }}>
          <Text variant="label">
            {info.flag} {direction === "fiat_to_btc" ? "You pay" : "You get"} · {currency}
          </Text>
          {!fixedAgent && <Feather name="chevron-down" size={16} color={c.textMuted} />}
        </Pressable>
        <Text variant="hero" adjustsFontSizeToFit numberOfLines={1}>
          {formatDecimal(amount.endsWith(".") ? amount.slice(0, -1) : amount)}
          {amount.endsWith(".") ? "." : ""}
        </Text>
        <Text muted>
          {q ? `${direction === "fiat_to_btc" ? "You get" : "You send"} ${formatSats(q.sats)}` : problem ? " " : "Enter an amount"}
        </Text>
        {problem && (
          <Text variant="caption" color={c.danger}>
            {problem}
          </Text>
        )}
      </View>

      {loading && !listings.length ? (
        <Spinner label="Finding agents near you…" />
      ) : !anyAmount.length ? (
        <Notice tone="info" title={`No agents ${direction === "fiat_to_btc" ? "selling" : "buying"} bitcoin for ${currency} right now`}>
          Agents come online throughout the day. Try another currency, or pull to refresh later.
        </Notice>
      ) : match ? (
        <Card style={{ paddingVertical: space.md, gap: space.sm }}>
          <Row
            onPress={fixedAgent ? undefined : () => setAgentsOpen(true)}
            left={<Avatar pk={match.listing.pk} name={match.listing.profile.name} size={36} />}
            title={match.listing.profile.name ?? "Agent"}
            subtitle={`1 BTC = ${currency} ${formatDecimal(side!.price, 0)}`}
            right={!fixedAgent && fitting.length > 1 ? <Badge label={match === fitting[0] ? "Best rate" : "Chosen"} tone="success" /> : undefined}
            chevron={!fixedAgent}
          />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
            {match.offer.channels.map((ch) => (
              <Chip key={ch} label={channelInfo(ch).short} selected={ch === channel} onPress={() => setChannel(ch)} />
            ))}
          </ScrollView>
        </Card>
      ) : null}

      <View style={{ flex: 1 }} />
      <NumPad value={amount} onChange={setAmount} decimals={info.decimals} max={9} />

      <Sheet visible={currencyOpen} onClose={() => setCurrencyOpen(false)} title="Currency">
        <ScrollView style={{ maxHeight: 420 }}>
          {CURRENCIES.map((cur) => (
            <Row
              key={cur.code}
              left={<Text variant="title">{cur.flag}</Text>}
              title={`${cur.code} · ${cur.name}`}
              subtitle={cur.country}
              right={cur.code === currency ? <Feather name="check" size={18} color={c.primary} /> : undefined}
              onPress={() => {
                setCurrency(cur.code);
                setPicked(null);
                setCurrencyOpen(false);
              }}
            />
          ))}
        </ScrollView>
      </Sheet>

      <Sheet visible={agentsOpen} onClose={() => setAgentsOpen(false)} title="Choose an agent">
        <ScrollView style={{ maxHeight: 460 }}>
          {fitting.map((m, i) => {
            const s = offerSide(m.offer, direction)!;
            return (
              <Row
                key={m.offer.event.id}
                left={<Avatar pk={m.listing.pk} name={m.listing.profile.name} size={40} />}
                title={m.listing.profile.name ?? "Agent"}
                subtitle={`${currency} ${formatDecimal(s.price, 0)}/BTC · ${m.offer.channels.map((x) => channelInfo(x).short).join(", ")}`}
                right={i === 0 ? <Badge label="Best" tone="success" /> : undefined}
                onPress={() => {
                  setPicked(m);
                  setAgentsOpen(false);
                }}
              />
            );
          })}
        </ScrollView>
      </Sheet>
    </Screen>
  );
}

export function ReviewSwapScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const c = useColors();
  const { agentPk, offerId, direction, amount, channel } = route.params as {
    agentPk: string;
    offerId: string;
    direction: Direction;
    amount: string;
    channel: string;
  };
  const listing = useDiscovery((s) => s.agents[agentPk]);
  const offer = listing?.offers.find((o) => o.event.id === offerId);
  const backedUp = useSession((s) => s.backedUp);
  const { saved, save } = usePayouts();
  const [payout, setPayout] = useState<ChannelDetails>(saved[channel] ?? {});
  const [busy, setBusy] = useState(false);
  const ch = channelInfo(channel);

  if (!listing || !offer) {
    return (
      <Screen back title="Review">
        <Notice tone="warning">This offer is no longer available. Go back and pick again.</Notice>
      </Screen>
    );
  }
  const q = quote(offer, direction, amount)!;
  const buying = direction === "fiat_to_btc";
  const needsBackup = buying && !backedUp;
  const limitOk = checkLimits(offer, direction, amount) === "ok";
  const payoutOk = buying || detailsComplete(channel, payout);
  const fiat = `${offer.currency} ${formatDecimal(amount)}`;

  const start = async () => {
    setBusy(true);
    try {
      const normalized = buying ? undefined : validateDetails(channel, payout).data;
      if (normalized) save(channel, normalized);
      const id = await createSwap({ listing, offer, direction, fiatAmount: amount, channel, payout: normalized });
      success();
      nav.popToTop();
      nav.navigate("SwapDetail", { id });
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };

  return (
    <Screen
      back
      title="Review"
      footer={
        needsBackup ? (
          <Button title="Back up to continue" icon="shield" kind="accent" onPress={() => nav.navigate("Backup")} />
        ) : (
          <Button title={buying ? `Buy ${formatSats(q.sats)}` : `Sell ${formatSats(q.sats)}`} disabled={!limitOk || !payoutOk} loading={busy} onPress={start} />
        )
      }
    >
      <Card style={{ gap: space.lg }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ gap: 2 }}>
            <Text variant="caption" muted>
              {buying ? "You pay" : "You send"}
            </Text>
            <Text variant="title">{buying ? fiat : formatSats(q.sats)}</Text>
          </View>
          <Feather name="arrow-right" size={22} color={c.textFaint} />
          <View style={{ gap: 2, alignItems: "flex-end" }}>
            <Text variant="caption" muted>
              You get
            </Text>
            <Text variant="title" color={c.primary}>
              {buying ? formatSats(q.sats) : fiat}
            </Text>
          </View>
        </View>
        <View style={{ height: 1, backgroundColor: c.border }} />
        <KeyValue label="Agent" value={listing.profile.name ?? "Agent"} />
        <KeyValue label="Rate" value={`1 BTC = ${offer.currency} ${formatDecimal(q.price, 0)}`} />
        <KeyValue label={buying ? "Pay with" : "Receive as"} value={ch.label} />
      </Card>

      {!buying && ch.fields.length > 0 && (
        <Card>
          <Text variant="heading">Where should {listing.profile.name ?? "the agent"} pay you?</Text>
          <Text variant="caption" muted>
            Shared privately with this agent only, never published.
          </Text>
          <ChannelFields channel={channel} value={payout} onChange={setPayout} />
        </Card>
      )}

      <Card tone="alt" style={{ gap: space.md }}>
        <Text variant="label">How this swap stays safe</Text>
        {(buying
          ? [
              ["lock", `The agent locks ${formatSats(q.sats)} for you first. You'll see it in your wallet before you pay.`],
              ["send", ch.fields.length ? `Then you send ${fiat} via ${ch.short} within about ${Math.round(SWAP_TIMING.payWindow / 60)} minutes.` : `Then you meet and pay ${fiat} in cash within about ${Math.round(SWAP_TIMING.payWindow / 60)} minutes.`],
              ["unlock", "When the agent confirms your payment, the bitcoin unlocks into your wallet."],
            ]
          : [
              ["lock", `Your ${formatSats(q.sats)} are locked, not sent. The agent can't take them yet.`],
              ["send", ch.fields.length ? `The agent sends ${fiat} to your ${ch.short}.` : `You meet the agent and collect ${fiat} in cash. Agree where in the chat.`],
              ["unlock", "You release the bitcoin only after you have the money. If it never arrives, the lock returns to you."],
            ]
        ).map(([icon, text]) => (
          <View key={icon} style={{ flexDirection: "row", gap: space.md }}>
            <Feather name={icon as "lock"} size={16} color={c.primary} style={{ marginTop: 2 }} />
            <Text variant="caption" style={{ flex: 1 }}>
              {text}
            </Text>
          </View>
        ))}
      </Card>
      {needsBackup && (
        <Notice tone="warning" title="Back up before you buy">
          Bitcoin will land in this wallet. Save your recovery phrase first so you can't lose it.
        </Notice>
      )}
    </Screen>
  );
}
