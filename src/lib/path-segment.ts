// encodeURIComponent leaves "." alone, and URL parsing treats "%2E" the same as ".",
// so "/a/.." and "/a/%2E%2E" both resolve away. No encoding is safe; refuse instead.
export function seg(s: string): string {
  if (s === "." || s === "..") throw new Error("invalid path segment");
  return encodeURIComponent(s);
}
