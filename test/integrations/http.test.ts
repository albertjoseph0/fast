import { describe, expect, it } from "vitest";
import { HttpClient, HttpError } from "../../src/integrations/http.ts";
import { verifyByOembed } from "../../src/integrations/sideshift/oembed.ts";

describe("HttpError", () => {
  it("never carries a secret query value in its message, url or body", async () => {
    const token = "123456|APP-SECRET-VALUE";
    const http = new HttpClient({
      service: "oembed",
      dryRun: true,
      sleep: async () => undefined,
      fetch: (async () => new Response(`{"error":"rate limited for ${token}","echo":"${encodeURIComponent(token)}"}`, { status: 503 })) as typeof fetch,
    });
    const err = await verifyByOembed(http, { url: "https://www.instagram.com/p/abc/", platform: "instagram", instagramToken: token }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    const e = err as HttpError;
    for (const text of [e.message, e.url, e.body]) {
      expect(text).not.toContain("APP-SECRET-VALUE");
      expect(text).not.toContain(encodeURIComponent(token));
    }
    expect(e.url).toContain("access_token=%3Credacted%3E");
    expect(e.status).toBe(503);
  });

  it("keeps a non-URL argument as is", () => {
    expect(new HttpError("svc", 400, "not a url", "bad").message).toBe("svc 400 not a url: bad");
  });
});
