/** Optional GPT-Live background. Omitting it preserves legacy providers. */
export interface CallContext {
  context?: string;
  openingMessage?: string;
}
export function callContextFields(input: CallContext): CallContext {
  const fields: CallContext = {};
  for (const [key, limit] of [
    ["context", 4000],
    ["openingMessage", 400],
  ] as const) {
    const value = input[key];
    if (value == null) continue;
    if (typeof value !== "string" || [...value].length > limit)
      throw new Error(`${key} must be text of at most ${limit} characters`);
    if (value.trim()) fields[key] = value.trim();
  }
  return fields;
}
