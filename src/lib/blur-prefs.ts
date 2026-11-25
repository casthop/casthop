const PREFIX = "casthop.blur.";

function key(deviceId: string): string {
  return PREFIX + (deviceId || "default");
}

export function loadBlurPref(...deviceIds: string[]): boolean {
  try {
    return deviceIds.some((id) => localStorage.getItem(key(id)) === "1");
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

/** Write the same on/off value to a camera id and an optional second key. */
export function saveBlurPrefPair(deviceId: string, otherId: string, on: boolean): void {
  saveBlurPref(deviceId, on);
  if (otherId && otherId !== deviceId) saveBlurPref(otherId, on);
}

/** Copy an on-pref from one camera key to another if the destination has none yet. */
export function copyBlurPref(fromId: string, toId: string): void {
  if (!toId || fromId === toId) return;
  try {
    if (localStorage.getItem(key(toId)) !== null) return;
  } catch {
    return;
  }
  if (loadBlurPref(fromId)) saveBlurPref(toId, true);
}
