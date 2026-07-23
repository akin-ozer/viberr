export async function withFileLock<T>(
  key: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  return navigator.locks.request(key, () => Promise.resolve().then(fn));
}
