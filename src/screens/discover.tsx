import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import React, { useEffect, useMemo, useState } from "react";
import { ScrollView, Share, View } from "react-native";

import { channelInfo, currencyInfo, CURRENCIES } from "../lib/channels";
import { agentLink, npub, parseAgentLink } from "../lib/links";
import { formatDecimal } from "../lib/money";
import { escrowPkOf } from "../protocol/offer";
import { completedSwaps, type AgentListing } from "../services/discovery";
import { useDiscovery } from "../store/discovery";
import { useSession } from "../store/session";
import { Avatar, Badge, Button, Card, Chip, Empty, Field, IconButton, Notice, Screen, Spinner, Text } from "../ui/components";
import { CopyField, QR, Sheet } from "../ui/extras";
import { KeyValue } from "../ui/rows";
import { space, useColors } from "../ui/theme";

export function DiscoverScreen() {
  const nav = useNavigation<any>();
  const sessionCurrency = useSession((s) => s.currency);
  const [currency, setCurrency] = useState(sessionCurrency);
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState<string | null>(null);
  const { load, loading, byCurrency, error } = useDiscovery();

  useEffect(() => {
    void load(currency);
  }, [currency, load]);

  const listings = byCurrency[currency]?.listings ?? [];
  const channels = useMemo(() => [...new Set(listings.flatMap((l) => l.offers.flatMap((o) => o.channels)))], [listings]);
  const shown = listings.filter(
    (l) =>
      (!search || (l.profile.name ?? "").toLowerCase().includes(search.toLowerCase())) &&
      (!channel || l.offers.some((o) => o.channels.includes(channel))),
  );

  return (
    <Screen large title="Agents" onRefresh={() => void load(currency, true)} refreshing={loading && listings.length > 0}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }} style={{ marginHorizontal: -space.lg }}>
        <View style={{ width: space.lg - space.sm }} />
        {CURRENCIES.map((cur) => (
          <Chip
            key={cur.code}
            emoji={cur.flag}
            label={cur.code}
            selected={cur.code === currency}
            onPress={() => {
              setCurrency(cur.code);
              setChannel(null);
            }}
          />
        ))}
        <View style={{ width: space.lg - space.sm }} />
      </ScrollView>
      <Field value={search} onChangeText={setSearch} placeholder="Search agents" autoCorrect={false} />
      {channels.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
          <Chip label="All" selected={!channel} onPress={() => setChannel(null)} />
          {channels.map((c) => (
            <Chip key={c} label={channelInfo(c).short} selected={channel === c} onPress={() => setChannel(c)} />
          ))}
        </ScrollView>
      )}
      {error && <Notice tone="warning">{error}</Notice>}
      {loading && !listings.length ? (
        <Spinner label="Looking for agents on Nostr…" />
      ) : shown.length === 0 ? (
        <Empty
          icon="users"
          title={`No ${currencyInfo(currency).code} agents online`}
          body="Agents publish fresh offers while they're available. Check back soon, or become an agent yourself."
          action={<Button small kind="secondary" title="Become an agent" onPress={() => nav.navigate("AgentSetup")} />}
        />
      ) : (
        shown.map((l) => <AgentCard key={l.pk} listing={l} currency={currency} onPress={() => nav.navigate("AgentProfile", { pk: l.pk })} />)
      )}
    </Screen>
  );
}

function AgentCard({ listing, currency, onPress }: { listing: AgentListing; currency: string; onPress: () => void }) {
  const c = useColors();
  const offer = listing.markets.find((m) => m.currency === currency) ?? listing.markets[0];
  return (
    <Card onPress={onPress}>
      <View style={{ flexDirection: "row", gap: space.md, alignItems: "center" }}>
        <Avatar pk={listing.pk} name={listing.profile.name} />
        <View style={{ flex: 1 }}>
          <Text variant="heading" numberOfLines={1}>
            {listing.profile.name ?? "Unnamed agent"}
          </Text>
          <Text variant="caption" muted numberOfLines={1}>
            {listing.profile.about ?? offer.channels.map((x) => channelInfo(x).label).join(" · ")}
          </Text>
        </View>
        <Badge label="Online" tone="success" />
      </View>
      <View style={{ flexDirection: "row", gap: space.md }}>
        <PriceBox label="Buy" price={offer.buy?.price} currency={offer.currency} color={c.primary} />
        <PriceBox label="Sell" price={offer.sell?.price} currency={offer.currency} color={c.accent} />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {offer.channels.map((ch) => (
          <Badge key={ch} label={channelInfo(ch).short} />
        ))}
      </View>
    </Card>
  );
}

function PriceBox({ label, price, currency, color }: { label: string; price?: string; currency: string; color: string }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, backgroundColor: c.surfaceAlt, borderRadius: 12, padding: space.md, gap: 2 }}>
      <Text variant="tiny" color={color}>
        {label.toUpperCase()}
      </Text>
      <Text variant="label" numberOfLines={1}>
        {price ? `${currency} ${formatDecimal(price, 0)}` : "—"}
      </Text>
      <Text variant="caption" faint>
        per BTC
      </Text>
    </View>
  );
}

export function AgentProfileScreen() {
  const route = useRoute<any>();
  const nav = useNavigation<any>();
  const raw: string = route.params.pk;
  const pk = parseAgentLink(raw) ?? raw;
  const me = useSession((s) => s.keys?.identity.pk);
  const { agents, loadAgent } = useDiscovery();
  const [loading, setLoading] = useState(!agents[pk]);
  const [done, setDone] = useState<number | null>(null);
  const [qr, setQr] = useState(false);
  const c = useColors();
  const listing = agents[pk];

  useEffect(() => {
    loadAgent(pk).finally(() => setLoading(false));
  }, [pk, loadAgent]);
  useEffect(() => {
    if (listing) completedSwaps(escrowPkOf(listing.offers[0])).then(setDone).catch(() => undefined);
  }, [listing]);

  if (!listing) {
    return (
      <Screen back title="Agent">
        {loading ? <Spinner label="Finding this agent…" /> : <Empty icon="user-x" title="Agent is offline" body="They have no live offers right now. Try again later." />}
      </Screen>
    );
  }

  const self = me === pk;
  return (
    <Screen back right={<IconButton name="share-2" label="Share" onPress={() => setQr(true)} />}>
      <View style={{ alignItems: "center", gap: space.sm }}>
        <Avatar pk={pk} name={listing.profile.name} size={84} />
        <Text variant="title">{listing.profile.name ?? "Unnamed agent"}</Text>
        {listing.profile.about && (
          <Text muted center>
            {listing.profile.about}
          </Text>
        )}
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Badge label="Online" tone="success" icon="radio" />
          {done !== null && <Badge label={`${done} completed swap${done === 1 ? "" : "s"}`} tone="info" icon="check" />}
        </View>
      </View>

      {listing.markets.map((o) => (
        <Card key={o.currency}>
          <Text variant="heading">
            {currencyInfo(o.currency).flag} {o.currency}
          </Text>
          {o.buy && <KeyValue label="Sells you bitcoin at" value={`${o.currency} ${formatDecimal(o.buy.price, 0)}/BTC`} />}
          {o.buy && <KeyValue label="Buy limits" value={`${o.currency} ${formatDecimal(o.buy.min)} – ${formatDecimal(o.buy.max)}`} />}
          {o.sell && <KeyValue label="Buys your bitcoin at" value={`${o.currency} ${formatDecimal(o.sell.price, 0)}/BTC`} />}
          {o.sell && <KeyValue label="Sell limits" value={`${o.currency} ${formatDecimal(o.sell.min)} – ${formatDecimal(o.sell.max)}`} />}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {o.channels.map((ch) => (
              <Badge key={ch} label={channelInfo(ch).label} />
            ))}
          </View>
          {!self && (
            <View style={{ flexDirection: "row", gap: space.sm }}>
              {o.buy && (
                <Button style={{ flex: 1 }} small title="Buy" icon="plus" onPress={() => nav.navigate("NewSwap", { agentPk: pk, direction: "fiat_to_btc", currency: o.currency })} />
              )}
              {o.sell && (
                <Button style={{ flex: 1 }} small kind="secondary" title="Sell" icon="minus" onPress={() => nav.navigate("NewSwap", { agentPk: pk, direction: "btc_to_fiat", currency: o.currency })} />
              )}
            </View>
          )}
        </Card>
      ))}
      <Card tone="alt" style={{ flexDirection: "row", alignItems: "center" }}>
        <Feather name="info" size={16} color={c.textMuted} />
        <Text variant="caption" muted style={{ flex: 1 }}>
          Offers are signed by this agent, but a signature isn't a guarantee. Bitcoin is always locked before anyone sends money.
        </Text>
      </Card>
      <AgentShareSheet pk={pk} name={listing.profile.name} visible={qr} onClose={() => setQr(false)} />
    </Screen>
  );
}

export function AgentShareSheet({ pk, name, visible, onClose }: { pk: string; name?: string; visible: boolean; onClose: () => void }) {
  const link = agentLink(pk);
  return (
    <Sheet visible={visible} onClose={onClose} title={name ? `Swap with ${name}` : "Agent link"}>
      <QR value={link} size={200} />
      <CopyField value={npub(pk)} short label="npub" />
      <Button title="Share link" icon="share" onPress={() => void Share.share({ message: `Swap bitcoin with ${name ?? "me"} on Pontspark: ${link}` })} />
    </Sheet>
  );
}
