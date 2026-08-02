// Fails fast with a clear message when a required secret is missing, instead of letting the SDK throw an opaque error later.
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9_-]{10,}/g,
  /Bearer\s+[a-zA-Z0-9._-]+/gi,
  /(api[_-]?key["']?\s*[:=]\s*["']?)[a-zA-Z0-9._-]{8,}/gi,
];

// Strips common secret/token shapes from a string before it's logged or fed back into a prompt.
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, "[REDACTED]"), text);
}
