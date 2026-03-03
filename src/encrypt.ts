// Small crypto helpers used by the Worker

// --- Base64URL encode ---
export const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
};

// --- Base64URL decode ---
export const b64Decode = (str: string) => {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  // Pad with '=' to multiple of 4
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

export async function signJWT(payload: object, secret: string) {
  const encoder = new TextEncoder();
  const header = b64(
    encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const claims = b64(
    encoder.encode(
      JSON.stringify({
        ...payload,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days expiry
      }),
    ),
  );

  const partial = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(partial));
  return `${partial}.${b64(sig)}`;
}

export async function verifyJWT(token: string, secret: string | undefined) {
  if (!secret) return null;
  const [header, claims, signature] = token.split(".");
  if (!header || !claims || !signature) return null;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const expectedSigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${header}.${claims}`),
  );

  const expectedSig = b64(expectedSigBuf);

  // Compare Base64URL-encoded signatures
  if (expectedSig !== signature) return null;

  // Decode claims
  const decodedClaims = JSON.parse(new TextDecoder().decode(b64Decode(claims)));
  return decodedClaims;
}
