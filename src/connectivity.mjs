export async function canReachTarget(url, timeoutMs = 8000, fetchFn) {
  const fetchImpl = fetchFn ?? fetch;
  try {
    await fetchImpl(url, {
      method: "HEAD",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs)
    });
    return true;
  } catch {
    return false;
  }
}
