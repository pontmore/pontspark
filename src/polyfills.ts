// Must load before nostr-tools or @noble/* touch crypto.getRandomValues.
import "react-native-get-random-values";

// Hermes lacks Intl.DisplayNames, which names currencies and countries in
// src/lib/channels.ts. English CLDR data only, matching the app's copy.
import "@formatjs/intl-getcanonicallocales/polyfill.js";
import "@formatjs/intl-locale/polyfill.js";
import "@formatjs/intl-displaynames/polyfill.js";
import "@formatjs/intl-displaynames/locale-data/en.js";
