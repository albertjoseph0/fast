/**
 * What the studio needs besides ports and governance: the agent bundle, the builder and
 * filesystem locations. Injected so tests can replace any of them.
 */
import type { Agents } from "../agents/index.ts";
import type { TickContext } from "../core/context.ts";
import type { AppSpec, BuildRecord, Idea, SensitiveDomain, Venture } from "../core/types.ts";
import type { StudioConfig } from "../config/schema.ts";

export type RenderApp = (input: {
  venture: Venture;
  spec: AppSpec;
  idea: Idea;
  config: StudioConfig;
  domains: SensitiveDomain[];
  outRoot: string;
  templateDir: string;
}) => BuildRecord & { files: string[] };

export interface StudioDeps {
  agents: Agents;
  renderApp: RenderApp;
  /** Directory ventures are rendered into (one folder per slug). */
  outRoot: string;
  templateDir: string;
  /** Directory generated media is written into. */
  mediaRoot: string;
  /** Content format used to seed hooks from ideas. */
  defaultFormatId: string;
  /** Evidence for Apple 4.3 that the app differs from competitors and the portfolio. */
  differentiationReport: (ctx: TickContext, v: Venture) => Promise<string>;
}
