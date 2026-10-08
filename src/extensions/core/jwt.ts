/** Reads a JWT's claims without verifying it. For display and grouping only, never for trust. */
export function jwtClaims(token: string | undefined): Record<string, unknown> {
  const payload = token?.split(".")[1];
  if (!payload) {
    return {};
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return claims && typeof claims === "object" && !Array.isArray(claims) ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The OpenAI-specific claim group of a ChatGPT access token, e.g. `chatgpt_account_id`. */
export function openAiClaim(token: string | undefined, group: "auth" | "profile"): Record<string, unknown> {
  const value = jwtClaims(token)[`https://api.openai.com/${group}`];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
