/**
 * Stripe checkout for web-lane ventures, through Stripe's REST API (form-encoded):
 *   POST /v1/products        name, metadata
 *   POST /v1/prices          product, currency, unit_amount, recurring[interval], lookup_key
 *   POST /v1/payment_links   line_items[0][price], line_items[0][quantity]=1,
 *                            subscription_data[trial_period_days], after_completion[type]=redirect,
 *                            after_completion[redirect][url] (with {CHECKOUT_SESSION_ID})
 *   POST /v1/payment_links/{id}  active=false   (stop new purchases)
 * Every create carries an Idempotency-Key derived from venture + product, so a retried action
 * cannot create a second product or link. The web app appends client_reference_id=<appUserId>
 * to the link so the backend can attach the purchase to the user (RevenueCat Stripe receipts).
 * Writes are dry-run by default and answered with "dry_" ids.
 */
import type { CheckoutWrite } from "../../core/ports.ts";
import type { StoreProductDef, VentureBindings, WebCheckoutLink } from "../../core/types.ts";
import { HttpClient } from "../http.ts";
import type { DryRunRecorder, HttpRequest } from "../http.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  { name: "STRIPE_SECRET_KEY", purpose: "Stripe secret key (sk_live_… or a restricted key with Products, Prices and Payment Links write)", required: true },
  { name: "STRIPE_API_URL", purpose: "Stripe API base override (default https://api.stripe.com)", required: false },
];

export const STRIPE_API_URL = "https://api.stripe.com";

export interface StripeCheckoutOptions {
  env: Record<string, string | undefined>;
  dryRun: boolean;
  recorder?: DryRunRecorder;
  fetch?: typeof fetch;
}

/** Synthetic Stripe answers for dry-run writes. */
export function stripeDryRunResponse(req: HttpRequest): unknown {
  const path = new URL(req.url).pathname;
  const key = (req.idempotencyKey ?? "x").replace(/[^a-z0-9]/gi, "").slice(-12);
  if (path.endsWith("/v1/products")) return { id: `prod_dry_${key}` };
  if (path.endsWith("/v1/prices")) return { id: `price_dry_${key}` };
  if (path.endsWith("/v1/payment_links")) return { id: `plink_dry_${key}`, url: `https://buy.stripe.com/dry_${key}` };
  return { dryRun: true };
}

/** Stripe's recurring interval for a ladder period. */
export function stripeInterval(period: StoreProductDef["period"]): "week" | "month" | "year" {
  return period;
}

/** The form fields of one payment link (exported for tests). */
export function paymentLinkForm(req: { priceId: string; trialDays: number; successUrl: string; ventureId: string; productId: string }): Record<string, string> {
  const form: Record<string, string> = {
    "line_items[0][price]": req.priceId,
    "line_items[0][quantity]": "1",
    "after_completion[type]": "redirect",
    "after_completion[redirect][url]": req.successUrl,
    "metadata[ventureId]": req.ventureId,
    "metadata[productId]": req.productId,
  };
  // Stripe rejects trial_period_days 0; no trial is expressed by omitting it.
  if (req.trialDays > 0) form["subscription_data[trial_period_days]"] = String(req.trialDays);
  return form;
}

export class StripeCheckoutWrite implements CheckoutWrite {
  readonly kind = "live" as const;
  private readonly http: HttpClient;
  private readonly api: string;

  constructor(private readonly opts: StripeCheckoutOptions) {
    this.api = (opts.env.STRIPE_API_URL ?? STRIPE_API_URL).replace(/\/+$/, "");
    this.http = new HttpClient({
      service: "stripe",
      dryRun: opts.dryRun,
      dryRunResponse: stripeDryRunResponse,
      defaultHeaders: () => this.authHeaders(),
      ...(opts.recorder ? { recorder: opts.recorder } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  private authHeaders(): Record<string, string> {
    const key = this.opts.env.STRIPE_SECRET_KEY;
    if (!key) {
      if (this.opts.dryRun) return {};
      throw new Error("stripe: STRIPE_SECRET_KEY is not set");
    }
    return { authorization: `Bearer ${key}` };
  }

  private async post<T>(path: string, form: Record<string, string>, idempotencyKey: string): Promise<T> {
    const res = await this.http.request<T>({ method: "POST", url: `${this.api}${path}`, form, idempotencyKey });
    return res.data;
  }

  async createPaymentLinks(req: {
    ventureId: string;
    bindings: VentureBindings;
    products: StoreProductDef[];
    successUrl: string;
    currency: string;
  }): Promise<{ links: WebCheckoutLink[] }> {
    const links: WebCheckoutLink[] = [];
    for (const def of req.products) {
      const existing = req.bindings.checkoutLinks?.[def.ladderId];
      if (existing) {
        links.push({ productId: def.productId, ladderId: def.ladderId, ...existing });
        continue;
      }
      const base = `${req.ventureId}-${def.productId}`;
      const product = await this.post<{ id: string }>(
        "/v1/products",
        { name: def.displayName, "metadata[ventureId]": req.ventureId, "metadata[productId]": def.productId },
        `${base}-product`,
      );
      const price = await this.post<{ id: string }>(
        "/v1/prices",
        {
          product: product.id,
          currency: req.currency.toLowerCase(),
          unit_amount: String(def.usdCents),
          "recurring[interval]": stripeInterval(def.period),
          lookup_key: def.productId,
        },
        `${base}-price-${def.usdCents}-${def.period}`,
      );
      const link = await this.post<{ id: string; url: string }>(
        "/v1/payment_links",
        paymentLinkForm({ priceId: price.id, trialDays: def.trialDays, successUrl: req.successUrl, ventureId: req.ventureId, productId: def.productId }),
        `${base}-link-${price.id}`,
      );
      links.push({ productId: def.productId, ladderId: def.ladderId, url: link.url, linkId: link.id, priceId: price.id, stripeProductId: product.id });
    }
    return { links };
  }

  async deactivate(req: { linkIds: string[] }): Promise<void> {
    for (const id of req.linkIds) {
      await this.post(`/v1/payment_links/${encodeURIComponent(id)}`, { active: "false" }, `deactivate-${id}`);
    }
  }
}
