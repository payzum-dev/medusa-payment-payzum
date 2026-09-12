# Payzum for Medusa — Accept Crypto & Stablecoin Payments (USDC, USDT)

Accept **cryptocurrency and stablecoin payments** (USDC, USDT and more, multi-chain) in
[Medusa](https://medusajs.com) through [Payzum](https://payzum.com) —
**non-custodial**: funds settle directly to your own wallet, Payzum never takes
custody. No chargebacks, no card networks, no PCI surface.

- **Package:** `@payzum/medusa-payment-payzum` · **Version:** 1.2.0 · **License:** MIT
- **Type:** Medusa **v2** payment provider (`AbstractPaymentProvider`, strict TypeScript)
- **Requires:** Medusa v2, Node.js ≥ 20.19 (or ≥ 22.12 — the official [`payzum`](https://www.npmjs.com/package/payzum) SDK is ESM-only), a [Payzum merchant account](https://merchant.payzum.com)

## How it works

1. `initiatePayment()` creates a Payzum invoice and returns `invoiceUrl` in the
   session `data`; the storefront redirects the buyer to the **hosted Payzum
   checkout** (QR code + deposit address), where they choose the coin and chain
   and send the payment. No wallet or card data touches your server.
2. Crypto confirmation is **asynchronous**, so the payment is captured from
   Payzum's signed server-to-server IPN webhook, never from the buyer's browser
   return — a closed tab never loses a paid order.
3. Every webhook is verified with **HMAC-SHA-512 over the raw request bytes**
   (constant-time compare, 10-minute replay window) before a single field of it
   is read — and `authorizePayment` **re-queries Payzum** rather than trusting
   the webhook body, so a correctly-signed but simulated IPN cannot settle an
   unpaid invoice. Redelivered webhooks are a no-op, so an order is never
   fulfilled twice, and a late `expired` delivery can never un-capture a paid
   session.

## Features

- **Stablecoin-first**: USDC and USDT across multiple chains (Polygon, Ethereum,
  Arbitrum, Base, Optimism, Tron, Solana and more), plus major cryptocurrencies.
- **Non-custodial** — payments settle to the merchant's own wallet.
- **Hosted checkout** — no card fields, no crypto handling, no PCI scope.
- **Settlement verified against the API** — the provider confirms the invoice
  state with Payzum before authorizing, not just the webhook signature.
- **Idempotent invoice creation** — every create sends an `Idempotency-Key`, so
  a retry can never mint a twin invoice.
- **Production / staging environment option** (staging needs its own API key).
- **Zero chargebacks** — crypto payments are final.

## Installation

```bash
npm install @payzum/medusa-payment-payzum
```

Register under the Payment module in `medusa-config.ts` (in a
`create-medusa-app` monorepo this lives in `apps/backend/`):

```ts
{
  resolve: "@medusajs/medusa/payment",
  options: {
    providers: [
      {
        resolve: "@payzum/medusa-payment-payzum",
        id: "payzum",
        options: {
          apiKey: process.env.PAYZUM_API_KEY,
          payCurrency: "all",
          webhookSecret: process.env.PAYZUM_WEBHOOK_SECRET,
          ipnCallbackUrl: "https://your-store/hooks/payment/payzum_payzum"
        }
      }
    ]
  }
}
```

Point the Payzum dashboard webhook at your Medusa payment-webhook URL for this
provider.

## Configuration

| Option | Meaning |
|---|---|
| `apiKey` | From your [Payzum merchant dashboard](https://merchant.payzum.com) |
| `webhookSecret` | Verifies incoming payment webhooks (IPN) |
| `payCurrency` | Use `"all"` — the buyer picks the coin on the hosted checkout, limited to your merchant allowlist and enforced server-side |
| `ipnCallbackUrl` | Your store's payment-webhook URL for this provider |
| `environment` | `production` (default) or `staging` — staging needs its own API key |

**Why `payCurrency: "all"`:** nothing in the API lets a provider validate a
single ticker up front — a ticker can appear in `GET /v1/currencies` with a
published minimum and still be rejected at create time with
`CURRENCY_NOT_SUPPORTED`. `"all"` defers the choice to the buyer, limited to the
tokens your merchant account accepts.

## Payment status mapping

| Payzum payment status | Medusa session |
|---|---|
| `finished` | `captured` |
| `failed`, `expired` | `failed` — but never for a session that already captured (a late `expired` cannot un-pay an order) |
| `partially_paid`, anything else | `pending` — a later `finished` still captures |

Amounts pass through unchanged: Medusa v2 stores prices in major units, which
is exactly what the Payzum API expects.

## FAQ

**Can a Medusa store accept USDT or USDC?**
Yes — with this provider, buyers pay in USDC, USDT or other supported assets on
the chain they prefer, and the payment session is captured automatically.

**Is Payzum custodial?**
No. Funds settle directly to your own wallet — Payzum never holds your money.

**Do buyers need an account or a specific wallet?**
No. They scan a QR or copy a deposit address from the hosted checkout and pay
from any wallet.

**What about chargebacks?**
There are none — crypto payments are final, which eliminates chargeback fraud.

**Which Medusa versions are supported?**
Medusa v2 (`AbstractPaymentProvider`). The provider is verified against 2.x as
installed by `create-medusa-app`; Medusa's provider types evolve across minors.

**What data is shared with Payzum?**
Only the cart total, currency, a session reference and your store's callback
URL — no customer personal data. Endpoints: `https://merchant.payzum.com`
(production), `https://staging.payzum.com` (staging).

## Related Payzum integrations

Payzum ships official plugins for most major e-commerce, donation and billing
platforms — WooCommerce, Magento 2, PrestaShop, Shopware 6, OpenCart, Zen Cart,
nopCommerce, Ecwid, BigCommerce, Shopify, Wix, Vendure, Saleor, Sylius, Easy
Digital Downloads, GiveWP, Paid Memberships Pro, WHMCS, Blesta, HostBill,
ClientExec, pretix, Frappe/ERPNext, Akaunting and django-payments — plus
official SDKs for PHP, Node.js/TypeScript, Python and Rust. Browse them all at
[github.com/payzum-dev](https://github.com/payzum-dev).

## About Payzum

[Payzum](https://payzum.com) is a non-custodial crypto payment gateway for
merchants: accept USDC, USDT and other digital assets with settlement straight
to your own wallet, optional auto-conversion to stablecoins, and a single REST
API. API docs: [merchant.payzum.com/api/docs](https://merchant.payzum.com/api/docs).

## License

[MIT](LICENSE). Contributed and maintained by Payzum.
