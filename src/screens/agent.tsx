import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import React, { useMemo, useState } from "react";
import { Alert, ScrollView, View } from "react-native";

import { useActiveSwaps, useSwapList } from "../hooks";
import { channelInfo, channelsForCurrency, currencyInfo, CURRENCIES, detailsComplete, validateDetails, type ChannelDetails } from "../lib/channels";
import { formatDecimal, formatSats, isDecimalAmount, priceWithSpread } from "../lib/money";
import { timeAgo } from "../lib/swapView";
import { buildOffers, type MarketOffers } from "../services/agentPublisher";
import { defaultMarket, useAgent, type Market, type MarketSide } from "../store/agent";
import { useSession } from "../store/session";
import { useWallet } from "../store/wallet";
import { Badge, Button, Card, Chip, Empty, Field, IconButton, Notice, Pulse, Row, Screen, Section, Text, Toggle, success } from "../ui/components";
import { Sheet, toast } from "../ui/extras";
import { ChannelFields } from "../ui/channelFields";
import { SwapRow } from "../ui/rows";
import { radius, space, useColors } from "../ui/theme";
import { AgentShareSheet } from "./discover";
import { setAgentOnline } from "../services/agentLoop";

export function DeskScreen() {
  const nav = useNavigation<any>();
  const c = useColors();
  const { configured, online, markets, lastPublishedAt, publishError, autoAccept } = useAgent();
  const keys = useSession((s) => s.keys);
  const name = useSession((s) => s.profile.name);
  const balance = useWallet((s) => s.balance);
  const active = useActiveSwaps("agent");
  const all = useSwapList((i) => i.rec.role === "agent");
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const requests = active.filter((i) => i.st.status === "proposed");
  const running = active.filter((i) => i.st.status !== "proposed");
  const completed = all.filter((i) => i.st.status === "settled");
  const volume = completed.reduce((sum, i) => sum + Number(i.st.root.terms.bitcoin.amount), 0);

  if (!configured) {
    return (
      <Screen large title="Agent desk">
        <Empty
          icon="briefcase"
          title="Set up your agent desk"
          body="Choose the currencies and payment channels you serve and your pricing. Customers find you on Nostr."
          action={<Button title="Set up" icon="arrow-right" onPress={() => nav.navigate("AgentSetup")} />}
        />
      </Screen>
    );
  }

  const toggle = async (v: boolean) => {
    setBusy(true);
    try {
      await setAgentOnline(v);
      success();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen large title="Agent desk" right={<IconButton name="share-2" onPress={() => setShare(true)} />}>
      <View style={{ backgroundColor: c.hero, borderRadius: radius.xl, padding: space.xl, gap: space.lg }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          {online ? <Pulse color="#57c26a" /> : <View style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center" }}><View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.heroMuted }} /></View>}
          <View style={{ flex: 1 }}>
            <Text variant="heading" color={c.heroText}>
              {online ? "You're online" : "You're offline"}
            </Text>
            <Text variant="caption" color={c.heroMuted}>
              {online
                ? publishError
                  ? `Couldn't publish: ${publishError}`
                  : lastPublishedAt
                    ? `Offers live · updated ${timeAgo(lastPublishedAt)}`
                    : "Publishing your offers…"
                : "Customers can't see your offers."}
            </Text>
          </View>
        </View>
        <Button title={online ? "Go offline" : "Go online"} kind={online ? "secondary" : "primary"} loading={busy} onPress={() => toggle(!online)} />
        <View style={{ flexDirection: "row", gap: space.md }}>
          <Stat label="Liquidity" value={balance === null ? "…" : formatSats(balance)} />
          <Stat label="Completed" value={`${completed.length}`} />
          <Stat label="Volume" value={formatSats(volume).replace(" sats", "")} />
        </View>
      </View>

      {online && <Text variant="caption" faint center>Keep Pontspark open while you're online so you can respond to requests.</Text>}

      <Section title={`Requests${requests.length ? ` · ${requests.length}` : ""}`}>
        {requests.length === 0 ? (
          <Card tone="alt">
            <Text variant="caption" muted>
              {online ? (autoAccept ? "New requests that match your offers are accepted automatically." : "New requests will appear here.") : "Go online to receive requests."}
            </Text>
          </Card>
        ) : (
          <Card style={{ paddingVertical: space.sm, gap: 0 }}>
            {requests.map((i) => (
              <SwapRow key={i.rec.id} item={i} />
            ))}
          </Card>
        )}
      </Section>

      {running.length > 0 && (
        <Section title="Active swaps">
          <Card style={{ paddingVertical: space.sm, gap: 0 }}>
            {running.map((i) => (
              <SwapRow key={i.rec.id} item={i} />
            ))}
          </Card>
        </Section>
      )}

      <Section title="Your offers" action={<Button small kind="ghost" title="Edit" onPress={() => nav.navigate("AgentSetup")} />}>
        {markets.map((m) => (
          <OfferPreview key={m.currency} market={m} />
        ))}
      </Section>
      {keys && <AgentShareSheet pk={keys.identity.pk} name={name} visible={share} onClose={() => setShare(false)} />}
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text variant="caption" color={c.heroMuted}>
        {label}
      </Text>
      <Text variant="label" color={c.heroText} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}

function OfferPreview({ market }: { market: Market }) {
  const keys = useSession((s) => s.keys);
  const rate = useWallet((s) => s.rates[market.currency]);
  const balance = useWallet((s) => s.balance);
  const built: MarketOffers = keys && rate ? buildOffers(keys, market, rate, balance ?? 0, 0) : {};
  const offer = built.buy || built.sell ? built : null;
  const ready = Object.keys(market.channels).filter((c) => detailsComplete(c, market.channels[c]));
  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text variant="heading">
          {currencyInfo(market.currency).flag} {market.currency}
        </Text>
        {!ready.length ? <Badge label="Needs payment details" tone="warning" /> : !offer ? <Badge label="Not offered" tone="warning" /> : null}
      </View>
      {offer?.buy && (
        <Row icon="arrow-up-right" title={`You sell at ${market.currency} ${formatDecimal(offer.buy.price, 0)}`} subtitle={`+${market.buy.spreadPct}% · up to ${market.currency} ${formatDecimal(offer.buy.max)}`} />
      )}
      {market.buy.enabled && rate && !built.buy && ready.length > 0 && <Notice tone="warning">Not enough bitcoin to sell. Top up your wallet.</Notice>}
      {offer?.sell && (
        <Row icon="arrow-down-left" title={`You buy at ${market.currency} ${formatDecimal(offer.sell.price, 0)}`} subtitle={`−${market.sell.spreadPct}% · up to ${market.currency} ${formatDecimal(offer.sell.max)}`} />
      )}
      <Text variant="caption" muted>
        {ready.map((c) => channelInfo(c).short).join(" · ") || "No channels ready"}
      </Text>
    </Card>
  );
}

// -- setup -------------------------------------------------------------------------

export function AgentSetupScreen() {
  const nav = useNavigation<any>();
  const c = useColors();
  const profile = useSession((s) => s.profile);
  const setProfile = useSession((s) => s.setProfile);
  const setMode = useSession((s) => s.setMode);
  const { markets, saveMarkets, autoAccept, setAutoAccept, online } = useAgent();
  const [name, setName] = useState(profile.name);
  const [about, setAbout] = useState(profile.about);
  const [draft, setDraft] = useState<Market[]>(markets.length ? markets : [defaultMarket(useSession.getState().currency)]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const ready = name.trim().length >= 2 && draft.some((m) => Object.keys(m.channels).some((ch) => detailsComplete(ch, m.channels[ch])));

  const save = async () => {
    setProfile({ name: name.trim(), about: about.trim() });
    saveMarkets(draft);
    setMode("agent");
    success();
    if (online) await setAgentOnline(true).catch(() => undefined);
    toast(online ? "Offers updated" : "Agent desk ready. Go online when you're set.", "success");
    nav.goBack();
  };

  const market = draft.find((m) => m.currency === editing);

  return (
    <Screen back title="Agent setup" footer={<Button title="Save" disabled={!ready} onPress={save} />}>
      <Section title="Public profile">
        <Field label="Display name" value={name} onChangeText={setName} placeholder="Wanjiku's Bitcoin Desk" maxLength={48} />
        <Field label="About" value={about} onChangeText={setAbout} placeholder="Fast M-Pesa swaps in Nairobi, 7am–10pm" maxLength={160} multiline />
      </Section>
      <Section title="Markets" action={<Button small kind="ghost" icon="plus" title="Add" onPress={() => setAdding(true)} />}>
        {draft.map((m) => {
          const ready = Object.keys(m.channels).filter((ch) => detailsComplete(ch, m.channels[ch]));
          return (
            <Card key={m.currency} onPress={() => setEditing(m.currency)} style={{ flexDirection: "row", alignItems: "center" }}>
              <Text variant="title">{currencyInfo(m.currency).flag}</Text>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="heading">{m.currency}</Text>
                <Text variant="caption" muted>
                  {ready.length ? ready.map((ch) => channelInfo(ch).short).join(" · ") : "Add a payment channel"}
                  {"  ·  "}
                  {[m.buy.enabled && `sell +${m.buy.spreadPct}%`, m.sell.enabled && `buy −${m.sell.spreadPct}%`].filter(Boolean).join(", ")}
                </Text>
              </View>
              <Feather name="chevron-right" size={18} color={c.textFaint} />
            </Card>
          );
        })}
      </Section>
      <Card>
        <Toggle
          icon="zap"
          label="Auto-accept matching requests"
          subtitle="Requests that fit your offer, limits and liquidity are accepted instantly."
          value={autoAccept}
          onChange={setAutoAccept}
        />
      </Card>
      <Notice tone="info" title="How you get paid safely">
        When you sell bitcoin, you lock it to the customer first and release it only after their payment reaches you. When you buy, the customer's bitcoin is locked to you before you pay.
      </Notice>

      <Sheet visible={adding} onClose={() => setAdding(false)} title="Add a market">
        <ScrollView style={{ maxHeight: 420 }}>
          {CURRENCIES.filter((cur) => !draft.some((m) => m.currency === cur.code)).map((cur) => (
            <Row
              key={cur.code}
              left={<Text variant="title">{cur.flag}</Text>}
              title={`${cur.code} · ${cur.name}`}
              onPress={() => {
                setDraft([...draft, defaultMarket(cur.code)]);
                setAdding(false);
                setEditing(cur.code);
              }}
            />
          ))}
        </ScrollView>
      </Sheet>
      {market && (
        <MarketSheet
          market={market}
          onClose={() => setEditing(null)}
          onSave={(m) => {
            setDraft(draft.map((x) => (x.currency === m.currency ? m : x)));
            setEditing(null);
          }}
          onRemove={
            draft.length > 1
              ? () => {
                  setDraft(draft.filter((x) => x.currency !== market.currency));
                  setEditing(null);
                }
              : undefined
          }
        />
      )}
    </Screen>
  );
}

function MarketSheet({ market, onClose, onSave, onRemove }: { market: Market; onClose: () => void; onSave: (m: Market) => void; onRemove?: () => void }) {
  const [m, setM] = useState<Market>(market);
  const [channelEdit, setChannelEdit] = useState<string | null>(null);
  const rate = useWallet((s) => s.rates[market.currency]);
  const options = channelsForCurrency(m.currency);
  const valid = (s: MarketSide) => !s.enabled || (isDecimalAmount(s.min) && isDecimalAmount(s.max) && Number(s.min) <= Number(s.max) && s.spreadPct >= -5 && s.spreadPct <= 30);
  // Back and tap-outside close the sheet; don't let them silently drop edits.
  const close = () => {
    if (!channelEdit && JSON.stringify(m) === JSON.stringify(market)) return onClose();
    Alert.alert("Discard changes?", `Your changes to ${m.currency} haven't been saved.`, [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: onClose },
    ]);
  };

  return (
    <Sheet visible onClose={close} title={`${currencyInfo(m.currency).flag} ${m.currency}`}>
      <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ gap: space.lg }} keyboardShouldPersistTaps="handled">
        <Section title="Payment channels">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {options.map((ch) => {
              const on = ch.id in m.channels;
              const done = detailsComplete(ch.id, m.channels[ch.id]);
              return <Chip key={ch.id} label={ch.short} icon={on ? (done ? "check" : "alert-circle") : "plus"} selected={on} onPress={() => setChannelEdit(ch.id)} />;
            })}
          </View>
          {channelEdit && (
            <ChannelForm
              channel={channelEdit}
              initial={m.channels[channelEdit]}
              onDone={(d) => {
                const channels = { ...m.channels };
                if (d) channels[channelEdit] = d;
                else delete channels[channelEdit];
                setM({ ...m, channels });
                setChannelEdit(null);
              }}
            />
          )}
        </Section>
        <SideEditor
          title="Sell bitcoin to customers"
          hint="Customers pay you fiat. Your price is the market plus your margin."
          side={m.buy}
          sign={1}
          rate={rate}
          currency={m.currency}
          onChange={(buy) => setM({ ...m, buy })}
        />
        <SideEditor
          title="Buy bitcoin from customers"
          hint="You pay customers fiat. Your price is the market minus your margin."
          side={m.sell}
          sign={-1}
          rate={rate}
          currency={m.currency}
          onChange={(sell) => setM({ ...m, sell })}
        />
        {onRemove && <Button kind="danger" small title={`Remove ${m.currency}`} onPress={onRemove} />}
      </ScrollView>
      <Button title="Done" disabled={!valid(m.buy) || !valid(m.sell)} onPress={() => onSave(m)} />
    </Sheet>
  );
}

function SideEditor({ title, hint, side, sign, rate, currency, onChange }: { title: string; hint: string; side: MarketSide; sign: 1 | -1; rate?: number; currency: string; onChange: (s: MarketSide) => void }) {
  const price = useMemo(() => {
    try {
      return rate ? priceWithSpread(rate, sign * side.spreadPct) : null;
    } catch {
      return null;
    }
  }, [rate, side.spreadPct, sign]);
  return (
    <Card tone="alt">
      <Toggle label={title} subtitle={hint} value={side.enabled} onChange={(enabled) => onChange({ ...side, enabled })} />
      {side.enabled && (
        <>
          <Text variant="label">Margin</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {[0.5, 1, 2, 3, 5].map((p) => (
              <Chip key={p} label={`${p}%`} selected={side.spreadPct === p} onPress={() => onChange({ ...side, spreadPct: p })} />
            ))}
          </View>
          {price && (
            <Text variant="caption" muted>
              1 BTC = {currency} {formatDecimal(price, 0)} (market {formatDecimal(rate!.toFixed(0))})
            </Text>
          )}
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <View style={{ flex: 1 }}>
              <Field label={`Min ${currency}`} keyboardType="decimal-pad" value={side.min} onChangeText={(min) => onChange({ ...side, min: min.replace(/,/g, "") })} />
            </View>
            <View style={{ flex: 1 }}>
              <Field label={`Max ${currency}`} keyboardType="decimal-pad" value={side.max} onChangeText={(max) => onChange({ ...side, max: max.replace(/,/g, "") })} />
            </View>
          </View>
        </>
      )}
    </Card>
  );
}

function ChannelForm({ channel, initial, onDone }: { channel: string; initial?: ChannelDetails; onDone: (d: ChannelDetails | null) => void }) {
  const info = channelInfo(channel);
  const [d, setD] = useState<ChannelDetails>(initial ?? {});
  const check = validateDetails(channel, d);
  return (
    <Card>
      <Text variant="heading">{info.label}</Text>
      <Text variant="caption" muted>
        {info.fields.length ? "Where customers pay you. Sent privately to a customer only after you accept their swap." : info.description}
      </Text>
      <ChannelFields channel={channel} value={d} onChange={setD} />
      <View style={{ flexDirection: "row", gap: space.sm }}>
        {initial && <Button style={{ flex: 1 }} small kind="danger" title="Remove" onPress={() => onDone(null)} />}
        <Button style={{ flex: 1 }} small title={info.fields.length ? "Save channel" : "Offer cash"} disabled={!check.valid} onPress={() => onDone(check.data)} />
      </View>
    </Card>
  );
}

export function useConfirmLeaveAgent() {
  const setMode = useSession((s) => s.setMode);
  return () => {
    if (!useAgent.getState().online) return setMode("user");
    Alert.alert("Go offline?", "Switching to user mode takes your offers offline.", [
      { text: "Stay", style: "cancel" },
      {
        text: "Switch",
        onPress: async () => {
          await setAgentOnline(false).catch(() => undefined);
          setMode("user");
        },
      },
    ]);
  };
}
