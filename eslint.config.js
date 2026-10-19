// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

const nodeGlobals = { require: "readonly", module: "writable", __dirname: "readonly", process: "readonly", Buffer: "readonly", console: "readonly" };

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["android/*", "dist/*", "modules/*/android/*", ".expo/*", ".local/*"],
  },
  {
    rules: {
      // These check code for the React Compiler, which this app doesn't use. They flag
      // React Native's standard `useRef(new Animated.Value(…)).current` animations and
      // effects that sync state from props.
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      // Apostrophes in UI copy are plain text in JSX; only flag characters that break parsing.
      "react/no-unescaped-entities": ["error", { forbid: [">", "}"] }],
    },
  },
  {
    files: ["*.config.js", "scripts/**/*.{js,mjs}"],
    languageOptions: { globals: nodeGlobals },
  },
]);
