/**
 * ES256 JWT signing for Apple APIs (App Store Connect API tokens and Apple Ads OAuth
 * client secrets). Uses node:crypto only; signatures are raw r||s (IEEE P1363) as JWS requires.
 */
import { createPrivateKey, sign } from "node:crypto";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function signEs256Jwt(header: Record<string, unknown>, payload: Record<string, unknown>, privateKeyPem: string): string {
  const head = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", ...header }));
  const body = base64url(JSON.stringify(payload));
  const data = `${head}.${body}`;
  const signature = sign("sha256", Buffer.from(data), { key: createPrivateKey(privateKeyPem), dsaEncoding: "ieee-p1363" });
  return `${data}.${base64url(signature)}`;
}

/** App Store Connect API token (max lifetime 20 minutes). */
export function ascToken(opts: { keyId: string; issuerId: string; privateKeyPem: string; nowSec: number; ttlSec?: number }): string {
  const ttl = Math.min(opts.ttlSec ?? 1_140, 1_200);
  return signEs256Jwt(
    { kid: opts.keyId },
    { iss: opts.issuerId, iat: opts.nowSec, exp: opts.nowSec + ttl, aud: "appstoreconnect-v1" },
    opts.privateKeyPem,
  );
}
