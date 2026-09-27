/** Merge this browser's token into users/{uid}.fcmTokens (the server dedupes
 *  and keeps the 10 newest; alert-service prunes dead ones on send). */
export function mergeToken(existing: string[] | undefined, token: string): string[] | null {
  const list = existing ?? [];
  return list.includes(token) ? null : [...list, token];
}
