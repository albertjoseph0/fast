/**
 * Live SocialTrendPort: every configured trend source, queried term by term. A source with no
 * credentials is absent; a term that errors is skipped, so one bad request cannot empty a scan.
 * Each source caps how many terms one scan may use (its platform quota); terms are taken in
 * sorted order so repeated scans hit the same hashtags and stay inside Instagram's weekly limit.
 */
import type { Clock, SocialTrendPort, TrendObservation } from "../../core/ports.ts";
import type { TrendSource } from "../../core/types.ts";
import { type Env, type TrendSourceClient } from "./common.ts";
import { ENV_VARS as INSTAGRAM_ENV, InstagramTrendSource, instagramConfigured } from "./instagram.ts";
import { ENV_VARS as META_ENV, MetaAdLibrarySource, metaAdLibraryConfigured } from "./metaAdLibrary.ts";
import { ENV_VARS as YOUTUBE_ENV, YouTubeTrendSource, youtubeConfigured } from "./youtube.ts";

export const TREND_ENV_VARS = { youtube: YOUTUBE_ENV, instagram: INSTAGRAM_ENV, metaAds: META_ENV };

export function liveTrendSources(opts: { env: Env; clock: Clock; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }): TrendSourceClient[] {
  const out: TrendSourceClient[] = [];
  if (youtubeConfigured(opts.env)) out.push(new YouTubeTrendSource(opts));
  if (instagramConfigured(opts.env)) out.push(new InstagramTrendSource(opts));
  if (metaAdLibraryConfigured(opts.env)) out.push(new MetaAdLibrarySource(opts));
  return out;
}

export class LiveSocialTrendPort implements SocialTrendPort {
  readonly kind = "live" as const;

  constructor(private readonly clients: TrendSourceClient[]) {}

  sources(): TrendSource[] {
    return this.clients.map((c) => c.source);
  }

  async scan(req: { terms: string[]; country: string; sinceDays: number }): Promise<TrendObservation[]> {
    const terms = [...new Set(req.terms.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
    const perSource = await Promise.all(
      this.clients.map(async (client) => {
        const out: TrendObservation[] = [];
        // Sequential within a source: these APIs rate-limit per token.
        for (const term of terms.slice(0, client.maxTermsPerScan)) {
          try {
            const obs = await client.scanTerm({ term, country: req.country, sinceDays: req.sinceDays });
            if (obs) out.push(obs);
          } catch {
            // Skipped: quota, permission or a transient failure. The other terms still count.
          }
        }
        return out;
      }),
    );
    return perSource.flat();
  }
}
