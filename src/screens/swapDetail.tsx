import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import React, { useEffect, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from "react-native";
import type { Event } from "nostr-tools/pure";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useMe, useNow, useSwap } from "../hooks";
import { channelInfo, describeDetails } from "../lib/channels";
import { formatDecimal, formatSats } from "../lib/money";
import { settledAt, swapProfit } from "../lib/earnings";
import { countdown, describeSwap, shortPk, timeAgo } from "../lib/swapView";
import { npub } from "../lib/links";
import { type DisputeClass } from "../protocol/constants";
import { parseOffer } from "../protocol/offer";
import { parsePrivateTerms } from "../protocol/payloads";
import { bitcoinProvider, fiatReceiver, fiatSender } from "../protocol/swap";
import { fetchProfile } from "../services/discovery";
import * as engine from "../services/swapEngine";
import { chatOf, payloadFrom, unreadCount, useSwaps } from "../store/swaps";
import { Avatar, Badge, Button, Card, Chip, Collapsible, Field, Header, Notice, Row, Screen, Section, Spinner, Text, success, toneColors } from "../ui/components";
import { SwapCelebration } from "../ui/celebrate";
import { CopyField, Sheet, confirm, dismissConfirm, toast, toastError } from "../ui/extras";
import { KeyValue, Steps } from "../ui/rows";
import { radius, space, useColors } from "../ui/theme";

const DISPUTE_LABELS: Record<DisputeClass, string> = {
  fiat_not_received: "I didn't receive the money",
  incorrect_fiat_amount: "Wrong amount was sent",
  payment_reference_invalid: "The payment reference is wrong",
  escrow_not_secured: "The bitcoin was never locked",
  bitcoin_not_released: "The bitcoin wasn't released",
  conflicting_confirmation: "We disagree on what happened",
  timeout: "The other side stopped responding",
};

const ACTION_LABELS: Record<string, string> = {
  "core/accept": "Accepted",
  "core/decline": "Declined",
  "core/cancel": "Cancelled",
  "core/expire": "Expired",
  "core/secure": "Bitcoin locked",
  "swap/fiat_sent": "Payment marked sent",
  "swap/fiat_confirmed": "Payment confirmed",
  "core/authorize_settlement": "Release authorized",
  "core/settle": "Settled",
  "core/authorize_refund": "Refund authorized",
  "core/refund": "Refunded",
  "core/open_dispute": "Dispute opened",
  "core/resolve_dispute": "Dispute resolved",
};

function useCounterpartyName(id: string, pk: string | undefined, known?: string) {
  const patch = useSwaps((s) => s.patchLocal);
  useEffect(() => {
    if (!pk || known) return;
    fetchProfile(pk)
      .then((p) => p.name && patch(id, { counterpartyName: p.name }))
      .catch(() => undefined);
  }, [id, pk, known, patch]);
}

export function SwapDetailScreen() {
  const route = useRoute<any>();
  const nav = useNavigation<any>();
  const id: string = route.params.id;
  const item = useSwap(id);
  const me = useMe();
  const now = useNow(1000);
  const c = useColors();
  const [busy, setBusy] = useState<string | null>(null);
  const [refOpen, setRefOpen] = useState(false);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [lock, setLock] = useState<engine.LockCheck | null>(null);

  const counterparty = item ? (item.rec.role === "agent" ? item.st.root.customer : item.st.root.agent) : undefined;
  useCounterpartyName(id, counterparty, item?.rec.local.counterpartyName);

  const status = item?.st.status;
  // Celebrate a swap that just finished, once; not one opened from history.
  const fresh = (i: typeof item) => !!i && i.st.status === "settled" && !i.rec.local.celebratedAt && Math.floor(Date.now() / 1000) - (settledAt(i.st) ?? 0) < 15 * 60;
  const [celebrate, setCelebrate] = useState(() => fresh(item));
  useEffect(() => {
    if (!item || status !== "settled" || item.rec.local.celebratedAt) return;
    if (fresh(item)) setCelebrate(true);
    useSwaps.getState().patchLocal(item.rec.id, { celebratedAt: Math.floor(Date.now() / 1000) });
  }, [item, status]);
  // A question asked about the old state shouldn't be answerable in the new one.
  useEffect(() => dismissConfirm(), [status]);
  const iReceiveBtc = item ? bitcoinProvider(item.st.root) !== me : false;
  useEffect(() => {
    if (!item || !iReceiveBtc || !["secured", "fiat_sent", "fiat_confirmed", "settlement_authorized"].includes(status ?? "")) return;
    let alive = true;
    const check = () =>
      engine
        .verifyIncomingLock(id)
        .then((r) => alive && setLock(r))
        .catch(() => undefined);
    void check();
    const t = setInterval(check, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, status, iReceiveBtc, item?.rec.inbox.length]);

  if (!item) {
    return (
      <Screen back title="Swap">
        <Spinner label="Loading swap…" />
      </Screen>
    );
  }

  const { rec, st } = item;
  const { root } = st;
  const view = describeSwap(rec, st, me, now);
  const tone = toneColors(c, view.tone);
  const ch = channelInfo(root.terms.payment_channel);
  const isAgent = rec.role === "agent";
  const declineReasons = payloadFrom(rec, root.agent, "declined")?.reasons;
  // The agreed price, not one derived back from the rounded sats.
  const quotedPrice = (() => {
    try {
      return rec.local.quoteBytes ? parseOffer(JSON.parse(rec.local.quoteBytes) as Event, { verify: false }).price : null;
    } catch {
      return null;
    }
  })();
  const them = rec.local.counterpartyName || (isAgent ? "Customer" : "Agent");
  const unread = unreadCount(rec, me);
  const iPayFiat = fiatSender(root) === me;
  const iReceiveFiat = fiatReceiver(root) === me;

  const run = async (key: string, fn: () => Promise<void>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      success();
      if (done) toast(done, "success");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };

  // Where fiat goes: the agent's details (customer buying) or the customer's payout (customer selling).
  const payTo =
    root.terms.direction === "fiat_to_btc"
      ? payloadFrom(rec, root.agent, "accept")?.payment
      : parsePrivateTerms(rec.local.privateTermsBytes ?? payloadFrom(rec, root.customer, "request")?.private_terms ?? "")?.payout;
  const theirRef = (() => {
    const p = payloadFrom(rec, fiatSender(root), "fiat_sent");
    if (!p) return null;
    try {
      return (JSON.parse(p.reference) as { reference?: string }).reference ?? null;
    } catch {
      return null;
    }
  })();

  // Say who the clock is for: "You pay within" vs "robotop pays within".
  const deadline =
    st.status === "proposed"
      ? { label: isAgent ? "Reply within" : `${them} replies within`, at: root.expiresAt }
      : st.status === "secured" || st.status === "accepted"
        ? { label: iPayFiat ? "Pay within" : `${them} pays within`, at: root.terms.deadlines.fiat_pay_by }
        : st.status === "fiat_sent"
          ? { label: iReceiveFiat ? "Confirm within" : `${them} confirms within`, at: root.terms.deadlines.fiat_confirm_by }
          : null;

  const canCancel =
    !st.disputed && ((st.status === "proposed" && root.proposer === me && now < root.expiresAt) || (st.status === "accepted" && !rec.local.lockStartedAt && !payloadFrom(rec, bitcoinProvider(root), "locked")));
  const profit = swapProfit(rec, st);
  const checkingLock = iReceiveBtc && st.status === "secured" && !lock?.ok;
  const canDispute = !st.disputed && !view.done && st.status !== "proposed";
  // Only offer problems this side could actually have.
  const disputeReasons: DisputeClass[] = iReceiveFiat
    ? ["fiat_not_received", "incorrect_fiat_amount", ...(ch.fields.length ? (["payment_reference_invalid"] as const) : []), "conflicting_confirmation", "timeout"]
    : ["escrow_not_secured", "bitcoin_not_released", "conflicting_confirmation", "timeout"];

  const primary = (() => {
    if (view.action === "accept")
      return (
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Button style={{ flex: 1 }} kind="secondary" title="Decline" loading={busy === "decline"} onPress={async () => {
              const ok = await confirm({ title: "Decline this request?", message: `${them} will see that you couldn't take it, and can ask another agent.`, confirmLabel: "Decline", cancelLabel: "Keep it", tone: "danger" });
              if (ok) void run("decline", () => engine.declineSwap(id), "Declined");
            }} />
          <Button style={{ flex: 2 }} title="Accept" loading={busy === "accept"} onPress={() => run("accept", () => engine.acceptSwap(id), "Accepted")} />
        </View>
      );
    if (view.action === "pay")
      return (
        <Button
          title={ch.fields.length ? "I've sent the money" : `I've handed over ${view.fiatLabel}`}
          icon="check"
          loading={busy === "pay"}
          disabled={iReceiveBtc && !lock?.ok}
          // Cash has nothing to reference: one tap instead of a sheet.
          onPress={() => (ch.fields.length ? setRefOpen(true) : void run("pay", () => engine.markFiatSent(id, ""), "Marked as paid"))}
        />
      );
    if (view.action === "confirm")
      return (
        <Button
          title={`I've received ${view.fiatLabel}`}
          icon="check-circle"
          loading={busy === "confirm"}
          onPress={async () => {
            const ok = await confirm({
              title: `Release ${view.satsLabel}?`,
              message: ch.fields.length
                ? `Only continue once ${view.fiatLabel} is in your ${ch.short} account. Releasing can't be undone.`
                : `Only continue once you have the ${view.fiatLabel} in hand. Releasing can't be undone.`,
              confirmLabel: "Release bitcoin",
              cancelLabel: "Not yet",
              icon: "unlock",
            });
            if (ok) void run("confirm", () => engine.confirmAndRelease(id), "Bitcoin released");
          }}
        />
      );
    if (view.action === "resolve") return <ResolvePanel id={id} busy={busy} run={run} />;
    if (st.status === "proposed" && !isAgent && now >= root.expiresAt)
      return <Button title="Try another agent" onPress={() => nav.replace("NewSwap", { direction: root.terms.direction, currency: root.terms.fiat.currency, amount: root.terms.fiat.amount, avoidAgent: root.agent })} />;
    if (["declined", "expired"].includes(st.status) && !isAgent)
      return <Button title="Try another agent" onPress={() => nav.replace("NewSwap", { direction: root.terms.direction, currency: root.terms.fiat.currency, amount: root.terms.fiat.amount, avoidAgent: root.agent })} />;
    return null;
  })();

  return (
    <Screen
      back
      title={them}
      right={
        <Pressable onPress={() => nav.navigate("Chat", { id })} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.surface, alignItems: "center", justifyContent: "center" }}>
          <Feather name="message-circle" size={19} color={c.text} />
          {unread > 0 && <View style={{ position: "absolute", top: 6, right: 6, width: 9, height: 9, borderRadius: 5, backgroundColor: c.accent }} />}
        </Pressable>
      }
      footer={primary}
      onRefresh={() => void engine.refreshSwap(id)}
    >
      <View style={{ gap: space.md }}>
        <Badge label={view.title.toUpperCase()} tone="neutral" />
        {st.status === "settled" ? (
          <SwapCelebration
            play={celebrate}
            fiatCode={root.terms.fiat.currency}
            amountLabel={iReceiveBtc ? `+${view.satsLabel}` : `+${view.fiatLabel}`}
            caption={
              profit !== null
                ? `You earned ≈ ${root.terms.fiat.currency} ${profit.toFixed(2)} on this swap`
                : iReceiveBtc
                  ? `Paid ${view.fiatLabel} to ${them}`
                  : `Sold ${view.satsLabel} to ${them}`
            }
          />
        ) : (
          <>
            <Text variant="display">{checkingLock ? "Checking the lock" : view.headline}</Text>
            <Text muted>{checkingLock ? `Making sure ${view.satsLabel} are locked for you before you pay.` : view.detail}</Text>
          </>
        )}
        {!["declined", "cancelled", "expired", "settled"].includes(st.status) && <Steps step={iReceiveBtc && st.status === "secured" && !lock?.ok ? Math.min(view.step, 1) : view.step} tone={view.tone === "danger" ? "danger" : "ok"} />}
        {deadline && now < deadline.at && !st.disputed && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Feather name="clock" size={14} color={tone.fg} />
            <Text variant="caption" color={tone.fg}>
              {deadline.label} {countdown(deadline.at, now)}
            </Text>
          </View>
        )}
      </View>

      {rec.local.lastError && !view.done && (
        <Notice tone="warning" title="Retrying" action={<Button small kind="secondary" title="Retry now" onPress={() => engine.schedule(id)} />}>
          {rec.local.lastError}
        </Notice>
      )}

      {isAgent && rec.local.problems && rec.local.problems.length > 0 && (st.status === "proposed" || st.status === "declined") && (
        <Notice tone="danger" title={st.status === "declined" ? "Declined automatically" : "This request doesn't match your offer"}>
          {rec.local.problems.join(" · ")}
        </Notice>
      )}

      {!isAgent && st.status === "declined" && declineReasons && declineReasons.length > 0 && (
        <Notice tone="warning" title="Why it was declined">
          {declineReasons.join(" · ")}
        </Notice>
      )}

      {/* Lock status for whoever is receiving bitcoin */}
      {iReceiveBtc && ["secured", "fiat_sent", "fiat_confirmed", "settlement_authorized"].includes(st.status) && (
        <Card tone={lock?.ok ? "primary" : "alt"} style={{ flexDirection: "row", alignItems: "center" }}>
          <Feather name={lock?.ok ? "lock" : "loader"} size={20} color={lock?.ok ? c.primary : c.textMuted} />
          <View style={{ flex: 1 }}>
            <Text variant="label">{lock?.ok ? `${view.satsLabel} locked for you` : "Checking the lock…"}</Text>
            <Text variant="caption" muted>
              {lock?.ok ? "Verified in your own wallet. It unlocks when the payment is confirmed." : (lock?.reason ?? "Looking in your wallet")}
            </Text>
          </View>
        </Card>
      )}

      {/* Payment instructions for whoever sends fiat */}
      {iPayFiat && (st.status === "secured" || (st.status === "fiat_sent" && ch.fields.length > 0)) && (
        <Section title={ch.fields.length ? (st.status === "secured" ? "Send the money to" : "You sent the money to") : st.status === "secured" ? "Pay in cash" : "You paid in cash"}>
          {payTo ? (
            <Card>
              <Row icon={ch.fields.length ? "smartphone" : "dollar-sign"} title={ch.label} subtitle={`Amount: ${view.fiatLabel}`} />
              {ch.fields.length > 0 && <CopyField value={root.terms.fiat.amount} label="Amount" />}
              {describeDetails(payTo.channel, payTo.details).map((d) =>
                // The payer needs the real number to pay it; masking is for showing details to others.
                d.copyValue ? <CopyField key={d.label} value={d.copyValue} label={d.label} /> : <KeyValue key={d.label} label={d.label} value={d.value} />,
              )}
              {st.status === "secured" && ch.payerInstructions.map((line) => (
                <Text key={line} variant="caption" muted>
                  {line}
                </Text>
              ))}
              {rec.local.referenceText && <KeyValue label={`Your ${ch.referenceLabel.toLowerCase()}`} value={rec.local.referenceText} />}
            </Card>
          ) : (
            <Spinner label="Waiting for payment details…" />
          )}
        </Section>
      )}

      {/* What the fiat receiver should look for */}
      {iReceiveFiat && st.status === "fiat_sent" && !st.disputed && (theirRef || (payTo && describeDetails(payTo.channel, payTo.details).length > 0)) && (
        <Card tone="accent">
          <Text variant="label">Look for</Text>
          <KeyValue label="Amount" value={view.fiatLabel} />
          {theirRef && <KeyValue label={ch.referenceLabel} value={theirRef} />}
          {payTo && describeDetails(payTo.channel, payTo.details).map((d) => <KeyValue key={d.label} label={`Into ${d.label.toLowerCase()}`} value={d.value} />)}
        </Card>
      )}

      <Collapsible title="Details" summary={`${view.fiatLabel} · ${formatSats(root.terms.bitcoin.amount)} · ${ch.short}`}>
        <Card>
          <KeyValue label="Amount" value={view.fiatLabel} />
          <KeyValue label="Bitcoin" value={formatSats(root.terms.bitcoin.amount)} />
          <KeyValue
            label="Rate"
            value={`1 BTC = ${root.terms.fiat.currency} ${formatDecimal(
              quotedPrice ?? ((Number(root.terms.fiat.amount) * 1e8) / Number(root.terms.bitcoin.amount)).toFixed(0),
              0,
            )}`}
          />
          <KeyValue label="Channel" value={ch.label} />
          <KeyValue label={isAgent ? "Customer" : "Agent"} value={rec.local.counterpartyName ?? shortPk(counterparty!)} />
          <KeyValue label="Started" value={timeAgo(root.createdAt, now)} />
        </Card>
      </Collapsible>

      <Collapsible title="Public record">
        <Card>
          <Text variant="caption" muted>
            Each step below is signed and published, so either side can prove what happened. Payment details never appear here.
          </Text>
          <KeyValue label="Created" value={shortTime(root.createdAt)} />
          {st.chain.map((a) => (
            <KeyValue
              key={a.id}
              label={ACTION_LABELS[a.action] ?? a.action}
              value={`${a.signer === root.escrow ? "escrow" : a.signer === root.resolver ? "resolver" : a.signer === me ? "you" : them} · ${new Date(a.createdAt * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`}
            />
          ))}
          {st.forked && <Notice tone="danger">Forked: {st.forkIds.length} competing actions.</Notice>}
          <CopyField value={root.id} label="Coordination id" short />
          <CopyField value={npub(counterparty!)} label={isAgent ? "Customer npub" : "Agent npub"} short />
        </Card>
      </Collapsible>

      <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
        {canCancel && (
          <Button
            small
            kind="secondary"
            title={isAgent ? "Cancel swap" : "Cancel request"}
            loading={busy === "cancel"}
            onPress={async () => {
              const ok = await confirm({
                title: isAgent ? "Cancel this swap?" : "Cancel this request?",
                message:
                  st.status === "proposed"
                    ? `${them} won't be able to accept it.`
                    : "The swap stops here. Any locked bitcoin goes back to its owner when the lock expires.",
                confirmLabel: "Cancel swap",
                cancelLabel: "Keep it",
                tone: "danger",
                icon: "x-circle",
              });
              if (ok) void run("cancel", () => engine.cancelSwap(id), "Cancelled");
            }}
          />
        )}
        {canDispute && <Button small kind="ghost" icon="flag" title="Report a problem" onPress={() => setDisputeOpen(true)} />}
      </View>

      <ReferenceSheet
        visible={refOpen}
        cash={ch.fields.length === 0}
        label={ch.referenceLabel}
        required={ch.referenceRequired}
        onClose={() => setRefOpen(false)}
        onSubmit={(r) =>
          run(
            "pay",
            async () => {
              await engine.markFiatSent(id, r);
              setRefOpen(false);
            },
            "Marked as sent",
          )
        }
        busy={busy === "pay"}
      />

      <Sheet visible={disputeOpen} onClose={() => setDisputeOpen(false)} title="What went wrong?">
        <Text variant="caption" muted>
          Reporting pauses the swap until it's settled or refunded. Locked bitcoin can't move meanwhile.
        </Text>
        {disputeReasons.map((cls) => (
          <Row
            key={cls}
            title={DISPUTE_LABELS[cls]}
            chevron
            onPress={async () => {
              setDisputeOpen(false);
              const ok = await confirm({
                title: "Pause this swap?",
                message: `${them} will see "${DISPUTE_LABELS[cls]}". Keep talking in chat to sort it out.`,
                confirmLabel: "Report problem",
                cancelLabel: "Go back",
                tone: "danger",
                icon: "flag",
              });
              if (ok) void run("dispute", () => engine.openDispute(id, cls), "Swap paused");
            }}
          />
        ))}
      </Sheet>
    </Screen>
  );
}

function shortTime(ts: number) {
  const d = new Date(ts * 1000);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function ReferenceSheet({ visible, cash, label, required, onClose, onSubmit, busy }: { visible: boolean; cash: boolean; label: string; required: boolean; onClose: () => void; onSubmit: (r: string) => void; busy: boolean }) {
  const [ref, setRef] = useState("");
  return (
    <Sheet visible={visible} onClose={onClose} title={cash ? "Cash handed over" : "Payment sent"}>
      <Text variant="caption" muted>
        {cash
          ? "Add a note if it helps the other side match your cash, like where you met. It's shared privately."
          : `Add the ${label.toLowerCase()} from your confirmation message so the other side can find your payment. It's shared privately.`}
      </Text>
      <Field label={required ? label : `${label} (optional)`} value={ref} onChangeText={setRef} autoCapitalize={cash ? "sentences" : "characters"} autoCorrect={false} placeholder={cash ? "e.g. at the shop on Moi Avenue" : "e.g. QJK3XY8Z1P"} />
      <Button title={cash ? "Confirm" : "Confirm sent"} disabled={required && ref.trim().length < 2} loading={busy} onPress={() => onSubmit(ref)} />
    </Sheet>
  );
}

function ResolvePanel({ id, busy, run }: { id: string; busy: string | null; run: (k: string, fn: () => Promise<void>, done?: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button title="Resolve dispute" icon="tool" loading={busy === "resolve"} onPress={() => setOpen(true)} />
      <Sheet visible={open} onClose={() => setOpen(false)} title="Resolve">
        <Text variant="caption" muted>
          As the agent you decide how a paused swap ends. Settle sends the locked bitcoin to its buyer; refund returns it to its owner when the lock expires.
        </Text>
        {(
          [
            ["resume", "Resume", "Carry on where the swap left off", "play", false],
            ["authorize_settlement", "Settle", "The money was paid: release the bitcoin", "check-circle", true],
            ["authorize_refund", "Refund", "The money wasn't paid: return the bitcoin", "rotate-ccw", true],
            ["cancel", "Cancel", "Call the swap off", "x-circle", true],
          ] as const
        ).map(([effect, title, sub, icon, final]) => (
          <Row
            key={effect}
            icon={icon}
            title={title}
            subtitle={sub}
            chevron
            onPress={async () => {
              setOpen(false);
              if (final && !(await confirm({ title: `${title} this swap?`, message: `${sub}. This can't be undone.`, confirmLabel: title, cancelLabel: "Go back", tone: effect === "authorize_settlement" ? "primary" : "danger" })))
                return;
              void run("resolve", () => engine.resolveDispute(id, effect), "Resolved");
            }}
          />
        ))}
      </Sheet>
    </>
  );
}

// -- chat ---------------------------------------------------------------------------

export function ChatScreen() {
  const route = useRoute<any>();
  const id: string = route.params.id;
  const item = useSwap(id);
  const me = useMe();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const markRead = useSwaps((s) => s.markRead);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const list = useRef<FlatList>(null);
  const messages = item ? chatOf(item.rec) : [];

  useEffect(() => {
    markRead(id);
  }, [id, messages.length, markRead]);

  if (!item) return null;
  const them = item.rec.local.counterpartyName || (item.rec.role === "agent" ? "Customer" : "Agent");
  const themPk = item.rec.role === "agent" ? item.st.root.customer : item.st.root.agent;

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    try {
      await engine.sendChat(id, body);
      setText("");
    } catch (e) {
      toastError(e);
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
      <Header back title={them} right={<Avatar pk={themPk} name={item.rec.local.counterpartyName} size={34} />} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <FlatList
          ref={list}
          data={[...messages].reverse()}
          inverted
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: space.lg, gap: space.sm }}
          ListFooterComponent={
            <View style={{ alignItems: "center", paddingBottom: space.lg, gap: space.sm }}>
              <Chip icon="lock" label="End-to-end encrypted" />
              <Text variant="caption" faint center style={{ maxWidth: 280 }}>
                Only you and {them} can read these messages. Never share your recovery phrase.
              </Text>
            </View>
          }
          renderItem={({ item: m }) => {
            const mine = m.from === me;
            return (
              <View style={{ alignItems: mine ? "flex-end" : "flex-start" }}>
                <View
                  style={{
                    maxWidth: "80%",
                    backgroundColor: mine ? c.primary : c.surface,
                    borderRadius: radius.lg,
                    borderBottomRightRadius: mine ? 6 : radius.lg,
                    borderBottomLeftRadius: mine ? radius.lg : 6,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                  }}
                >
                  <Text color={mine ? c.primaryText : c.text} selectable>
                    {m.text}
                  </Text>
                </View>
                <Text variant="caption" faint style={{ marginTop: 2, fontSize: 11 }}>
                  {new Date(m.createdAt * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                </Text>
              </View>
            );
          }}
        />
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: Math.max(insets.bottom, space.md) }}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Message"
            placeholderTextColor={c.textFaint}
            multiline
            style={{ flex: 1, maxHeight: 120, minHeight: 46, backgroundColor: c.surface, color: c.text, borderRadius: 23, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12, fontSize: 16 }}
          />
          <Pressable
            onPress={send}
            disabled={sending || !text.trim()}
            style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: text.trim() ? c.primary : c.surfaceAlt, alignItems: "center", justifyContent: "center" }}
          >
            <Feather name="arrow-up" size={22} color={text.trim() ? c.primaryText : c.textFaint} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
