const PREFIX = "casthop.blur.";

function key(deviceId: string): string {
  return PREFIX + (deviceId || "default");
}

export function loadBlurPref(deviceId: string): boolean {
  try {
    return localStorage.getItem(key(deviceId)) === "1";
  } catch {
    return false;
  }
}

export function saveBlurPref(deviceId: string, on: boolean): void {
  try {
    localStorage.setItem(key(deviceId), on ? "1" : "0");
  } catch {
    /* quota / private mode */
  }
}
