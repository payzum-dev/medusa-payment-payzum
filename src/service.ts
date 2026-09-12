/**
 * Payzum payment provider for Medusa v2.
 *
 * Redirect/hosted-checkout crypto gateway. initiatePayment() creates a Payzum invoice and returns
 * its `invoiceUrl` in the session data (the storefront redirects the buyer to it); the payment is
 * settled from the signed webhook (getWebhookActionAndData), verified with HMAC-SHA-512.
 *
 * Targets Medusa v2's AbstractPaymentProvider. Framework types resolve at build time in a Medusa
 * project; the Payzum client (./lib/payzum-client) is framework-agnostic and strictly typed.
 */

import { AbstractPaymentProvider, PaymentSessionStatus } from "@medusajs/framework/utils"
import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"
import { PAYZUM_STATUS_PAID, PayzumClient, type PayzumStatus } from "./lib/payzum-client.js"

export type PayzumOptions = Readonly<{
  apiKey: string
  payCurrency: string
  webhookSecret: string
  ipnCallbackUrl: string
  /** "production" (merchant.payzum.com, default) or "staging" (staging.payzum.com — separate API keys). */
  environment?: "production" | "staging"
}>

/**
 * Map a Payzum status to Medusa's payment session status.
 *
 * The merchant surface emits exactly five statuses — the nine-status list earlier versions
 * handled here included four values that are unreachable on this surface.
 */
function toSessionStatus(status: PayzumStatus): PaymentSessionStatus {
  switch (status) {
    case "finished":
      return PaymentSessionStatus.CAPTURED
    case "partially_paid":
    case "waiting":
      return PaymentSessionStatus.PENDING
    case "expired":
      return PaymentSessionStatus.CANCELED
    case "failed":
      return PaymentSessionStatus.ERROR
    default:
      return PaymentSessionStatus.PENDING
  }
}

class PayzumProviderService extends AbstractPaymentProvider<PayzumOptions> {
  static identifier = "payzum"

  private readonly client: PayzumClient
  private readonly options: PayzumOptions

  constructor(container: Record<string, unknown>, options: PayzumOptions) {
    super(container, options)
    this.options = options
    this.client = new PayzumClient(options.apiKey, options.environment ?? "production")
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    /*
     * order_id must be the Medusa payment session id and nothing else: it is the only thing the
     * IPN carries back, and getWebhookActionAndData hands it to Medusa as `session_id`. The old
     * `?? crypto.randomUUID()` fallback minted an id that resolves to no session anywhere, so the
     * invoice was created, the buyer paid it, and every webhook for it was quietly discarded.
     * Failing here instead surfaces the misconfiguration before any money moves.
     */
    const orderId = String(input.data?.["session_id"] ?? input.data?.["id"] ?? "")
    if (orderId === "") {
      throw new Error(
        "Payzum initiatePayment: no session id in the payment session data — cannot create an " +
          "invoice whose IPN could be matched back to a Medusa session."
      )
    }
    const result = await this.client.createPayment({
      price_amount: Number(input.amount),
      price_currency: String(input.currency_code).toLowerCase(),
      pay_currency: this.options.payCurrency,
      order_id: orderId,
      ipn_callback_url: this.options.ipnCallbackUrl,
      // The session id is unique per payment attempt; the key makes a transport retry safe
      // without ever pinning a different session to a stale invoice.
      idempotency_key: `medusa-${orderId}`,
    })

    if (!result.ok) {
      throw new Error(`Payzum initiatePayment failed: ${result.error.kind}`)
    }

    return {
      id: result.value.paymentId !== "" ? result.value.paymentId : orderId,
      data: {
        orderId,
        paymentId: result.value.paymentId,
        invoiceUrl: result.value.invoiceUrl,
        status: result.value.status,
      },
    }
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const status = await this.resolveStatus(input.data)
    return { status: toSessionStatus(status), data: { ...input.data, status } }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const status = await this.resolveStatus(input.data)
    return { status: toSessionStatus(status), data: input.data ?? {} }
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    return { data: input.data ?? {} }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async refundPayment(_input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    throw new Error("Payzum is non-custodial; refunds are handled outside Medusa.")
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async getWebhookActionAndData(payload: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
    const raw = typeof payload.rawData === "string" ? payload.rawData : payload.rawData.toString("utf8")
    const headers = payload.headers as Record<string, string | undefined>

    // The SDK Verifier reads the fixed x-nowpayments-sig header itself (there is deliberately no
    // signatureHeader option any more — a setting is how earlier releases broke), verifies
    // HMAC-SHA-512 over the RAW bytes in constant time, and enforces the 10-minute replay window
    // on the signed event_at.
    const verified = PayzumClient.verifyIpn(raw, headers, this.options.webhookSecret)
    if (!verified.ok) {
      return { action: "not_supported" }
    }

    const body = verified.value.payload
    const status = String(body["payment_status"] ?? "")
    const sessionId = String(body["order_id"] ?? "")
    const amount = Number(body["price_amount"] ?? 0)

    // What the buyer actually paid with. The invoice goes out with pay_currency "all", so the coin
    // is unknown at creation — the buyer picks it on the hosted checkout and it only comes back
    // here. Carrying it through means the merchant can see the coin alongside the payment, which
    // every PHP integration already records; without it a settled Medusa order says it was paid
    // but not in what. Amounts stay strings: the SDK decodes them losslessly and Number() would
    // put a binary tail back in.
    const paid: Record<string, string> = {}
    for (const field of ["pay_currency", "network", "payment_id"] as const) {
      const value = body[field]
      if (typeof value === "string" && value !== "") {
        paid[field] = value
      }
    }
    const received = body["amount_received"] ?? body["actually_paid"]
    if (received !== undefined && received !== null) {
      paid["amount_received"] = String(received)
    }

    if (status === "finished") {
      return { action: "captured", data: { session_id: sessionId, amount, ...paid } }
    }
    // No "cancelled" here: the API has no such status — a cancelled invoice surfaces as `failed`.
    if (status === "failed" || status === "expired") {
      /*
       * A captured payment is never reported as failed.
       *
       * Payzum fires on more than one transition and retries a delivery about six times, so a late
       * `expired` or `failed` for an invoice that was ultimately paid is ordinary traffic — and it
       * is properly signed, so it sails through verification. The Saleor app documents the same
       * scenario measured end to end: a signed late `expired` took chargedAmount from 3.0 back to
       * 0.0. Reporting `failed` here after a `captured` degrades a payment the buyer already made.
       *
       * So ask the API what the invoice actually is before degrading anything, rather than
       * trusting the ordering of deliveries. When the lookup itself fails the event is dropped
       * instead of applied: guessing in the failing direction is the destructive one, and a
       * genuinely expired invoice simply leaves the session where it already was.
       */
      const lookupId = paid["payment_id"] ?? sessionId
      const live = lookupId !== "" ? await this.client.getPayment(lookupId) : undefined
      if (live === undefined || !live.ok || live.value.status === PAYZUM_STATUS_PAID) {
        return { action: "not_supported" }
      }
      return { action: "failed", data: { session_id: sessionId, amount, ...paid } }
    }
    return { action: "pending", data: { session_id: sessionId, amount, ...paid } }
  }

  private async resolveStatus(data: Record<string, unknown> | undefined): Promise<PayzumStatus> {
    const orderId = String(data?.["orderId"] ?? data?.["paymentId"] ?? "")
    if (orderId === "") {
      return "waiting"
    }
    const result = await this.client.getPayment(orderId)
    return result.ok ? result.value.status : "waiting"
  }
}

export default PayzumProviderService
