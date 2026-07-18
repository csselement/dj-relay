import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

type TokenFields = {
  role?: "dj" | "listener";
  sessionId?: string;
  listenerId?: string;
  producerPreview?: boolean;
  path?: string;
};

export type TokenPayload =
  | (TokenFields & { kind: "admin"; exp: number })
  | (TokenFields & { kind: "invite"; exp: number })
  | (TokenFields & { kind: "media"; exp: number })
  | (TokenFields & { kind: "share"; exp?: number });

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function signToken(payload: TokenPayload, secret: string): string {
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyToken(token: string | undefined, secret: string): TokenPayload | null {
  if (!token) return null;
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) return null;

  const expected = createHmac("sha256", secret).update(body).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
    // Listener share links are durable capabilities and remain valid until the
    // producer deletes their session. Ignore exp on legacy share links so links
    // created before durable sharing was introduced keep working too.
    if (payload.kind !== "share" && (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000))) return null;
    return payload;
  } catch {
    return null;
  }
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
