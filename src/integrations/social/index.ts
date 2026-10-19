/**
 * Live SocialRead/SocialWrite: dispatch by platform to the Instagram, TikTok and YouTube
 * adapters. Read and write share adapter instances (and so cached tokens) when built
 * through createLiveSocial.
 */
import type { Clock, SocialRead, SocialWrite } from "../../core/ports.ts";
import type { ExternalJob, JobPoll, JobRef, Platform, PostStats } from "../../core/types.ts";
import { SystemClock } from "../../core/clock.ts";
import { InstagramClient } from "./instagram.ts";
import { TikTokClient } from "./tiktok.ts";
import { YouTubeClient } from "./youtube.ts";
import type { PlatformPublisher, PublishRequest, SocialClientOptions } from "./common.ts";

export { ENV_VARS as INSTAGRAM_ENV_VARS } from "./instagram.ts";
export { ENV_VARS as TIKTOK_ENV_VARS } from "./tiktok.ts";
export { ENV_VARS as YOUTUBE_ENV_VARS } from "./youtube.ts";
export type { PlatformPublisher, SocialClientOptions } from "./common.ts";

export interface LiveSocialOptions extends SocialClientOptions {
  /** TikTok direct posting needs the audited client; defaults to config.distribution.tiktokAudited. */
  tiktokAudited?: boolean;
  /** Replace individual platform adapters (tests, alternative clients). */
  adapters?: Partial<Record<Platform, PlatformPublisher>>;
}

export type SocialAdapters = Partial<Record<Platform, PlatformPublisher>>;

export function socialAdapters(opts: LiveSocialOptions): SocialAdapters {
  return {
    instagram: new InstagramClient(opts),
    tiktok: new TikTokClient({ ...opts, audited: opts.tiktokAudited ?? opts.config.distribution.tiktokAudited }),
    youtube: new YouTubeClient(opts),
    ...opts.adapters,
  };
}

function adapterFor(adapters: SocialAdapters, platform: string): PlatformPublisher {
  const adapter = adapters[platform as Platform];
  if (!adapter) throw new Error(`social publishing on ${platform} is not supported`);
  return adapter;
}

export class LiveSocialWrite implements SocialWrite {
  readonly kind = "live" as const;
  private readonly adapters: SocialAdapters;
  private readonly clock: Clock;

  constructor(opts: LiveSocialOptions, adapters?: SocialAdapters) {
    this.adapters = adapters ?? socialAdapters(opts);
    this.clock = opts.clock ?? new SystemClock();
  }

  async publish(req: PublishRequest): Promise<JobRef> {
    const { account, platform } = req;
    if (account.platform !== platform) throw new Error(`account ${account.id} is a ${account.platform} account, not ${platform}`);
    if (account.status !== "active") throw new Error(`account ${account.id} is ${account.status}`);
    if (account.standingConsent.expiresAt <= this.clock.iso()) throw new Error(`account ${account.id}: standing consent expired ${account.standingConsent.expiresAt}`);
    const job = await adapterFor(this.adapters, platform).publish(req);
    return { ...job, externalRef: { ...job.externalRef, platform, accountId: account.id, contentId: req.piece.id } };
  }
}

export class LiveSocialRead implements SocialRead {
  readonly kind = "live" as const;
  private readonly adapters: SocialAdapters;

  constructor(
    private readonly opts: LiveSocialOptions,
    adapters?: SocialAdapters,
  ) {
    this.adapters = adapters ?? socialAdapters(opts);
  }

  async postStats(req: Parameters<SocialRead["postStats"]>[0]): Promise<PostStats> {
    return adapterFor(this.adapters, req.platform).postStats(req.externalId, req.account);
  }

  async poll(job: ExternalJob): Promise<JobPoll> {
    if (job.op !== "social.publish") return { status: "failed", error: `social poll cannot handle ${job.op}` };
    const platform = job.externalRef.platform;
    if (!platform) return { status: "failed", error: `job ${job.id} has no platform in externalRef` };
    const accountId = job.externalRef.accountId;
    const account = accountId ? this.opts.store.accounts.get(accountId) : undefined;
    return adapterFor(this.adapters, platform).poll(job, account);
  }
}

/** Read and write ports over one set of adapters. */
export function createLiveSocial(opts: LiveSocialOptions): { read: LiveSocialRead; write: LiveSocialWrite } {
  const adapters = socialAdapters(opts);
  return { read: new LiveSocialRead(opts, adapters), write: new LiveSocialWrite(opts, adapters) };
}
