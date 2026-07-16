export async function canReachTarget(url, timeoutMs = 8000, fetchFn = globalThis.fetch) {
  try {
    await fetchFn(url, {
      method: "HEAD",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs)
    });
    return true;
  } catch {
    return false;
  }
}
