import axios, { type AxiosInstance } from "axios"

// ── AnyMessage email verification client ─────────────────────────────────
// API: https://api.anymessage.shop
// Each registration attempt MUST create its own AnyMessageClient instance
// (shared instances cause race conditions on the order state).

const API_BASE = "https://api.anymessage.shop"

export interface EmailOrder {
  email: string
  orderId: string | number
}

export class AnyMessageClient {
  private api: AxiosInstance
  private orderId: string | number = ""
  private email = ""

  constructor(private apiKey: string) {
    this.api = axios.create({
      baseURL: API_BASE,
      timeout: 15_000,
      params: { apikey: this.apiKey },
    })
  }

  /** Order a temporary email address. */
  async orderEmail(domain?: string): Promise<EmailOrder> {
    const resp = await this.api.get("/email/order", {
      params: { apikey: this.apiKey, ...(domain ? { domain } : {}) },
    })
    const data = resp.data
    if (data?.status !== "success" && data?.status !== 1 && !data?.email) {
      throw new Error(`AnyMessage order failed: ${JSON.stringify(data)}`)
    }
    this.orderId = data.id || data.order_id || data.orderId || ""
    this.email = data.email || ""
    return { email: this.email, orderId: this.orderId }
  }

  /** Poll for the verification code. Returns the 6-digit code or null. */
  async checkCode(): Promise<string | null> {
    if (!this.orderId) throw new Error("No active email order")
    const resp = await this.api.get("/email/getmessage", {
      params: { apikey: this.apiKey, id: this.orderId },
    })
    const data = resp.data
    // Response status can be "wait" / "pending" / "success"
    if (data?.status === "wait" || data?.status === "pending" || !data?.message) {
      return null
    }
    // Extract 6-digit code from HTML body
    const body = data.message || data.body || data.text || ""
    const match = /(\d{6})/.exec(body)
    return match ? match[1] : null
  }

  /** Wait for code with timeout. */
  async waitForCode(timeoutMs = 60_000, pollMs = 3_000): Promise<string> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const code = await this.checkCode()
      if (code) return code
      await sleep(pollMs)
    }
    throw new Error(`Timed out waiting for email code after ${timeoutMs}ms`)
  }

  /** Cancel the current email order. */
  async cancelEmail(): Promise<void> {
    if (!this.orderId) return
    try {
      await this.api.get("/email/cancel", {
        params: { apikey: this.apiKey, id: this.orderId },
      })
    } catch {
      // Best effort
    }
  }

  /** Get account balance. */
  async getBalance(): Promise<number> {
    const resp = await this.api.get("/user/balance")
    return Number(resp.data?.balance ?? 0)
  }

  getEmail(): string {
    return this.email
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
