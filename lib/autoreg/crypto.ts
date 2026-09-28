import { publicEncrypt, randomBytes, createCipheriv, constants } from "node:crypto"

// ── Instagram password encryption ────────────────────────────────────────
// The real iOS app encrypts passwords using RSA-PKCS1v15 wrapping a random
// AES-256-GCM key, then encrypts the password with AES-GCM. The result is
// a blob formatted as #PWD_INSTAGRAM:4:{timestamp}:{base64}.
//
// Flow:
// 1. Fetch RSA public key from /api/v1/launcher/mobileconfig/
// 2. Generate random 32-byte AES key + 12-byte IV
// 3. RSA-PKCS1v15 encrypt the AES key with the server's public key
// 4. AES-256-GCM encrypt the password with timestamp as AAD
// 5. Assemble blob: \x01 + keyId(1) + IV(12) + rsaLen(LE,2) + rsaEnc + tag(16) + ciphertext
// 6. Base64 encode → #PWD_INSTAGRAM:4:{ts}:{b64}

export interface PasswordKey {
  keyId: number
  publicKey: string  // PEM-formatted RSA public key
}

export function encryptPassword(password: string, key: PasswordKey, timestamp?: number): string {
  const ts = timestamp ?? Math.floor(Date.now() / 1000)
  const tsStr = String(ts)

  // Generate random AES-256 key and IV
  const aesKey = randomBytes(32)
  const iv = randomBytes(12)

  // RSA-PKCS1v15 encrypt the AES key
  const rsaEncrypted = publicEncrypt(
    {
      key: key.publicKey,
      padding: constants.RSA_PKCS1_PADDING,
    },
    aesKey,
  )

  // AES-256-GCM encrypt the password with timestamp as AAD
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv)
  cipher.setAAD(Buffer.from(tsStr, "utf8"))
  const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag() // 16 bytes

  // Assemble the blob
  const rsaLen = Buffer.alloc(2)
  rsaLen.writeUInt16LE(rsaEncrypted.length)

  const blob = Buffer.concat([
    Buffer.from([1]),       // version byte
    Buffer.from([key.keyId]), // key ID (1 byte)
    iv,                     // 12 bytes
    rsaLen,                 // 2 bytes (little-endian)
    rsaEncrypted,           // RSA encrypted AES key
    tag,                    // 16 bytes (GCM auth tag)
    encrypted,              // AES-GCM ciphertext
  ])

  return `#PWD_INSTAGRAM:4:${ts}:${blob.toString("base64")}`
}

// Parse the RSA public key from Instagram's mobileconfig response.
// The key comes as a hex-encoded DER blob; we convert to PEM.
export function parsePasswordKeyFromConfig(
  data: Record<string, unknown>,
): PasswordKey | null {
  try {
    // Instagram returns the key in: data.data.public_key and data.data.key_id
    // Or under password_encryption.public_key / password_encryption.key_id
    const pe = (data as any)?.password_encryption ?? data
    const hexKey = pe?.public_key as string
    const keyId = Number(pe?.key_id ?? 0)
    if (!hexKey) return null

    const derBuf = Buffer.from(hexKey, "hex")
    const b64 = derBuf.toString("base64")
    const pem = `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----`

    return { keyId, publicKey: pem }
  } catch {
    return null
  }
}
