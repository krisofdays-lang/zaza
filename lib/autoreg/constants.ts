// ── Autoreg constants ─────────────────────────────────────────────────────
// Build-wide values (app version, bloks, app id, capabilities, prism headers)
// are imported from the shared lib/instagram/devices.ts so autoreg always uses
// the same pinned build as the rest of the project. Only autoreg-specific data
// (device pools, locale maps, delay timings) is defined here.

// Re-export the pinned build constants under the names the autoreg engine uses.
export {
  PINNED_IG_APP_VERSION as PINNED_IG_VERSION,
  PINNED_IG_VERSION_CODE as PINNED_IG_BUILD,
  BLOKS_VERSION_ID as PINNED_BLOKS_VERSION_ID,
  IG_APP_ID as PINNED_IG_APP_ID,
  IG_CAPABILITIES as PINNED_IG_CAPABILITIES,
  BLOKS_PRISM_HEADERS,
} from "@/lib/instagram/devices"

// GraphQL client_doc_id for BKAppRootQuery (synchronous bloks requests).
export const CLIENT_DOC_ID_APP = "252507231518090881989663115110"
// GraphQL client_doc_id for BKActionRootQuery (async bloks actions).
export const CLIENT_DOC_ID_ACTION = "398678489412499626688914657582"

// Bloks context sent with every bloks request.
export const BK_CONTEXT = {
  pixel_ratio: 3,
  styles_id: "instagram",
  theme_params: [
    {
      design_system_name: "XMDS",
      value: ["three_neutral_gray"],
    },
  ],
}

// iOS releases with build numbers — needed for the User-Agent.
export interface IosRelease {
  v: string   // e.g. "18_5"
  build: string // e.g. "22F76"
  major: number
}

export const IOS_RELEASES: IosRelease[] = [
  { v: "15_5", build: "19F77", major: 15 },
  { v: "15_6_1", build: "19G82", major: 15 },
  { v: "15_7_1", build: "19H117", major: 15 },
  { v: "16_0", build: "20A362", major: 16 },
  { v: "16_1_1", build: "20B101", major: 16 },
  { v: "16_2", build: "20C65", major: 16 },
  { v: "16_3_1", build: "20D67", major: 16 },
  { v: "16_4_1", build: "20E252", major: 16 },
  { v: "16_5_1", build: "20F75", major: 16 },
  { v: "16_6_1", build: "20G81", major: 16 },
  { v: "16_7_2", build: "20H115", major: 16 },
  { v: "17_0_3", build: "21A360", major: 17 },
  { v: "17_1_1", build: "21B91", major: 17 },
  { v: "17_2_1", build: "21C66", major: 17 },
  { v: "17_3_1", build: "21D61", major: 17 },
  { v: "17_4_1", build: "21E237", major: 17 },
  { v: "17_5_1", build: "21F90", major: 17 },
  { v: "17_6_1", build: "21G93", major: 17 },
  { v: "17_7", build: "21H16", major: 17 },
  { v: "18_0_1", build: "22A3370", major: 18 },
  { v: "18_1_1", build: "22B91", major: 18 },
  { v: "18_2_1", build: "22C161", major: 18 },
  { v: "18_3_2", build: "22D72", major: 18 },
  { v: "18_4_1", build: "22E252", major: 18 },
  { v: "18_5", build: "22F76", major: 18 },
]

// iPhone models with their display specs and iOS compatibility ranges.
export interface IphoneDevice {
  model: string
  name: string
  res: string       // logical resolution "WxH"
  scale: string     // retina scale
  wLogical: number  // logical width
  hLogical: number  // logical height
  iosMin: number    // min iOS major
  iosMax: number    // max iOS major (inclusive)
}

export const IPHONE_DEVICES: IphoneDevice[] = [
  // A12 — iOS 15–18
  { model: "iPhone11,8", name: "iPhone XR", res: "828x1792", scale: "2.00", wLogical: 414, hLogical: 896, iosMin: 15, iosMax: 18 },
  { model: "iPhone11,2", name: "iPhone XS", res: "1125x2436", scale: "3.00", wLogical: 375, hLogical: 812, iosMin: 15, iosMax: 18 },
  { model: "iPhone11,6", name: "iPhone XS Max", res: "1242x2688", scale: "3.00", wLogical: 414, hLogical: 896, iosMin: 15, iosMax: 18 },
  // A13
  { model: "iPhone12,1", name: "iPhone 11", res: "828x1792", scale: "2.00", wLogical: 414, hLogical: 896, iosMin: 15, iosMax: 18 },
  { model: "iPhone12,3", name: "iPhone 11 Pro", res: "1125x2436", scale: "3.00", wLogical: 375, hLogical: 812, iosMin: 15, iosMax: 18 },
  { model: "iPhone12,5", name: "iPhone 11 Pro Max", res: "1242x2688", scale: "3.00", wLogical: 414, hLogical: 896, iosMin: 15, iosMax: 18 },
  // A14
  { model: "iPhone13,1", name: "iPhone 12 mini", res: "1080x2340", scale: "3.00", wLogical: 360, hLogical: 780, iosMin: 15, iosMax: 18 },
  { model: "iPhone13,2", name: "iPhone 12", res: "1170x2532", scale: "3.00", wLogical: 390, hLogical: 844, iosMin: 15, iosMax: 18 },
  { model: "iPhone13,3", name: "iPhone 12 Pro", res: "1170x2532", scale: "3.00", wLogical: 390, hLogical: 844, iosMin: 15, iosMax: 18 },
  { model: "iPhone13,4", name: "iPhone 12 Pro Max", res: "1284x2778", scale: "3.00", wLogical: 428, hLogical: 926, iosMin: 15, iosMax: 18 },
  // A15
  { model: "iPhone14,4", name: "iPhone 13 mini", res: "1080x2340", scale: "3.00", wLogical: 360, hLogical: 780, iosMin: 15, iosMax: 18 },
  { model: "iPhone14,5", name: "iPhone 13", res: "1170x2532", scale: "3.00", wLogical: 390, hLogical: 844, iosMin: 15, iosMax: 18 },
  { model: "iPhone14,2", name: "iPhone 13 Pro", res: "1170x2532", scale: "3.00", wLogical: 390, hLogical: 844, iosMin: 15, iosMax: 18 },
  { model: "iPhone14,3", name: "iPhone 13 Pro Max", res: "1284x2778", scale: "3.00", wLogical: 428, hLogical: 926, iosMin: 15, iosMax: 18 },
  // A15 (14 non-Pro)
  { model: "iPhone14,7", name: "iPhone 14", res: "1170x2532", scale: "3.00", wLogical: 390, hLogical: 844, iosMin: 16, iosMax: 18 },
  { model: "iPhone14,8", name: "iPhone 14 Plus", res: "1284x2778", scale: "3.00", wLogical: 428, hLogical: 926, iosMin: 16, iosMax: 18 },
  // A16
  { model: "iPhone15,2", name: "iPhone 14 Pro", res: "1179x2556", scale: "3.00", wLogical: 393, hLogical: 852, iosMin: 16, iosMax: 18 },
  { model: "iPhone15,3", name: "iPhone 14 Pro Max", res: "1290x2796", scale: "3.00", wLogical: 430, hLogical: 932, iosMin: 16, iosMax: 18 },
  // A16 (15 non-Pro)
  { model: "iPhone15,4", name: "iPhone 15", res: "1179x2556", scale: "3.00", wLogical: 393, hLogical: 852, iosMin: 17, iosMax: 18 },
  { model: "iPhone15,5", name: "iPhone 15 Plus", res: "1290x2796", scale: "3.00", wLogical: 430, hLogical: 932, iosMin: 17, iosMax: 18 },
  // A17 Pro
  { model: "iPhone16,1", name: "iPhone 15 Pro", res: "1179x2556", scale: "3.00", wLogical: 393, hLogical: 852, iosMin: 17, iosMax: 18 },
  { model: "iPhone16,2", name: "iPhone 15 Pro Max", res: "1290x2796", scale: "3.00", wLogical: 430, hLogical: 932, iosMin: 17, iosMax: 18 },
  // A18 — shipped on iOS 18 only
  { model: "iPhone17,3", name: "iPhone 16", res: "1179x2556", scale: "3.00", wLogical: 393, hLogical: 852, iosMin: 18, iosMax: 18 },
  { model: "iPhone17,4", name: "iPhone 16 Plus", res: "1290x2796", scale: "3.00", wLogical: 430, hLogical: 932, iosMin: 18, iosMax: 18 },
  { model: "iPhone17,1", name: "iPhone 16 Pro", res: "1206x2622", scale: "3.00", wLogical: 402, hLogical: 874, iosMin: 18, iosMax: 18 },
  { model: "iPhone17,2", name: "iPhone 16 Pro Max", res: "1320x2868", scale: "3.00", wLogical: 440, hLogical: 956, iosMin: 18, iosMax: 18 },
]

// Country → locale mapping for geo-aware fingerprinting.
export const COUNTRY_LOCALE: Record<string, { locale: string; language: string; acceptLanguage: string }> = {
  US: { locale: "en_US", language: "en", acceptLanguage: "en-US;q=1.0" },
  GB: { locale: "en_GB", language: "en", acceptLanguage: "en-GB;q=1.0" },
  RU: { locale: "ru_RU", language: "ru", acceptLanguage: "ru-RU;q=1.0" },
  UA: { locale: "uk_UA", language: "uk", acceptLanguage: "uk-UA;q=1.0" },
  DE: { locale: "de_DE", language: "de", acceptLanguage: "de-DE;q=1.0" },
  FR: { locale: "fr_FR", language: "fr", acceptLanguage: "fr-FR;q=1.0" },
  ES: { locale: "es_ES", language: "es", acceptLanguage: "es-ES;q=1.0" },
  IT: { locale: "it_IT", language: "it", acceptLanguage: "it-IT;q=1.0" },
  PL: { locale: "pl_PL", language: "pl", acceptLanguage: "pl-PL;q=1.0" },
  TR: { locale: "tr_TR", language: "tr", acceptLanguage: "tr-TR;q=1.0" },
  BR: { locale: "pt_BR", language: "pt", acceptLanguage: "pt-BR;q=1.0" },
  MX: { locale: "es_MX", language: "es", acceptLanguage: "es-MX;q=1.0" },
  IN: { locale: "en_IN", language: "en", acceptLanguage: "en-IN;q=1.0" },
  ID: { locale: "id_ID", language: "id", acceptLanguage: "id-ID;q=1.0" },
  AE: { locale: "en_AE", language: "en", acceptLanguage: "en-AE;q=1.0" },
  JP: { locale: "ja_JP", language: "ja", acceptLanguage: "ja-JP;q=1.0" },
  KR: { locale: "ko_KR", language: "ko", acceptLanguage: "ko-KR;q=1.0" },
  NL: { locale: "nl_NL", language: "nl", acceptLanguage: "nl-NL;q=1.0" },
  SE: { locale: "sv_SE", language: "sv", acceptLanguage: "sv-SE;q=1.0" },
  NO: { locale: "nb_NO", language: "nb", acceptLanguage: "nb-NO;q=1.0" },
  DK: { locale: "da_DK", language: "da", acceptLanguage: "da-DK;q=1.0" },
  FI: { locale: "fi_FI", language: "fi", acceptLanguage: "fi-FI;q=1.0" },
  CZ: { locale: "cs_CZ", language: "cs", acceptLanguage: "cs-CZ;q=1.0" },
  RO: { locale: "ro_RO", language: "ro", acceptLanguage: "ro-RO;q=1.0" },
  PT: { locale: "pt_PT", language: "pt", acceptLanguage: "pt-PT;q=1.0" },
  AR: { locale: "es_AR", language: "es", acceptLanguage: "es-AR;q=1.0" },
  CL: { locale: "es_CL", language: "es", acceptLanguage: "es-CL;q=1.0" },
  CO: { locale: "es_CO", language: "es", acceptLanguage: "es-CO;q=1.0" },
  AU: { locale: "en_AU", language: "en", acceptLanguage: "en-AU;q=1.0" },
  CA: { locale: "en_CA", language: "en", acceptLanguage: "en-CA;q=1.0" },
  IE: { locale: "en_IE", language: "en", acceptLanguage: "en-IE;q=1.0" },
  NZ: { locale: "en_NZ", language: "en", acceptLanguage: "en-NZ;q=1.0" },
  ZA: { locale: "en_ZA", language: "en", acceptLanguage: "en-ZA;q=1.0" },
  TH: { locale: "th_TH", language: "th", acceptLanguage: "th-TH;q=1.0" },
  VN: { locale: "vi_VN", language: "vi", acceptLanguage: "vi-VN;q=1.0" },
  PH: { locale: "en_PH", language: "en", acceptLanguage: "en-PH;q=1.0" },
  EG: { locale: "ar_EG", language: "ar", acceptLanguage: "ar-EG;q=1.0" },
  SA: { locale: "ar_SA", language: "ar", acceptLanguage: "ar-SA;q=1.0" },
}

// Fallback timezone for country codes not covered by ip-api.
export const FALLBACK_TZ: Record<string, string> = {
  US: "America/Chicago",
  GB: "Europe/London",
  RU: "Europe/Moscow",
  UA: "Europe/Kyiv",
  DE: "Europe/Berlin",
  FR: "Europe/Paris",
  ES: "Europe/Madrid",
  IT: "Europe/Rome",
  PL: "Europe/Warsaw",
  TR: "Europe/Istanbul",
  BR: "America/Sao_Paulo",
  MX: "America/Mexico_City",
  IN: "Asia/Kolkata",
  ID: "Asia/Jakarta",
  AE: "Asia/Dubai",
  JP: "Asia/Tokyo",
}

// Delay ranges between registration steps (ms).
export const STEP_DELAY_MIN_MS = 8_000
export const STEP_DELAY_MAX_MS = 22_000

// Verification code polling.
export const CODE_WAIT_TIMEOUT_MS = 60_000
export const CODE_POLL_INTERVAL_MS = 3_000
