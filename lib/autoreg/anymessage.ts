import axios, { type AxiosInstance, type AxiosError } from "axios"

// ── AnyMessage email verification client ─────────────────────────────────
// API: https://api.anymessage.shop
// Each registration attempt MUST create its own AnyMessageClient instance
// (shared instances cause race conditions on the order state).
// Aligned with reference Python anymessage_client.py for robustness.

const API_BASE = "https://api.anymessage.shop"

const DEFAULT_CONNECT_TIMEOUT = 10_000
const DEFAULT_READ_TIMEOUT = 30_000

export interface EmailOrder {
  email: string
  orderId: string | number
}

export class AnyMessageClient {
  private api: AxiosInstance
  private orderId: string | number = ""
  private email = ""
  private codeReceived = false

  constructor(private token: string, private site = "instagram.com") {
    this.api = axios.create({
      baseURL: API_BASE,
      timeout: DEFAULT_READ_TIMEOUT,
    })
  }

  /** Order a temporary email address. */
  async orderEmail(domain?: string): Promise<EmailOrder> {
    const resp = await this.apiGet("/email/order", {
      token: this.token,
      site: this.site,
      ...(domain ? { domain } : {}),
    })
    const data = resp?.data
    if (data?.status !== "success" && data?.status !== 1 && !data?.email) {
      throw new Error(`AnyMessage order failed: ${JSON.stringify(data)}`)
    }
    this.orderId = data.id || data.order_id || data.orderId || ""
    this.email = data.email || ""
    this.codeReceived = false
    return { email: this.email, orderId: this.orderId }
  }

  /**
   * Poll for the verification code. Returns the 6-digit code or null.
   * Network errors and transient API errors return null (keep polling)
   * instead of crashing the registration — matches reference behavior.
   */
  async checkCode(): Promise<string | null> {
    if (!this.orderId) throw new Error("No active email order")

    let data: Record<string, unknown>
    try {
      const resp = await this.apiGet("/email/getmessage", {
        token: this.token,
        id: this.orderId,
      })
      data = resp?.data ?? {}
    } catch {
      // Network timeout / connection error — treat as "not ready yet"
      return null
    }

    if (data.status === "success") {
      const body = (data.message || data.body || data.text || "") as string
      return this.extract6DigitCode(body)
    }

    // Classify the error value
    const value = String(data.value || "").trim()
    const low = value.toLowerCase()
    const isTransient =
      !value ||
      low === "wait message" ||
      low.includes("wait") ||
      low.includes("timeout") ||
      low.includes("time out") ||
      low.includes("failed to retrieve") ||
      low.includes("retrieve") ||
      low.includes("try again") ||
      low.includes("temporarily")

    if (value && !isTransient) {
      console.warn(`[AnyMessage] getmessage error: ${value}`)
    }

    return null
  }

  /** Extract 6-digit verification code from email body (HTML/text). */
  private extract6DigitCode(text: string): string | null {
    if (!text) return null
    // First pass: look for "code is/:" pattern (more specific)
    const specific = /(?:code\s*(?:is)?\s*[:\-]?\s*)(\d{6})/i.exec(text)
    if (specific) return specific[1]
    // Second pass: bare 6-digit number
    const bare = /\b(\d{6})\b/.exec(text)
    return bare ? bare[1] : null
  }

  /** Wait for code with timeout and jitter (matches reference). */
  async waitForCode(timeoutMs = 60_000, pollMs = 3_000, isCancelled?: () => boolean): Promise<string> {
    const deadline = Date.now() + timeoutMs

    // Initial jitter to spread polling across concurrent registrations
    const jitter = Math.random() * pollMs
    if (Date.now() + jitter < deadline) {
      await sleep(jitter)
    }

    while (Date.now() < deadline) {
      if (isCancelled?.()) throw new Error("Registration cancelled")
      const code = await this.checkCode()
      if (code) {
        this.codeReceived = true
        return code
      }
      if (isCancelled?.()) throw new Error("Registration cancelled")
      // Poll interval with ±30% jitter (prevents phase-locking)
      const jittered = pollMs * (0.7 + Math.random() * 0.6)
      await sleep(jittered)
    }
    throw new Error(`Timed out waiting for email code after ${timeoutMs}ms`)
  }

  /** Re-order email for current activation (if first delivery failed). */
  async reorderEmail(): Promise<void> {
    if (!this.orderId) return
    try {
      const resp = await this.apiGet("/email/reorder", {
        token: this.token,
        id: this.orderId,
      })
      const data = resp?.data
      if (data?.status === "success") {
        this.orderId = data.id || this.orderId
        this.email = data.email || this.email
      }
    } catch {
      // Best effort
    }
  }

  /** Cancel the current email order. */
  async cancelEmail(): Promise<void> {
    if (!this.orderId) return
    try {
      await this.apiGet("/email/cancel", {
        token: this.token,
        id: this.orderId,
      })
    } catch {
      // Best effort
    }
  }

  /** Get account balance. */
  async getBalance(): Promise<number> {
    const resp = await this.apiGet("/user/balance", {
      token: this.token,
    })
    return Number(resp?.data?.balance ?? 0)
  }

  getEmail(): string {
    return this.email
  }

  /** Whether the code was successfully received for the current activation. */
  wasCodeReceived(): boolean {
    return this.codeReceived
  }

  /** GET with retry on transient failures (matches reference's Retry adapter). */
  private async apiGet(path: string, params: Record<string, unknown>, retries = 3) {
    let lastErr: unknown
    for (let i = 0; i <= retries; i++) {
      try {
        return await this.api.get(path, { params, timeout: DEFAULT_READ_TIMEOUT })
      } catch (err) {
        lastErr = err
        const axErr = err as AxiosError
        const status = axErr.response?.status
        // Retry on network errors and 429/5xx
        const retryable = !status || status === 429 || status >= 500
        if (!retryable || i === retries) throw err
        // Exponential backoff: 1s, 2s, 4s
        await sleep(1000 * Math.pow(2, i))
      }
    }
    throw lastErr
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
