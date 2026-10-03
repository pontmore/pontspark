const { version } = require("./package.json");

const APP_ENV = process.env.EXPO_PUBLIC_APP_ENV || "development";
const IS_PRODUCTION = APP_ENV === "production";

const NATIVE = IS_PRODUCTION
  ? { name: "Pontspark", scheme: "pontmore", id: "xyz.pontmore.pontspark" }
  : { name: "Pontspark Dev", scheme: "pontmore", id: "xyz.pontmore.pontspark.dev" };

/** 1.2.3 -> 1002003, so every release installs over the previous one. */
function versionCode(semver) {
  const [major, minor, patch] = semver.split("-")[0].split(".").map(Number);
  return major * 1_000_000 + minor * 1_000 + patch;
}

const CAMERA_COPY =
  "Pontspark uses the camera to scan payment and agent QR codes. No photos are stored.";

export default {
  expo: {
    name: NATIVE.name,
    slug: "pontspark",
    scheme: NATIVE.scheme,
    version,
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "automatic",
    backgroundColor: "#f7f3ea",
    splash: {
      image: "./assets/splash.png",
      resizeMode: "contain",
      backgroundColor: "#f7f3ea",
      dark: { image: "./assets/splash.png", backgroundColor: "#0c140f" },
    },
    assetBundlePatterns: ["**/*"],
    ios: {
      supportsTablet: false,
      bundleIdentifier: NATIVE.id,
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        NSCameraUsageDescription: CAMERA_COPY,
        NSFaceIDUsageDescription: "Pontspark uses Face ID to protect your recovery phrase.",
      },
    },
    android: {
      package: NATIVE.id,
      versionCode: versionCode(version),
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#f7f3ea",
      },
      permissions: ["CAMERA", "USE_BIOMETRIC"],
      intentFilters: [
        {
          action: "VIEW",
          category: ["BROWSABLE", "DEFAULT"],
          data: [{ scheme: NATIVE.scheme }],
        },
      ],
    },
    plugins: [
      "@breeztech/breez-sdk-spark-react-native",
      ["expo-camera", { cameraPermission: CAMERA_COPY }],
      "expo-secure-store",
      "./plugins/withReleaseSigning",
      ["expo-local-authentication", { faceIDPermission: "Pontspark uses Face ID to protect your recovery phrase." }],
    ],
    extra: {
      appEnv: APP_ENV,
      breezApiKey: process.env.EXPO_PUBLIC_BREEZ_API_KEY,
      breezNetwork: process.env.EXPO_PUBLIC_BREEZ_NETWORK || "mainnet",
      defaultRelays: process.env.EXPO_PUBLIC_DEFAULT_RELAYS,
    },
  },
};
