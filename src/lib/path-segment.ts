// encodeURIComponent leaves "." and ".." as path navigation, and the URL parser
// treats "%2E" the same way, so those values must not be interpolated.
export function seg(s: string): string {
  const dots = s.replace(/%2e/gi, ".");
  if (dots === "" || dots === "." || dots === "..") {
    throw new Error("invalid path segment");
  }
  return encodeURIComponent(s);
}
