export const HLS_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
seg0.m4s
#EXT-X-ENDLIST
`;

export function hlsFiles(playlist = HLS_PLAYLIST): { name: string; content: string; encoding?: "utf8" | "base64" }[] {
  return [
    { name: "index.m3u8", content: playlist },
    { name: "init.mp4", content: "aW5pdA==", encoding: "base64" },
    { name: "seg0.m4s", content: "c2VnMA==", encoding: "base64" },
  ];
}

export function hlsPlaylist(segmentCount: number, durationSec = 4, end = false): string {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${durationSec}`,
    end ? "#EXT-X-PLAYLIST-TYPE:VOD" : "#EXT-X-PLAYLIST-TYPE:EVENT",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    '#EXT-X-MAP:URI="init.mp4"',
  ];
  for (let i = 0; i < segmentCount; i++) {
    lines.push(`#EXTINF:${durationSec.toFixed(1)},`, `seg${i}.m4s`);
  }
  if (end) lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

export function hlsFilesForSegments(segmentCount: number, durationSec = 4): { name: string; content: string; encoding?: "utf8" | "base64" }[] {
  const files: { name: string; content: string; encoding?: "utf8" | "base64" }[] = [
    { name: "index.m3u8", content: hlsPlaylist(segmentCount, durationSec) },
    { name: "init.mp4", content: "aW5pdA==", encoding: "base64" },
  ];
  for (let i = 0; i < segmentCount; i++) {
    files.push({ name: `seg${i}.m4s`, content: btoa(`seg${i}`), encoding: "base64" });
  }
  return files;
}
