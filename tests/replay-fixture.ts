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
