// iPhone hardware presets used to build a realistic Instagram iOS User-Agent.
// The "model" is the internal identifier Instagram sends (e.g. iPhone11,8).

export interface IphonePreset {
  model: string // internal identifier sent in UA
  name: string // human friendly name
  resolution: string // logical pixel resolution "WIDTHxHEIGHT"
  scale: string // retina scale factor
  dpi: string
  minIosMajor: number // lowest iOS major this hardware can run
}

// Only iPhones that can run iOS 17+ are listed. iOS 17 requires an A12 chip or
// newer, so the oldest supported models are the iPhone XS / XR (iPhone11,x).
// `minIosMajor` is the earliest iOS a given model shipped with / supports, so we
// never pair (say) an iPhone 16 with iOS 17 — an impossible combo is a bot tell.
export const IPHONE_PRESETS: IphonePreset[] = [
  // A12 — support iOS 17 and 18
  { model: "iPhone11,8", name: "iPhone XR", resolution: "828x1792", scale: "2.00", dpi: "326", minIosMajor: 17 },
  { model: "iPhone11,2", name: "iPhone XS", resolution: "1125x2436", scale: "3.00", dpi: "458", minIosMajor: 17 },
  { model: "iPhone11,6", name: "iPhone XS Max", resolution: "1242x2688", scale: "3.00", dpi: "458", minIosMajor: 17 },
  { model: "iPhone12,1", name: "iPhone 11", resolution: "828x1792", scale: "2.00", dpi: "326", minIosMajor: 17 },
  { model: "iPhone12,3", name: "iPhone 11 Pro", resolution: "1125x2436", scale: "3.00", dpi: "458", minIosMajor: 17 },
  { model: "iPhone12,5", name: "iPhone 11 Pro Max", resolution: "1242x2688", scale: "3.00", dpi: "458", minIosMajor: 17 },
  { model: "iPhone13,1", name: "iPhone 12 mini", resolution: "1080x2340", scale: "3.00", dpi: "476", minIosMajor: 17 },
  { model: "iPhone13,2", name: "iPhone 12", resolution: "1170x2532", scale: "3.00", dpi: "460", minIosMajor: 17 },
  { model: "iPhone13,3", name: "iPhone 12 Pro", resolution: "1170x2532", scale: "3.00", dpi: "460", minIosMajor: 17 },
  { model: "iPhone13,4", name: "iPhone 12 Pro Max", resolution: "1284x2778", scale: "3.00", dpi: "458", minIosMajor: 17 },
  { model: "iPhone14,4", name: "iPhone 13 mini", resolution: "1080x2340", scale: "3.00", dpi: "476", minIosMajor: 17 },
  { model: "iPhone14,5", name: "iPhone 13", resolution: "1170x2532", scale: "3.00", dpi: "460", minIosMajor: 17 },
  { model: "iPhone14,2", name: "iPhone 13 Pro", resolution: "1170x2532", scale: "3.00", dpi: "460", minIosMajor: 17 },
  { model: "iPhone14,3", name: "iPhone 13 Pro Max", resolution: "1284x2778", scale: "3.00", dpi: "458", minIosMajor: 17 },
  { model: "iPhone14,7", name: "iPhone 14", resolution: "1170x2532", scale: "3.00", dpi: "460", minIosMajor: 17 },
  { model: "iPhone14,8", name: "iPhone 14 Plus", resolution: "1284x2778", scale: "3.00", dpi: "458", minIosMajor: 17 },
  { model: "iPhone15,2", name: "iPhone 14 Pro", resolution: "1179x2556", scale: "3.00", dpi: "460", minIosMajor: 17 },
  { model: "iPhone15,3", name: "iPhone 14 Pro Max", resolution: "1290x2796", scale: "3.00", dpi: "460", minIosMajor: 17 },
  { model: "iPhone15,4", name: "iPhone 15", resolution: "1179x2556", scale: "3.00", dpi: "460", minIosMajor: 17 },
  { model: "iPhone15,5", name: "iPhone 15 Plus", resolution: "1290x2796", scale: "3.00", dpi: "460", minIosMajor: 17 },
  { model: "iPhone16,1", name: "iPhone 15 Pro", resolution: "1179x2556", scale: "3.00", dpi: "460", minIosMajor: 17 },
  { model: "iPhone16,2", name: "iPhone 15 Pro Max", resolution: "1290x2796", scale: "3.00", dpi: "460", minIosMajor: 17 },
  // iPhone 16 family — shipped on iOS 18, cannot run iOS 17
  { model: "iPhone17,3", name: "iPhone 16", resolution: "1179x2556", scale: "3.00", dpi: "460", minIosMajor: 18 },
  { model: "iPhone17,4", name: "iPhone 16 Plus", resolution: "1290x2796", scale: "3.00", dpi: "460", minIosMajor: 18 },
  { model: "iPhone17,1", name: "iPhone 16 Pro", resolution: "1206x2622", scale: "3.00", dpi: "460", minIosMajor: 18 },
  { model: "iPhone17,2", name: "iPhone 16 Pro Max", resolution: "1320x2868", scale: "3.00", dpi: "460", minIosMajor: 18 },
]

// iOS versions we present, restricted to iOS 17+ (the minimum the pinned build
// targets), formatted the way Instagram expects in the UA (underscore-separated,
// e.g. 18_5). Newest last so the list reads chronologically.
export const IOS_VERSIONS: string[] = [
  "17_0",
  "17_0_3",
  "17_1_1",
  "17_2_1",
  "17_3_1",
  "17_4_1",
  "17_5_1",
  "17_6_1",
  "18_0_1",
  "18_1_1",
  "18_2_1",
  "18_3_2",
  "18_4_1",
  "18_5",
]

// Recent Instagram for iOS app versions, newest first. The first entry is used
// as the default when building a new account's User-Agent.
export const IG_APP_VERSIONS: string[] = [
  "448.0.0.39.66",
  "447.0.0.34.80",
  "437.0.0.22.50",
  "436.0.0",
  "435.1.0",
  "435.0.0",
  "434.0.0",
  "433.1.0",
  "432.0.0",
  "431.0.0",
  "430.0.0",
  "429.0.0",
  "428.2.0",
  "428.1.0",
]

export const LATEST_IG_APP_VERSION = IG_APP_VERSIONS[0]

// The app version we ACTUALLY send on the wire. It is pinned to the exact build
// the captured traffic came from so it stays consistent with the GraphQL doc_ids
// and the x-bloks-version-id we replay (all captured from this same build). The
// per-account `appVersion` field and the settings dropdown are kept purely for
// display/bookkeeping — the real User-Agent is always rebuilt from this pin,
// varying only the iPhone model and iOS version per account.
export const PINNED_IG_APP_VERSION = "448.0.0.39.66"

// The numeric "version code" (final field in the UA parentheses). It is tied to
// the app BUILD, not the device: every real iPhone running 448.0.0.39.66 emits
// this exact value. It must therefore be identical across all accounts (just
// like x-ig-app-id and x-bloks-version-id). Randomizing it per device is a bot
// tell because the version code would no longer match the pinned app version.
export const PINNED_IG_VERSION_CODE = "1072661960"

// ── Build-wide constants (same for ALL accounts, tied to the pinned build) ──
// Moved here so both the main client and autoreg import from one place.

export const IG_APP_ID = "124024574287414"

export const BLOKS_VERSION_ID =
  "962e8adcff14724d83afff88f2db8ff321b1d3cf53fee9b37a9fcaa1eb9a0306"

export const IG_CAPABILITIES = "36r/F/8="

// Static Bloks/Prism UI feature flags the app attaches to every request.
export const BLOKS_PRISM_HEADERS: Record<string, string> = {
  "x-bloks-is-prism-enabled": "true",
  "x-bloks-prism-ax-base-colors-enabled": "true",
  "x-bloks-prism-button-version": "INDIGO_PRIMARY_BORDERED_SECONDARY",
  "x-bloks-prism-colors-enabled": "true",
  "x-bloks-prism-extended-palette-gray": "true",
  "x-bloks-prism-extended-palette-gray-10-variant": "1",
  "x-bloks-prism-extended-palette-indigo": "true",
  "x-bloks-prism-extended-palette-polish-enabled": "true",
  "x-bloks-prism-extended-palette-red": "true",
  "x-bloks-prism-extended-palette-rest-of-colors": "true",
  "x-bloks-prism-font-enabled": "false",
  "x-bloks-prism-link-colors-enabled": "1",
}

export function getPreset(model: string): IphonePreset {
  return IPHONE_PRESETS.find((p) => p.model === model) ?? IPHONE_PRESETS[0]
}

// Major version number from an underscore iOS string ("18_5" -> 18).
export function iosMajor(version: string): number {
  return Number.parseInt((version || "").split("_")[0], 10) || 0
}

// The iOS versions a given iPhone model can actually run, so the UI never offers
// (and we never send) an impossible hardware/OS pairing.
export function iosVersionsForModel(model: string): string[] {
  const preset = getPreset(model)
  return IOS_VERSIONS.filter((v) => iosMajor(v) >= preset.minIosMajor)
}

// Clamp an iOS version to something the model supports; falls back to the newest
// compatible version when the current one is too old for the hardware.
export function resolveIosForModel(model: string, iosVersion: string): string {
  const allowed = iosVersionsForModel(model)
  if (allowed.includes(iosVersion)) return iosVersion
  return allowed[allowed.length - 1] ?? IOS_VERSIONS[IOS_VERSIONS.length - 1]
}

// Pick a random iPhone model paired with an iOS version it can actually run.
// Used at account creation so the device fingerprint is assigned automatically
// (the user no longer chooses hardware / OS). The app version is NOT part of
// this — it is always the pinned latest build (see PINNED_IG_APP_VERSION).
export function randomDevice(): { iphoneModel: string; iosVersion: string } {
  const preset = IPHONE_PRESETS[Math.floor(Math.random() * IPHONE_PRESETS.length)]
  const versions = iosVersionsForModel(preset.model)
  const iosVersion = versions[Math.floor(Math.random() * versions.length)]
  return { iphoneModel: preset.model, iosVersion }
}

export interface UaParams {
  appVersion: string
  iphoneModel: string
  iosVersion: string
  deviceId: string
  locale?: string
}

// Example output:
// Instagram 410.1.0.36.70 (iPhone11,8; iOS 15_3_1; en_US; en; scale=2.00; 828x1792; 849447290) AppleWebKit/420+
export function buildUserAgent(params: UaParams): string {
  const preset = getPreset(params.iphoneModel)
  const locale = normalizeLocale(params.locale)
  const lang = locale.split("_")[0]
  // Version code is pinned to the build (same for every account), not derived
  // from the device — see PINNED_IG_VERSION_CODE.
  return `Instagram ${params.appVersion} (${preset.model}; iOS ${params.iosVersion}; ${locale}; ${lang}; scale=${preset.scale}; ${preset.resolution}; ${PINNED_IG_VERSION_CODE}) AppleWebKit/420+`
}

// Parse an Instagram iOS User-Agent back into its device fields so an imported
// UA can be used verbatim instead of a randomised device. Returns null when the
// string doesn't match the expected shape.
// Example input:
//   Instagram 437.0.0.22.50 (iPhone11,8; iOS 18_5; en_US; en; scale=2.00; 828x1792; 1010515070) AppleWebKit/420+
export interface ParsedUserAgent {
  appVersion: string
  iphoneModel: string
  iosVersion: string
  locale: string
}

export function parseUserAgent(ua?: string | null): ParsedUserAgent | null {
  const raw = (ua ?? "").trim()
  if (!raw) return null
  // "Instagram <appVersion> (<inside>) ..."
  const m = /^Instagram\s+(\S+)\s+\(([^)]*)\)/i.exec(raw)
  if (!m) return null
  const appVersion = m[1].trim()
  const parts = m[2].split(";").map((p) => p.trim())
  // Expected order: model; iOS <ver>; <locale>; <lang>; scale=..; WxH; versionCode
  const iphoneModel = parts[0] || ""
  const iosVersion = (parts[1] || "").replace(/^iOS\s*/i, "").trim()
  const locale = normalizeLocale(parts[2] || "")
  if (!/^iPhone\d+,\d+$/i.test(iphoneModel) || !/^\d+(_\d+)*$/.test(iosVersion)) return null
  return { appVersion, iphoneModel, iosVersion, locale }
}

// ── Region (locale + timezone) ────────────────────────────────────────────
// The real app reports a locale AND a timezone offset that match the SIM / IP
// region. Sending Moscow's offset with an en_US locale for every account is an
// automation tell and a geo-mismatch when the proxy is elsewhere. Each account
// now carries a `locale` (xx_YY) and an IANA `timezone`, and every locale/tz
// header + body field is derived from those so they always stay consistent.

export interface RegionPreset {
  id: string
  name: string
  locale: string // xx_YY, e.g. "en_US"
  timezone: string // IANA zone, e.g. "America/New_York"
}

// Newest-common IG markets. `timezone` is the IANA zone; the numeric offset we
// send is computed from it at request time so it follows DST automatically.
export const REGION_PRESETS: RegionPreset[] = [
  { id: "us", name: "United States (English)", locale: "en_US", timezone: "America/New_York" },
  { id: "gb", name: "United Kingdom (English)", locale: "en_GB", timezone: "Europe/London" },
  { id: "ru", name: "Russia (Russian)", locale: "ru_RU", timezone: "Europe/Moscow" },
  { id: "ua", name: "Ukraine (Ukrainian)", locale: "uk_UA", timezone: "Europe/Kyiv" },
  { id: "de", name: "Germany (German)", locale: "de_DE", timezone: "Europe/Berlin" },
  { id: "fr", name: "France (French)", locale: "fr_FR", timezone: "Europe/Paris" },
  { id: "es", name: "Spain (Spanish)", locale: "es_ES", timezone: "Europe/Madrid" },
  { id: "it", name: "Italy (Italian)", locale: "it_IT", timezone: "Europe/Rome" },
  { id: "pl", name: "Poland (Polish)", locale: "pl_PL", timezone: "Europe/Warsaw" },
  { id: "tr", name: "Türkiye (Turkish)", locale: "tr_TR", timezone: "Europe/Istanbul" },
  { id: "br", name: "Brazil (Portuguese)", locale: "pt_BR", timezone: "America/Sao_Paulo" },
  { id: "mx", name: "Mexico (Spanish)", locale: "es_MX", timezone: "America/Mexico_City" },
  { id: "in", name: "India (English)", locale: "en_IN", timezone: "Asia/Kolkata" },
  { id: "id", name: "Indonesia (Indonesian)", locale: "id_ID", timezone: "Asia/Jakarta" },
  { id: "ae", name: "UAE (English)", locale: "en_AE", timezone: "Asia/Dubai" },
  { id: "jp", name: "Japan (Japanese)", locale: "ja_JP", timezone: "Asia/Tokyo" },
]

export const DEFAULT_LOCALE = "en_US"
export const DEFAULT_TIMEZONE = "Europe/Moscow"

// Normalise any stored value ("en-US", "", "en_us") to the canonical xx_YY form.
export function normalizeLocale(locale?: string | null): string {
  const raw = (locale ?? "").trim().replace("-", "_")
  if (!raw) return DEFAULT_LOCALE
  const [lang, region] = raw.split("_")
  if (!lang) return DEFAULT_LOCALE
  return region ? `${lang.toLowerCase()}_${region.toUpperCase()}` : lang.toLowerCase()
}

// The consistent set of locale headers a genuine client sends, all derived from
// one locale value so they can never disagree with each other.
export function localeHeaders(locale?: string | null): {
  acceptLanguage: string
  appLocale: string
  deviceLocale: string
  mappedLocale: string
} {
  const norm = normalizeLocale(locale)
  const [lang, region] = norm.split("_")
  const dash = region ? `${lang}-${region}` : lang
  return {
    acceptLanguage: `${dash};q=1.0`,
    appLocale: lang,
    deviceLocale: dash,
    mappedLocale: region ? `${lang}_${region}` : norm,
  }
}

// Current UTC offset (in seconds, east-positive) for an IANA timezone. Uses the
// Intl database so DST is handled automatically — Moscow → 10800 year-round,
// New York → -18000 (winter) / -14400 (summer), etc. Falls back to 0.
export function tzOffsetSeconds(timeZone?: string | null, at: Date = new Date()): number {
  const zone = (timeZone ?? "").trim() || DEFAULT_TIMEZONE
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    const map: Record<string, number> = {}
    for (const p of dtf.formatToParts(at)) {
      if (p.type !== "literal") map[p.type] = Number(p.value)
    }
    const asUTC = Date.UTC(map.year, map.month - 1, map.day, map.hour % 24, map.minute, map.second)
    return Math.round((asUTC - at.getTime()) / 1000)
  } catch {
    return 0
  }
}
