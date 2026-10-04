import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { errorText } from "../lib/errors";
import { useFiatOf } from "../hooks";
import { formatSats } from "../lib/money";
import { parseAgentLink } from "../lib/links";
import * as wallet from "../services/wallet";
import { useWallet } from "../store/wallet";
import { Button, Card, Field, Notice, Screen, Text, success } from "../ui/components";
import { NumPad, toast } from "../ui/extras";
import { KeyValue } from "../ui/rows";
import { space, useColors } from "../ui/theme";

export function SendScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const balance = useWallet((s) => s.balance);
  const fiatOf = useFiatOf();
  const c = useColors();
  const [text, setText] = useState<string>(route.params?.input ?? "");
  const [parsed, setParsed] = useState<wallet.ParsedInput | null>(null);
  const [amount, setAmount] = useState("0");
  const [prepared, setPrepared] = useState<wallet.PreparedSend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parse = async (value: string) => {
    setError(null);
    setPrepared(null);
    if (!value.trim()) return;
    const agent = parseAgentLink(value);
    if (agent) {
      nav.replace("AgentProfile", { pk: agent });
      return;
    }
    setBusy(true);
    try {
      const p = await wallet.parseInput(value);
      setParsed(p);
      if (p.type === "bolt11") {
        if (!p.amountSats) throw new Error("This invoice has no amount. Ask for one with an amount.");
        setPrepared(await wallet.prepareSend(p));
      } else if (p.type !== "lnurl" && p.amountSats) {
        setAmount(String(p.amountSats));
      }
    } catch (e) {
      setParsed(null);
      const text = errorText(e);
      setError(
        text.startsWith("SdkError.InvalidInput") || text.includes("Unrecognized") || text.includes("parse")
          ? "That isn't an invoice, Lightning address or bitcoin address."
          : text,
      );
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (route.params?.input) void parse(route.params.input);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params?.input]);

  const review = async () => {
    if (!parsed) return;
    setBusy(true);
    setError(null);
    try {
      setPrepared(await wallet.prepareSend(parsed, BigInt(amount)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!prepared) return;
    setBusy(true);
    try {
      const tx = await prepared.send();
      success();
      toast(tx.status === "complete" ? `Sent ${formatSats(tx.amountSats)}` : "Payment on its way", "success");
      void useWallet.getState().refresh();
      nav.goBack();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  // 1. destination
  if (!parsed) {
    return (
      <Screen
        back
        title="Send"
        footer={<Button title="Continue" loading={busy} disabled={!text.trim()} onPress={() => parse(text)} />}
      >
        <Field
          label="Pay to"
          value={text}
          onChangeText={setText}
          placeholder="Invoice, Lightning address or bitcoin address"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          error={error}
        />
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Button
            style={{ flex: 1 }}
            kind="secondary"
            icon="clipboard"
            title="Paste"
            onPress={async () => {
              const v = await Clipboard.getStringAsync();
              setText(v);
              void parse(v);
            }}
          />
          <Button style={{ flex: 1 }} kind="secondary" icon="maximize" title="Scan" onPress={() => nav.navigate("Scan")} />
        </View>
      </Screen>
    );
  }

  const dest =
    parsed.type === "lnurl" ? (parsed.address ?? "Lightning") : parsed.type === "bolt11" ? "Lightning invoice" : parsed.type === "spark" ? "Spark address" : parsed.address;

  // 2. amount
  if (!prepared) {
    const sats = Number(amount);
    const tooMuch = balance !== null && sats > balance;
    const outOfRange = parsed.type === "lnurl" && (BigInt(sats) < parsed.minSats || BigInt(sats) > parsed.maxSats);
    return (
      <Screen
        back
        title="Amount"
        scroll={false}
        footer={<Button title="Review" loading={busy} disabled={sats <= 0 || tooMuch || outOfRange} onPress={review} />}
      >
        <Text variant="caption" muted center numberOfLines={1}>
          To {dest}
        </Text>
        <View style={{ alignItems: "center", gap: 4, paddingVertical: space.lg }}>
          <Text variant="hero">{Number(amount).toLocaleString()}</Text>
          <Text muted>sats {fiatOf(sats) ? `· ${fiatOf(sats)}` : ""}</Text>
          {tooMuch && <Text variant="caption" color={c.danger}>More than your balance</Text>}
          {outOfRange && parsed.type === "lnurl" && (
            <Text variant="caption" faint>
              Between {formatSats(parsed.minSats)} and {formatSats(parsed.maxSats)}
            </Text>
          )}
          {error && <Text variant="caption" color={c.danger}>{error}</Text>}
        </View>
        <View style={{ flex: 1 }} />
        <NumPad value={amount} onChange={setAmount} decimals={0} max={10} />
      </Screen>
    );
  }

  // 3. confirm
  const total = prepared.amountSats + prepared.feeSats;
  return (
    <Screen back title="Confirm" footer={<Button title={`Send ${formatSats(prepared.amountSats)}`} loading={busy} onPress={confirm} />}>
      <View style={{ alignItems: "center", gap: 4, paddingVertical: space.xl }}>
        <Text variant="hero">{Number(prepared.amountSats).toLocaleString()}</Text>
        <Text muted>sats {fiatOf(prepared.amountSats) ? `· ${fiatOf(prepared.amountSats)}` : ""}</Text>
      </View>
      <Card>
        <KeyValue label="To" value={dest} />
        {parsed.type === "bolt11" && parsed.description ? <KeyValue label="For" value={parsed.description} /> : null}
        <KeyValue label="Network fee" value={formatSats(prepared.feeSats)} />
        <KeyValue label="Total" value={formatSats(total)} />
      </Card>
      {balance !== null && total > BigInt(balance) && <Notice tone="danger">Not enough balance for this payment and its fee.</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
    </Screen>
  );
}

export function ScanScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const [permission, request] = useCameraPermissions();
  const handled = useRef(false);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void request();
  }, [permission, request]);

  const onCode = (data: string) => {
    if (handled.current) return;
    handled.current = true;
    success();
    const agent = parseAgentLink(data);
    if (agent) nav.replace("AgentProfile", { pk: agent });
    else nav.replace("Send", { input: data });
  };

  if (!permission?.granted) {
    return (
      <Screen back title="Scan">
        <Notice tone="info" title="Camera access needed" action={<Button small title="Allow camera" onPress={() => void request()} />}>
          Pontspark uses the camera only to read QR codes.
        </Notice>
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => onCode(data)}
      />
      <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]} pointerEvents="none">
        <View style={{ width: 250, height: 250, borderRadius: 28, borderWidth: 3, borderColor: "rgba(255,255,255,0.9)" }} />
        <Text variant="label" color="#ffffff" style={{ marginTop: space.xl }}>
          Point at a payment or agent QR code
        </Text>
      </View>
      <Pressable
        onPress={() => nav.goBack()}
        style={{ position: "absolute", top: insets.top + 12, left: 16, width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center" }}
      >
        <Feather name="x" size={22} color="#fff" />
      </Pressable>
    </View>
  );
}
