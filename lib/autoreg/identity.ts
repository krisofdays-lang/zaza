import { randomUUID, randomBytes } from "node:crypto"

// ── Name generation ──────────────────────────────────────────────────────
const FIRST_NAMES = [
  "Emma", "Olivia", "Ava", "Isabella", "Sophia", "Mia", "Charlotte", "Amelia",
  "Harper", "Evelyn", "Abigail", "Emily", "Elizabeth", "Sofia", "Ella", "Avery",
  "Scarlett", "Grace", "Chloe", "Victoria", "Riley", "Aria", "Lily", "Aurora",
  "Zoey", "Nora", "Camila", "Hannah", "Lillian", "Addison", "Eleanor", "Natalie",
  "Luna", "Savannah", "Brooklyn", "Leah", "Zoe", "Stella", "Hazel", "Ellie",
  "Paisley", "Audrey", "Skylar", "Violet", "Claire", "Bella", "Lucy", "Anna",
  "Caroline", "Genesis", "Aaliyah", "Kennedy", "Madelyn", "Allison", "Maya",
  "Sarah", "Madeline", "Adeline", "Alexa", "Ariana", "Elena", "Gabriella",
  "Naomi", "Alice", "Sadie", "Hailey", "Eva", "Emilia", "Autumn", "Quinn",
  "Nevaeh", "Piper", "Ruby", "Serenity", "Willow", "Everly", "Cora",
  "Kaylee", "Lydia", "Aubrey", "Arianna", "Eliana", "Peyton", "Melanie",
  "Gianna", "Isabelle", "Julia", "Valentina", "Nova", "Clara", "Vivian",
  "Reagan", "Mackenzie", "Madelyn", "Brielle", "Delilah", "Isla", "Rylee",
  "Katherine", "Sophie", "Josephine", "Ivy", "Liliana", "Jade", "Maria",
]

const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
  "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
  "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson",
  "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson",
  "Walker", "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen",
  "Hill", "Flores", "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera",
  "Campbell", "Mitchell", "Carter", "Roberts", "Turner", "Phillips", "Evans",
  "Collins", "Edwards", "Stewart", "Morris", "Murphy", "Cook", "Rogers",
  "Morgan", "Peterson", "Cooper", "Reed", "Bailey", "Bell", "Gomez", "Kelly",
  "Howard", "Ward", "Cox", "Diaz", "Richardson", "Wood", "Watson", "Brooks",
  "Bennett", "Gray", "James", "Reyes", "Cruz", "Hughes", "Price", "Myers",
  "Long", "Foster", "Sanders", "Ross", "Morales", "Powell", "Sullivan", "Russell",
  "Ortiz", "Jenkins", "Gutierrez", "Perry", "Butler", "Barnes", "Fisher",
]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

export function randomName(): { firstName: string; lastName: string } {
  return { firstName: pick(FIRST_NAMES), lastName: pick(LAST_NAMES) }
}

// ── Birthday generation ──────────────────────────────────────────────────
// Returns DD-MM-YYYY (the format Instagram's birthday step expects).
export function randomBirthday(minAge = 18, maxAge = 45): string {
  const now = new Date()
  const age = minAge + Math.floor(Math.random() * (maxAge - minAge + 1))
  const year = now.getFullYear() - age
  const month = 1 + Math.floor(Math.random() * 12)
  const maxDay = new Date(year, month, 0).getDate()
  const day = 1 + Math.floor(Math.random() * maxDay)
  const dd = String(day).padStart(2, "0")
  const mm = String(month).padStart(2, "0")
  return `${dd}-${mm}-${year}`
}

// ── Username generation ──────────────────────────────────────────────────
// Generates a plausible-looking username from first/last name + random suffix.
export function generateUsername(firstName: string, lastName: string): string {
  const strategies = [
    // first.last23
    () => `${firstName.toLowerCase()}.${lastName.toLowerCase()}${twoDigits()}`,
    // first_last
    () => `${firstName.toLowerCase()}_${lastName.toLowerCase()}${twoDigits()}`,
    // firstlast2024
    () => `${firstName.toLowerCase()}${lastName.toLowerCase()}${fourDigits()}`,
    // first.l23
    () => `${firstName.toLowerCase()}.${lastName[0].toLowerCase()}${twoDigits()}`,
    // f.lastname
    () => `${firstName[0].toLowerCase()}.${lastName.toLowerCase()}${twoDigits()}`,
    // first_xx
    () => `${firstName.toLowerCase()}_${randomHex(3)}`,
    // firstlast.xx
    () => `${firstName.toLowerCase()}${lastName.toLowerCase().slice(0, 3)}.${randomHex(2)}`,
  ]
  return pick(strategies)()
}

function twoDigits(): string {
  return String(Math.floor(Math.random() * 100)).padStart(2, "0")
}

function fourDigits(): string {
  return String(2000 + Math.floor(Math.random() * 26))
}

function randomHex(len: number): string {
  return randomBytes(len).toString("hex").slice(0, len)
}

// ── Password generation ──────────────────────────────────────────────────
// Generates a reasonably strong password: 12-16 chars with mixed case + digits.
export function generatePassword(): string {
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%"
  const len = 12 + Math.floor(Math.random() * 5)
  const bytes = randomBytes(len)
  let result = ""
  for (let i = 0; i < len; i++) {
    result += charset[bytes[i] % charset.length]
  }
  return result
}

// ── Device ID generators ─────────────────────────────────────────────────
// These match the Python reference exactly so the IDs look identical to real
// devices. All are uppercase UUIDs unless otherwise noted.

/** Uppercase UUID — used for guid (device_id), phone_id, family_device_id, pigeon_session */
export function genDeviceId(): string {
  return randomUUID().toUpperCase()
}

/** Hex UUID (no dashes, lowercase) — used for waterfall_id */
export function genWaterfallId(): string {
  return randomUUID().replace(/-/g, "")
}

/** Two uppercase UUIDs joined with ":" — cloud_trust_token */
export function genCloudTrustToken(): string {
  return `${randomUUID().toUpperCase()}:${randomUUID().toUpperCase()}`
}

/** UUID — aac_jid */
export function genAacJid(): string {
  return randomUUID()
}

/** "TBE_" + 24 base64url chars — machine_id */
export function genMachineId(): string {
  return "TBE_" + randomBytes(18).toString("base64url").slice(0, 24)
}

/** 43 base64url chars — aac_cs */
export function genAacCs(): string {
  return randomBytes(33).toString("base64url").slice(0, 43)
}

/** XID (hex) for fb_anon_id: "XID-" + 36 hex chars */
export function genFbAnonId(): string {
  return "XID-" + randomBytes(18).toString("hex")
}
