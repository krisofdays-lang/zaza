import axios, { type AxiosInstance } from "axios"

// ── TextVerified SMS verification client ─────────────────────────────────
// Uses the TextVerified REST API directly (the Python SDK is not available
// in Node). API docs: https://docs.textverified.com

const API_BASE = "https://www.textverified.com/api"

export interface PhoneOrder {
  phone: string       // E.164 phone number
  verificationId: string
}

export class TextVerifiedClient {
  private api: AxiosInstance
  private verificationId = ""
  private phone = ""

  constructor(private bearerToken: string) {
    this.api = axios.create({
      baseURL: API_BASE,
      timeout: 15_000,
      headers: {
        "Authorization": `Bearer ${this.bearerToken}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
    })
  }

  /** Order a phone number for Instagram SMS verification. */
  async orderPhone(): Promise<PhoneOrder> {
    const resp = await this.api.post("/Verifications", {
      service_name: "instagram",
      capability: "sms",
    })
    const data = resp.data
    if (!data?.number && !data?.phone) {
      throw new Error(`TextVerified order failed: ${JSON.stringify(data)}`)
    }
    this.verificationId = String(data.id || data.verification_id || "")
    this.phone = data.number || data.phone || ""
    // Ensure E.164 format
    if (this.phone && !this.phone.startsWith("+")) {
      this.phone = `+1${this.phone.replace(/\D/g, "")}`
    }
    return { phone: this.phone, verificationId: this.verificationId }
  }

  /** Poll for the SMS verification code. Returns the code or null. */
  async checkCode(): Promise<string | null> {
    if (!this.verificationId) throw new Error("No active phone verification")
    const resp = await this.api.get(`/Verifications/${this.verificationId}`)
    const data = resp.data
    // Check for SMS messages
    const code = data?.code || data?.sms_code
    if (code) {
      // Instagram sometimes splits codes with a space: "692 014" → "692014"
      return String(code).replace(/\s+/g, "")
    }
    // Check in sms array
    if (data?.sms && Array.isArray(data.sms) && data.sms.length > 0) {
      const lastSms = data.sms[data.sms.length - 1]
      const body = lastSms.text || lastSms.message || lastSms.body || ""
      const match = /(\d[\d\s]{4,7}\d)/.exec(body)
      if (match) return match[1].replace(/\s+/g, "")
    }
    return null
  }

  /** Wait for code with timeout. */
  async waitForCode(timeoutMs = 60_000, pollMs = 3_000): Promise<string> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const code = await this.checkCode()
      if (code) return code
      await sleep(pollMs)
    }
    throw new Error(`Timed out waiting for SMS code after ${timeoutMs}ms`)
  }

  /** Cancel / release the phone number. */
  async cancelPhone(): Promise<void> {
    if (!this.verificationId) return
    try {
      await this.api.patch(`/Verifications/${this.verificationId}`, {
        status: "cancelled",
      })
    } catch {
      // Best effort
    }
  }

  /** Get account balance. */
  async getBalance(): Promise<number> {
    const resp = await this.api.get("/Users/Balance")
    return Number(resp.data?.balance ?? 0)
  }

  getPhone(): string {
    return this.phone
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
