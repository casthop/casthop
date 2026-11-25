interface MediaStreamTrackProcessor<T = VideoFrame> {
  readonly readable: ReadableStream<T>;
}

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
}

declare const MediaStreamTrackProcessor: {
  prototype: MediaStreamTrackProcessor;
  new <T = VideoFrame>(init: MediaStreamTrackProcessorInit): MediaStreamTrackProcessor<T>;
};

interface MediaStreamTrackGenerator<T = VideoFrame> extends MediaStreamTrack {
  readonly writable: WritableStream<T>;
}

interface MediaStreamTrackGeneratorInit {
  kind: "audio" | "video";
}

declare const MediaStreamTrackGenerator: {
  prototype: MediaStreamTrackGenerator;
  new <T = VideoFrame>(init: MediaStreamTrackGeneratorInit): MediaStreamTrackGenerator<T>;
};
