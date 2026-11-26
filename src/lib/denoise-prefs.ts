const PREFIX = "casthop.denoise.";

function key(deviceId: string): string {
  return PREFIX + (deviceId || "default");
}

/** Default on. An explicit "0" wins unless another listed id is "1". */
export function loadDenoisePref(...deviceIds: string[]): boolean {
  try {
    let sawOff = false;
    for (const id of deviceIds) {
      const v = localStorage.getItem(key(id));
      if (v === "1") return true;
      if (v === "0") sawOff = true;
    }
    return !sawOff;
  } catch {
    return true;
  }
}

export function saveDenoisePref(deviceId: string, on: boolean): void {
  try {
    localStorage.setItem(key(deviceId), on ? "1" : "0");
  } catch {
    /* quota / private mode */
  }
}

/** Write the same on/off value to a mic id and an optional second key. */
export function saveDenoisePrefPair(deviceId: string, otherId: string, on: boolean): void {
  saveDenoisePref(deviceId, on);
  if (otherId && otherId !== deviceId) saveDenoisePref(otherId, on);
}

/** Copy an explicit pref from one mic key to another if the destination has none yet. */
export function copyDenoisePref(fromId: string, toId: string): void {
  if (!toId || fromId === toId) return;
  try {
    if (localStorage.getItem(key(toId)) !== null) return;
    const v = localStorage.getItem(key(fromId));
    if (v === "0") saveDenoisePref(toId, false);
    else if (v === "1") saveDenoisePref(toId, true);
  } catch {
    /* quota / private mode */
  }
}
