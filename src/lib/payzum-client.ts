/**
 * Thin adapter over the official `payzum` npm SDK.
 *
 * The SDK owns the dangerous parts — HTTP transport with retries, HMAC verification against the
 * fixed `x-nowpayments-sig` header (read case-insensitively) with a 10-minute replay window on
 * the signed `event_at`, decimal-exact amounts, and the status vocabulary (exactly five values;
 * the nine-status list earlier copies of this file carried was wrong — four of them are
 * unreachable on the merchant surface).
 *
 * This adapter keeps the exported surface the hand-copied client had, so integrations only touch
 * their IPN handler (header reading moved into the SDK Verifier). It is still copied into each
 * TypeScript integration, but it is now types and glue — the logic lives in the npm package:
 *
 *   for d in shopify/payzum-app wix/payzum-app bigcommerce/payzum-app saleor/payzum-app \
 *            medusa/payzum-payment vendure/payzum-plugin; do
 *     md5sum "$d/src/lib/payzum-client.ts"
 *   done
 */

import {
  ApiError,
  PAYMENT_STATUSES,
  Payzum,
  PayzumError as PayzumSdkError,
  SignatureError,
  TransportError,
  Verifier,
  type PaymentStatus,
  type WebhookHeaders,
} from "payzum"

/** The five statuses the merchant surface actually emits. */
export const PAYZUM_STATUSES = PAYMENT_STATUSES

export type PayzumStatus = PaymentStatus

/** The only status that means the order is paid in full. Overpayment also lands here. */
export const PAYZUM_STATUS_PAID: PayzumStatus = "finished"

/**
 * Sentinel that defers the coin choice to the buyer on the Payzum hosted checkout.
 *
 * The 201 comes back as a draft — pay_address, pay_amount, pay_currency and network are all null,
 * while payment_id is already final — and the checkout offers only the merchant's allowlist,
 * enforced server-side. Which coins a merchant accepts belongs in the Payzum dashboard, under
 * Merchants -> Settings -> Accepted tokens; no endpoint exposes that allowlist, so an integration
 * cannot usefully mirror it.
 */
export const PAY_CURRENCY_ANY = "all"

export type CreatePaymentInput = Readonly<{
  /** Strings pass through untouched; numbers are stringified (the SDK sends exact JSON numbers). */
  price_amount: number | string
  price_currency: string
  pay_currency: string
  order_id: string
  ipn_callback_url: string
  /** Shown on the hosted checkout so the buyer knows what they are paying for. Capped at 2000. */
  order_description?: string
  /** Where the buyer lands after paying. Capped at 2048, http(s). */
  success_url?: string
  /** Where the buyer lands if they abandon the checkout. Capped at 2048, http(s). */
  cancel_url?: string
  /** Makes a transport retry safe; without one the SDK never auto-retries a create. */
  idempotency_key?: string
}>

export type PayzumInvoice = Readonly<{
  paymentId: string
  invoiceUrl: string
  status: PayzumStatus
}>

export type PayzumError =
  | { kind: "no_api_key" }
  | { kind: "network"; message: string }
  | { kind: "http_error"; status: number; code?: string }
  | { kind: "invalid_request"; message: string }
  | { kind: "bad_response" }

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

export const isStatus = (v: unknown): v is PayzumStatus =>
  typeof v === "string" && (PAYZUM_STATUSES as readonly string[]).includes(v)

export type VerifiedIpn = Readonly<{
  /** The decoded IPN payload (decimal amounts arrive as strings — lossless decode). */
  payload: Readonly<Record<string, unknown>>
  /** Delivery id for deduplication — retries reuse it. Null when the header is absent. */
  eventId: string | null
}>

export type IpnError = Readonly<{ kind: "bad_signature"; reason: string }>

function mapError(e: unknown): PayzumError {
  if (e instanceof ApiError) {
    return { kind: "http_error", status: e.statusCode, code: e.rawCode }
  }
  if (e instanceof TransportError) {
    return { kind: "network", message: e.message }
  }
  if (e instanceof PayzumSdkError) {
    return { kind: "invalid_request", message: e.message }
  }
  return { kind: "network", message: e instanceof Error ? e.message : "unknown" }
}

/** Read the payment id as `payment_id` (alias `id` in older docs). */
function normalizeInvoice(raw: Record<string, unknown>): PayzumInvoice | null {
  const paymentId =
    typeof raw["payment_id"] === "string"
      ? raw["payment_id"]
      : typeof raw["id"] === "string"
        ? raw["id"]
        : ""
  const invoiceUrl = typeof raw["invoice_url"] === "string" ? raw["invoice_url"] : ""
  const status = isStatus(raw["payment_status"]) ? raw["payment_status"] : "waiting"
  if (invoiceUrl === "" && paymentId === "") {
    return null
  }
  return { paymentId, invoiceUrl, status }
}

export class PayzumClient {
  private readonly apiKey: string
  private readonly environment: "production" | "staging"
  private sdkInstance: Payzum | null = null

  constructor(apiKey: string, environment: "production" | "staging" = "production") {
    this.apiKey = apiKey
    this.environment = environment
  }

  /**
   * Built lazily, inside the callers' try blocks: the SDK constructor
   * validates the API key and THROWS on a malformed one. Building it in our
   * constructor turned a merchant typo in the dashboard into an unhandled
   * exception in the payment flow instead of a declined payment.
   */
  private sdk(): Payzum {
    if (this.sdkInstance === null) {
      // Staging (staging.payzum.com) is an isolated environment with its own API keys.
      this.sdkInstance = this.environment === "staging" ? Payzum.sandbox(this.apiKey) : new Payzum(this.apiKey)
    }
    return this.sdkInstance
  }

  async createPayment(input: CreatePaymentInput): Promise<Result<PayzumInvoice, PayzumError>> {
    if (this.apiKey === "") {
      return { ok: false, error: { kind: "no_api_key" } }
    }
    try {
      const raw = await this.sdk().payments.create({
        priceAmount: typeof input.price_amount === "string" ? input.price_amount : String(input.price_amount),
        priceCurrency: input.price_currency,
        payCurrency: input.pay_currency,
        orderId: input.order_id,
        ipnCallbackUrl: input.ipn_callback_url,
        ...(input.order_description !== undefined ? { orderDescription: input.order_description } : {}),
        ...(input.success_url !== undefined ? { successUrl: input.success_url } : {}),
        ...(input.cancel_url !== undefined ? { cancelUrl: input.cancel_url } : {}),
        ...(input.idempotency_key !== undefined ? { idempotencyKey: input.idempotency_key } : {}),
      })
      const invoice = normalizeInvoice(raw as Record<string, unknown>)
      return invoice ? { ok: true, value: invoice } : { ok: false, error: { kind: "bad_response" } }
    } catch (e) {
      return { ok: false, error: mapError(e) }
    }
  }

  async getPayment(idOrOrderId: string): Promise<Result<PayzumInvoice, PayzumError>> {
    if (this.apiKey === "") {
      return { ok: false, error: { kind: "no_api_key" } }
    }
    try {
      const raw = await this.sdk().payments.get(idOrOrderId)
      const invoice = normalizeInvoice(raw as Record<string, unknown>)
      return invoice ? { ok: true, value: invoice } : { ok: false, error: { kind: "bad_response" } }
    } catch (e) {
      return { ok: false, error: mapError(e) }
    }
  }

  /**
   * Verify a payment IPN via the SDK Verifier.
   *
   * Takes the RAW request bytes and the full header map — the Verifier reads the fixed
   * `x-nowpayments-sig` header itself, so there is nothing to configure and nothing to get
   * wrong (a configurable header is exactly how earlier integrations broke). It also enforces
   * the 10-minute replay window on the signed `event_at`.
   */
  static verifyIpn(
    rawBody: string | Uint8Array,
    headers: WebhookHeaders,
    secret: string
  ): Result<VerifiedIpn, IpnError> {
    try {
      const verifier = new Verifier(secret)
      const payload = verifier.verifyPaymentIpn(rawBody, headers)
      return { ok: true, value: { payload, eventId: verifier.eventId(headers) } }
    } catch (e) {
      const reason =
        e instanceof SignatureError ? e.reason : e instanceof Error ? e.message : "unknown"
      return { ok: false, error: { kind: "bad_signature", reason } }
    }
  }
}
