import { get, set } from "idb-keyval";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { DirectoryNode, TrackNode, scanMusicTree } from "./lib/fs";
import { activeLyricIndex, LyricLine, parseLrc } from "./lib/lrc";
import { TrackMetadata, parseTrackMetadata } from "./lib/metadata";

const ROOT_HANDLE_KEY = "music-root-handle";
const TREE_OPEN_STATE_KEY = "library-open-directories";
const LYRIC_FIELD_MAPPING_KEY = "bluetooth-lyric-field-mapping";
const LYRIC_WIDTH_SCALE_KEY = "bluetooth-lyric-width-scale";
const LYRIC_SCROLL_PROFILE_KEY = "bluetooth-lyric-scroll-profile";
const LYRIC_UPDATE_INTERVAL_KEY = "bluetooth-lyric-update-interval-ms";
const LYRIC_MIN_SONG_METADATA_SECONDS_KEY = "bluetooth-lyric-min-song-metadata-seconds";
const PLAYBACK_SNAPSHOT_KEY = "playback-snapshot";

const BLUETOOTH_WIDTH_BASELINE_M = 14;
const BLUETOOTH_WIDTH_SAFETY = 0.9;
const DEFAULT_LYRIC_WIDTH_SCALE = 1;
const LYRIC_TIMELINE_TICK_MS = 100;
const DEFAULT_METADATA_REFRESH_INTERVAL_MS = 100;
const MIN_METADATA_REFRESH_INTERVAL_MS = 10;
const MAX_METADATA_REFRESH_INTERVAL_MS = 5000;
const DEFAULT_MIN_SONG_METADATA_SECONDS = 5;
const MIN_SONG_METADATA_SECONDS = 0;
const MAX_SONG_METADATA_SECONDS = 30;
const DEFAULT_SCROLL_DWELL_START = 0.25;
const DEFAULT_SCROLL_DWELL_END = 0.25;
const MIN_SCROLL_PORTION = 0.1;
const EMPTY_METADATA_PLACEHOLDER = " ";

type MetadataField = "title" | "artist" | "album";
type LyricLineRole = "previous" | "current" | "next";

interface BluetoothMetadataPayload {
  title: string;
  artist: string;
  album: string;
  artworkUrl?: string;
}

interface PlaybackSnapshot {
  trackId: string;
  positionSeconds: number;
  wasPlaying: boolean;
}

interface PlayTrackOptions {
  autoplay?: boolean;
  startTimeSeconds?: number;
  expandDirectory?: boolean;
}

function directoryAncestorsFromTrackPath(trackPath: string): string[] {
  const parts = trackPath.split("/").filter(Boolean);
  if (parts.length < 2) {
    return [];
  }

  const directoryParts = parts.slice(0, -1);
  const ancestors: string[] = [];
  for (let index = 0; index < directoryParts.length; index += 1) {
    ancestors.push(directoryParts.slice(0, index + 1).join("/"));
  }
  return ancestors;
}

const LINE_ROLE_LABELS: Record<LyricLineRole, string> = {
  previous: "Previous line",
  current: "Current line",
  next: "Next line",
};

const FIELD_LABELS: Record<MetadataField, string> = {
  title: "Title",
  artist: "Artist",
  album: "Album",
};

const DEFAULT_FIELD_MAPPING: Record<MetadataField, LyricLineRole> = {
  title: "previous",
  artist: "current",
  album: "next",
};

function splitGraphemes(text: string): string[] {
  const maybeIntl = Intl as unknown as {
    Segmenter?: new (locale?: string | string[], options?: { granularity: string }) => {
      segment(input: string): Iterable<{ segment: string }>;
    };
  };

  if (typeof maybeIntl.Segmenter === "function") {
    const segmenter = new maybeIntl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

function createTextWidthMeasurer() {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return (text: string) => text.length * 8;
  }

  context.font = '16px "Segoe UI", sans-serif';
  return (text: string) => context.measureText(text).width;
}

function buildFittingWindows(text: string, maxWidthPx: number, measureWidth: (text: string) => number): string[] {
  if (!text.trim()) {
    return [""];
  }

  if (measureWidth(text.trimStart()) <= maxWidthPx) {
    return [text.trimStart()];
  }

  const graphemes = splitGraphemes(text);
  const windows: string[] = [];

  for (let start = 0; start < graphemes.length; start += 1) {
    let candidate = "";
    let reachedLineEnd = false;
    for (let end = start; end < graphemes.length; end += 1) {
      const nextCandidate = candidate + graphemes[end];
      if (measureWidth(nextCandidate.trimStart()) <= maxWidthPx) {
        candidate = nextCandidate;
        reachedLineEnd = end === graphemes.length - 1;
        continue;
      }
      break;
    }

    if (!candidate) {
      candidate = graphemes[start];
    }

    const normalized = candidate.trimStart();
    const finalWindow = normalized || candidate;
    if (windows[windows.length - 1] !== finalWindow) {
      windows.push(finalWindow);
    }

    if (reachedLineEnd) {
      break;
    }
  }

  return windows.length > 0 ? windows : [text];
}

function metadataFieldValueOrPlaceholder(text: string): string {
  return text.trim().length > 0 ? text : EMPTY_METADATA_PLACEHOLDER;
}

function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return "0:00";
  }
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${seconds}`;
}

interface TreeProps {
  node: DirectoryNode;
  currentTrackId: string | null;
  onPlay(track: TrackNode): void;
  openDirectories: Record<string, boolean>;
  onDirectoryOpenChange(directoryId: string, open: boolean): void;
  isRoot?: boolean;
}

function TreeNode({
  node,
  currentTrackId,
  onPlay,
  openDirectories,
  onDirectoryOpenChange,
  isRoot = false,
}: TreeProps) {
  const isOpen = openDirectories[node.id] ?? isRoot;

  return (
    <details
      className="tree-node"
      open={isOpen}
      onToggle={(event) => {
        onDirectoryOpenChange(node.id, event.currentTarget.open);
      }}
    >
      <summary>{node.name}</summary>
      <div className="tree-children">
        {node.directories.map((directory) => (
          <TreeNode
            key={directory.id}
            node={directory}
            onPlay={onPlay}
            currentTrackId={currentTrackId}
            openDirectories={openDirectories}
            onDirectoryOpenChange={onDirectoryOpenChange}
          />
        ))}
        {node.tracks.map((track) => (
          <button
            key={track.id}
            className={`track-button ${track.id === currentTrackId ? "track-button-active" : ""}`}
            onClick={() => onPlay(track)}
            type="button"
          >
            {track.name}
          </button>
        ))}
      </div>
    </details>
  );
}

export default function App() {
  const [tree, setTree] = useState<DirectoryNode | null>(null);
  const [tracks, setTracks] = useState<TrackNode[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [currentMetadata, setCurrentMetadata] = useState<TrackMetadata | null>(null);
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [openDirectories, setOpenDirectories] = useState<Record<string, boolean>>({});
  const [openStateHydrated, setOpenStateHydrated] = useState(false);
  const [fieldMapping, setFieldMapping] = useState<Record<MetadataField, LyricLineRole>>(DEFAULT_FIELD_MAPPING);
  const [fieldMappingHydrated, setFieldMappingHydrated] = useState(false);
  const [lyricWidthScale, setLyricWidthScale] = useState(DEFAULT_LYRIC_WIDTH_SCALE);
  const [lyricWidthScaleHydrated, setLyricWidthScaleHydrated] = useState(false);
  const [scrollDwellStart, setScrollDwellStart] = useState(DEFAULT_SCROLL_DWELL_START);
  const [scrollDwellEnd, setScrollDwellEnd] = useState(DEFAULT_SCROLL_DWELL_END);
  const [scrollProfileHydrated, setScrollProfileHydrated] = useState(false);
  const [metadataRefreshIntervalMs, setMetadataRefreshIntervalMs] = useState(DEFAULT_METADATA_REFRESH_INTERVAL_MS);
  const [metadataRefreshIntervalHydrated, setMetadataRefreshIntervalHydrated] = useState(false);
  const [minSongMetadataSeconds, setMinSongMetadataSeconds] = useState(DEFAULT_MIN_SONG_METADATA_SECONDS);
  const [minSongMetadataSecondsHydrated, setMinSongMetadataSecondsHydrated] = useState(false);
  const [savedPlaybackSnapshot, setSavedPlaybackSnapshot] = useState<PlaybackSnapshot | null>(null);
  const [savedPlaybackSnapshotHydrated, setSavedPlaybackSnapshotHydrated] = useState(false);

  const audioRef = useRef(new Audio());
  const trackObjectUrlRef = useRef<string | null>(null);
  const artworkUrlRef = useRef<string | null>(null);
  const lastMetadataSentAtRef = useRef(0);
  const lastSentMetadataSignatureRef = useRef<string | null>(null);
  const pendingMetadataRef = useRef<BluetoothMetadataPayload | null>(null);
  const metadataFlushTimerRef = useRef<number | null>(null);
  const restoreInFlightRef = useRef(false);
  const restoredSnapshotTrackIdRef = useRef<string | null>(null);
  const latestPlaybackSnapshotRef = useRef<PlaybackSnapshot | null>(null);

  const currentTrackIndex = useMemo(
    () => tracks.findIndex((track) => track.id === currentTrackId),
    [tracks, currentTrackId]
  );

  const measureTextWidth = useMemo(() => createTextWidthMeasurer(), []);

  const lyricWidthLimitPx = useMemo(() => {
    return measureTextWidth("M".repeat(BLUETOOTH_WIDTH_BASELINE_M)) * BLUETOOTH_WIDTH_SAFETY * lyricWidthScale;
  }, [measureTextWidth, lyricWidthScale]);

  const scrollPortion = useMemo(() => {
    const raw = 1 - scrollDwellStart - scrollDwellEnd;
    return Math.max(MIN_SCROLL_PORTION, raw);
  }, [scrollDwellStart, scrollDwellEnd]);

  const activeLyric = useMemo(() => activeLyricIndex(lyrics, currentTime * 1000), [lyrics, currentTime]);

  const shouldUseLyricsWindow = useMemo(() => {
    if (lyrics.length === 0) {
      return false;
    }

    const firstLyricSeconds = lyrics[0].timeMs / 1000;
    const activationTimeSeconds = Math.max(firstLyricSeconds, minSongMetadataSeconds);
    return currentTime >= activationTimeSeconds;
  }, [lyrics, currentTime, minSongMetadataSeconds]);

  const lyricWindow = useMemo(() => {
    const previousText = activeLyric > 0 ? lyrics[activeLyric - 1].text : "";
    const currentText = activeLyric >= 0 ? lyrics[activeLyric].text : "";
    const nextText = activeLyric >= 0 && activeLyric < lyrics.length - 1 ? lyrics[activeLyric + 1].text : "";

    const previousWindows = buildFittingWindows(previousText, lyricWidthLimitPx, measureTextWidth);
    const currentWindows = buildFittingWindows(currentText, lyricWidthLimitPx, measureTextWidth);
    const nextWindows = buildFittingWindows(nextText, lyricWidthLimitPx, measureTextWidth);

    const currentLineStartMs = activeLyric >= 0 ? lyrics[activeLyric].timeMs : 0;
    const currentLineEndMs = activeLyric >= 0 && activeLyric < lyrics.length - 1 ? lyrics[activeLyric + 1].timeMs : currentLineStartMs + 4000;
    const lineDurationMs = Math.max(300, currentLineEndMs - currentLineStartMs);
    const elapsedInLineMs = currentTime * 1000 - currentLineStartMs;
    const normalizedLineProgress = Math.min(1, Math.max(0, elapsedInLineMs / lineDurationMs));
    const scrollStart = scrollDwellStart;
    const scrollEnd = Math.min(1 - MIN_SCROLL_PORTION, scrollDwellStart + scrollPortion);

    let progress = 0;
    if (normalizedLineProgress <= scrollStart) {
      progress = 0;
    } else if (normalizedLineProgress >= scrollEnd) {
      progress = 1;
    } else {
      progress = (normalizedLineProgress - scrollStart) / (scrollEnd - scrollStart);
    }

    const currentWindowIndex =
      currentWindows.length <= 1 ? 0 : Math.min(currentWindows.length - 1, Math.floor(progress * (currentWindows.length - 1)));

    return {
      previous: previousWindows[previousWindows.length - 1] ?? "",
      current: currentWindows[currentWindowIndex] ?? "",
      next: nextWindows[0] ?? "",
    };
  }, [lyrics, activeLyric, lyricWidthLimitPx, measureTextWidth, currentTime, scrollDwellStart, scrollPortion]);

  const handleDirectoryOpenChange = useCallback((directoryId: string, open: boolean) => {
    setOpenDirectories((prev) => {
      if (prev[directoryId] === open) {
        return prev;
      }

      return {
        ...prev,
        [directoryId]: open,
      };
    });
  }, []);

  const scanDirectory = useCallback(async (handle: FileSystemDirectoryHandle) => {
    setIsScanning(true);
    setScanError(null);
    try {
      const permission = await handle.requestPermission({ mode: "read" });
      if (permission !== "granted") {
        setScanError("Permission to read this directory was not granted.");
        return;
      }

      const result = await scanMusicTree(handle);
      setTree(result.root);
      setTracks(result.flatTracks);
      await set(ROOT_HANDLE_KEY, handle);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to scan this directory.";
      setScanError(message);
    } finally {
      setIsScanning(false);
    }
  }, []);

  const handlePickDirectory = useCallback(async () => {
    if (!("showDirectoryPicker" in window)) {
      setScanError("This browser does not support directory picking.");
      return;
    }

    try {
      const handle = await window.showDirectoryPicker({ id: "bars-player-folder", mode: "read" });
      await scanDirectory(handle);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      const message = error instanceof Error ? error.message : "Could not open directory picker.";
      setScanError(message);
    }
  }, [scanDirectory]);

  const playTrack = useCallback(
    async (track: TrackNode, options?: PlayTrackOptions) => {
      const audio = audioRef.current;
      const file = await track.fileHandle.getFile();
      const autoplay = options?.autoplay ?? true;
      const startTimeSeconds = Math.max(0, options?.startTimeSeconds ?? 0);
      const expandDirectory = options?.expandDirectory ?? false;

      if (trackObjectUrlRef.current) {
        URL.revokeObjectURL(trackObjectUrlRef.current);
      }
      const audioUrl = URL.createObjectURL(file);
      trackObjectUrlRef.current = audioUrl;

      setCurrentTrackId(track.id);
      setCurrentTime(startTimeSeconds);
      setDuration(0);

      if (expandDirectory) {
        const ancestorDirectories = directoryAncestorsFromTrackPath(track.path);
        if (ancestorDirectories.length > 0) {
          setOpenDirectories((prev) => {
            const next = { ...prev };
            for (const directoryId of ancestorDirectories) {
              next[directoryId] = true;
            }
            return next;
          });
        }
      }

      audio.src = audioUrl;
      audio.currentTime = startTimeSeconds;

      if (autoplay) {
        try {
          await audio.play();
        } catch {
          audio.pause();
          setIsPlaying(false);
        }
      } else {
        audio.pause();
        setIsPlaying(false);
      }

      if (artworkUrlRef.current) {
        URL.revokeObjectURL(artworkUrlRef.current);
        artworkUrlRef.current = null;
      }

      const metadata = await parseTrackMetadata(file, track.path);
      if (metadata.artworkUrl) {
        artworkUrlRef.current = metadata.artworkUrl;
      }
      setCurrentMetadata(metadata);

      if (track.lrcHandle) {
        const lrcFile = await track.lrcHandle.getFile();
        const lrcText = await lrcFile.text();
        setLyrics(parseLrc(lrcText));
      } else {
        setLyrics([]);
      }
    },
    []
  );

  const playPrevious = useCallback(() => {
    if (tracks.length === 0) {
      return;
    }

    const prevIndex = currentTrackIndex <= 0 ? tracks.length - 1 : currentTrackIndex - 1;
    void playTrack(tracks[prevIndex]);
  }, [tracks, currentTrackIndex, playTrack]);

  const playNext = useCallback(() => {
    if (tracks.length === 0) {
      return;
    }

    const nextIndex = currentTrackIndex >= tracks.length - 1 ? 0 : currentTrackIndex + 1;
    void playTrack(tracks[nextIndex]);
  }, [tracks, currentTrackIndex, playTrack]);

  const playNextAutoExpand = useCallback(() => {
    if (tracks.length === 0) {
      return;
    }

    const nextIndex = currentTrackIndex >= tracks.length - 1 ? 0 : currentTrackIndex + 1;
    void playTrack(tracks[nextIndex], { expandDirectory: true });
  }, [tracks, currentTrackIndex, playTrack]);

  useEffect(() => {
    const audio = audioRef.current;
    const handleLoadedMetadata = () => setDuration(audio.duration || 0);
    const handleDurationChange = () => setDuration(audio.duration || 0);
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => {
      setIsPlaying(false);
      setCurrentTime(audio.currentTime || 0);
    };
    const handleEnded = () => playNextAutoExpand();

    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("durationchange", handleDurationChange);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("durationchange", handleDurationChange);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
    };
  }, [playNextAutoExpand]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const audio = audioRef.current;
      if (!audio.paused) {
        setCurrentTime(audio.currentTime || 0);
      }
    }, LYRIC_TIMELINE_TICK_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    void (async () => {
      const storedState = await get<Record<string, boolean>>(TREE_OPEN_STATE_KEY);
      if (storedState) {
        setOpenDirectories(storedState);
      }
      setOpenStateHydrated(true);
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const storedMapping = await get<Record<MetadataField, LyricLineRole>>(LYRIC_FIELD_MAPPING_KEY);
      if (storedMapping) {
        setFieldMapping({
          title: storedMapping.title ?? DEFAULT_FIELD_MAPPING.title,
          artist: storedMapping.artist ?? DEFAULT_FIELD_MAPPING.artist,
          album: storedMapping.album ?? DEFAULT_FIELD_MAPPING.album,
        });
      }
      setFieldMappingHydrated(true);
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const storedScale = await get<number>(LYRIC_WIDTH_SCALE_KEY);
      if (typeof storedScale === "number" && Number.isFinite(storedScale)) {
        setLyricWidthScale(storedScale);
      }
      setLyricWidthScaleHydrated(true);
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const storedProfile = await get<{ start: number; end: number }>(LYRIC_SCROLL_PROFILE_KEY);
      if (storedProfile) {
        const nextStart = Math.min(0.9, Math.max(0, storedProfile.start ?? DEFAULT_SCROLL_DWELL_START));
        const nextEnd = Math.min(0.9, Math.max(0, storedProfile.end ?? DEFAULT_SCROLL_DWELL_END));
        const overflow = Math.max(0, nextStart + nextEnd - (1 - MIN_SCROLL_PORTION));
        setScrollDwellStart(Math.max(0, nextStart - overflow / 2));
        setScrollDwellEnd(Math.max(0, nextEnd - overflow / 2));
      }
      setScrollProfileHydrated(true);
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const storedInterval = await get<number>(LYRIC_UPDATE_INTERVAL_KEY);
      if (typeof storedInterval === "number" && Number.isFinite(storedInterval)) {
        const clamped = Math.min(
          MAX_METADATA_REFRESH_INTERVAL_MS,
          Math.max(MIN_METADATA_REFRESH_INTERVAL_MS, Math.round(storedInterval))
        );
        setMetadataRefreshIntervalMs(clamped);
      }
      setMetadataRefreshIntervalHydrated(true);
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const storedMinSeconds = await get<number>(LYRIC_MIN_SONG_METADATA_SECONDS_KEY);
      if (typeof storedMinSeconds === "number" && Number.isFinite(storedMinSeconds)) {
        const clamped = Math.min(MAX_SONG_METADATA_SECONDS, Math.max(MIN_SONG_METADATA_SECONDS, storedMinSeconds));
        setMinSongMetadataSeconds(clamped);
      }
      setMinSongMetadataSecondsHydrated(true);
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const storedSnapshot = await get<PlaybackSnapshot>(PLAYBACK_SNAPSHOT_KEY);
      if (storedSnapshot && typeof storedSnapshot.trackId === "string") {
        setSavedPlaybackSnapshot({
          trackId: storedSnapshot.trackId,
          positionSeconds: Math.max(0, Number(storedSnapshot.positionSeconds) || 0),
          wasPlaying: Boolean(storedSnapshot.wasPlaying),
        });
      }
      setSavedPlaybackSnapshotHydrated(true);
    })();
  }, []);

  useEffect(() => {
    if (!openStateHydrated) {
      return;
    }
    void set(TREE_OPEN_STATE_KEY, openDirectories);
  }, [openDirectories, openStateHydrated]);

  useEffect(() => {
    if (!fieldMappingHydrated) {
      return;
    }
    void set(LYRIC_FIELD_MAPPING_KEY, fieldMapping);
  }, [fieldMapping, fieldMappingHydrated]);

  useEffect(() => {
    if (!lyricWidthScaleHydrated) {
      return;
    }
    void set(LYRIC_WIDTH_SCALE_KEY, lyricWidthScale);
  }, [lyricWidthScale, lyricWidthScaleHydrated]);

  useEffect(() => {
    if (!scrollProfileHydrated) {
      return;
    }
    void set(LYRIC_SCROLL_PROFILE_KEY, {
      start: scrollDwellStart,
      end: scrollDwellEnd,
    });
  }, [scrollProfileHydrated, scrollDwellStart, scrollDwellEnd]);

  useEffect(() => {
    if (!metadataRefreshIntervalHydrated) {
      return;
    }
    void set(LYRIC_UPDATE_INTERVAL_KEY, metadataRefreshIntervalMs);
  }, [metadataRefreshIntervalHydrated, metadataRefreshIntervalMs]);

  useEffect(() => {
    if (!minSongMetadataSecondsHydrated) {
      return;
    }
    void set(LYRIC_MIN_SONG_METADATA_SECONDS_KEY, minSongMetadataSeconds);
  }, [minSongMetadataSecondsHydrated, minSongMetadataSeconds]);

  useEffect(() => {
    if (!currentTrackId) {
      latestPlaybackSnapshotRef.current = null;
      return;
    }

    latestPlaybackSnapshotRef.current = {
      trackId: currentTrackId,
      positionSeconds: Math.max(0, currentTime),
      wasPlaying: isPlaying,
    };
  }, [currentTrackId, currentTime, isPlaying]);

  useEffect(() => {
    const persistTimer = window.setInterval(() => {
      const snapshot = latestPlaybackSnapshotRef.current;
      if (!snapshot) {
        return;
      }
      void set(PLAYBACK_SNAPSHOT_KEY, snapshot);
    }, 1000);

    return () => {
      window.clearInterval(persistTimer);
    };
  }, []);

  const handleScrollDwellStartChange = useCallback((nextValue: number) => {
    const clamped = Math.min(0.9, Math.max(0, nextValue));
    setScrollDwellStart(clamped);
    setScrollDwellEnd((prev) => {
      const maxEnd = 1 - MIN_SCROLL_PORTION - clamped;
      return Math.min(prev, Math.max(0, maxEnd));
    });
  }, []);

  const handleScrollDwellEndChange = useCallback((nextValue: number) => {
    const clamped = Math.min(0.9, Math.max(0, nextValue));
    setScrollDwellEnd(clamped);
    setScrollDwellStart((prev) => {
      const maxStart = 1 - MIN_SCROLL_PORTION - clamped;
      return Math.min(prev, Math.max(0, maxStart));
    });
  }, []);

  useEffect(() => {
    if (!savedPlaybackSnapshotHydrated || !savedPlaybackSnapshot || tracks.length === 0) {
      return;
    }

    if (restoreInFlightRef.current) {
      return;
    }

    if (restoredSnapshotTrackIdRef.current === savedPlaybackSnapshot.trackId) {
      return;
    }

    const track = tracks.find((item) => item.id === savedPlaybackSnapshot.trackId);
    if (!track) {
      return;
    }

    restoreInFlightRef.current = true;
    void playTrack(track, {
      autoplay: savedPlaybackSnapshot.wasPlaying,
      startTimeSeconds: savedPlaybackSnapshot.positionSeconds,
    }).finally(() => {
      restoredSnapshotTrackIdRef.current = savedPlaybackSnapshot.trackId;
      restoreInFlightRef.current = false;
    });
  }, [savedPlaybackSnapshotHydrated, savedPlaybackSnapshot, tracks, playTrack]);

  useEffect(() => {
    void (async () => {
      const storedHandle = await get<FileSystemDirectoryHandle>(ROOT_HANDLE_KEY);
      if (!storedHandle) {
        return;
      }

      const permission = await storedHandle.queryPermission({ mode: "read" });
      if (permission === "granted") {
        await scanDirectory(storedHandle);
      }
    })();
  }, [scanDirectory]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) {
      return;
    }

    navigator.mediaSession.setActionHandler("play", () => {
      void audioRef.current.play();
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      audioRef.current.pause();
    });
    navigator.mediaSession.setActionHandler("previoustrack", playPrevious);
    navigator.mediaSession.setActionHandler("nexttrack", playNext);
    navigator.mediaSession.setActionHandler("seekbackward", () => {
      audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 10);
    });
    navigator.mediaSession.setActionHandler("seekforward", () => {
      const trackDuration = Number.isFinite(audioRef.current.duration) ? audioRef.current.duration : duration;
      audioRef.current.currentTime = Math.min(trackDuration, audioRef.current.currentTime + 10);
    });
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (typeof details.seekTime === "number") {
        audioRef.current.currentTime = details.seekTime;
      }
    });
  }, [playNext, playPrevious, duration]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) {
      return;
    }

    if (!currentMetadata) {
      if (metadataFlushTimerRef.current !== null) {
        window.clearTimeout(metadataFlushTimerRef.current);
        metadataFlushTimerRef.current = null;
      }
      pendingMetadataRef.current = null;
      if (lastSentMetadataSignatureRef.current !== null) {
        navigator.mediaSession.metadata = null;
        lastSentMetadataSignatureRef.current = null;
      }
      return;
    }

    const usesLyricsWindow = shouldUseLyricsWindow;

    const nextPayload: BluetoothMetadataPayload = {
      title: metadataFieldValueOrPlaceholder(
        usesLyricsWindow ? lyricWindow[fieldMapping.title] : currentMetadata.title
      ),
      artist: metadataFieldValueOrPlaceholder(
        usesLyricsWindow ? lyricWindow[fieldMapping.artist] : currentMetadata.artist
      ),
      album: metadataFieldValueOrPlaceholder(
        usesLyricsWindow ? lyricWindow[fieldMapping.album] : currentMetadata.album
      ),
      artworkUrl: currentMetadata.artworkUrl,
    };

    const payloadSignature = JSON.stringify(nextPayload);
    if (payloadSignature === lastSentMetadataSignatureRef.current && pendingMetadataRef.current === null) {
      return;
    }

    const publishPayload = (payload: BluetoothMetadataPayload) => {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: payload.title,
        artist: payload.artist,
        album: payload.album,
        artwork: payload.artworkUrl
          ? [
              {
                src: payload.artworkUrl,
                sizes: "512x512",
                type: "image/jpeg",
              },
            ]
          : [],
      });
      lastMetadataSentAtRef.current = Date.now();
      lastSentMetadataSignatureRef.current = JSON.stringify(payload);
    };

    const now = Date.now();
    const elapsedMs = now - lastMetadataSentAtRef.current;
    if (elapsedMs >= metadataRefreshIntervalMs) {
      if (metadataFlushTimerRef.current !== null) {
        window.clearTimeout(metadataFlushTimerRef.current);
        metadataFlushTimerRef.current = null;
      }
      pendingMetadataRef.current = null;
      publishPayload(nextPayload);
      return;
    }

    pendingMetadataRef.current = nextPayload;
    if (metadataFlushTimerRef.current !== null) {
      return;
    }

    const waitMs = Math.max(0, metadataRefreshIntervalMs - elapsedMs);
    metadataFlushTimerRef.current = window.setTimeout(() => {
      metadataFlushTimerRef.current = null;
      const pending = pendingMetadataRef.current;
      if (!pending) {
        return;
      }
      pendingMetadataRef.current = null;
      publishPayload(pending);
    }, waitMs);
  }, [currentMetadata, shouldUseLyricsWindow, lyricWindow, fieldMapping, metadataRefreshIntervalMs]);

  useEffect(() => {
    return () => {
      audioRef.current.pause();
      if (latestPlaybackSnapshotRef.current) {
        void set(PLAYBACK_SNAPSHOT_KEY, latestPlaybackSnapshotRef.current);
      }
      if (metadataFlushTimerRef.current !== null) {
        window.clearTimeout(metadataFlushTimerRef.current);
      }
      if (trackObjectUrlRef.current) {
        URL.revokeObjectURL(trackObjectUrlRef.current);
      }
      if (artworkUrlRef.current) {
        URL.revokeObjectURL(artworkUrlRef.current);
      }
    };
  }, []);

  const unsupported = !("showDirectoryPicker" in window);

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div>
          <h1>Bars Player</h1>
          <p>Android-first PWA music player with synced lyrics.</p>
        </div>
        <button type="button" onClick={handlePickDirectory} className="cta-button" disabled={isScanning || unsupported}>
          {isScanning ? "Scanning..." : "Choose Music Folder"}
        </button>
      </header>

      {unsupported && <div className="warning">Your browser does not support the File System Access API.</div>}
      {scanError && <div className="warning">{scanError}</div>}

      <main className="layout">
        <section className="panel">
          <h2>Library</h2>
          {tree ? (
            <TreeNode
              node={tree}
              currentTrackId={currentTrackId}
              onPlay={(track) => void playTrack(track)}
              openDirectories={openDirectories}
              onDirectoryOpenChange={handleDirectoryOpenChange}
              isRoot
            />
          ) : (
            <p className="empty">Select a folder to begin.</p>
          )}
        </section>

        <section className="panel">
          <h2>Now Playing</h2>
          {currentMetadata ? (
            <>
              <div className="meta">
                <strong>{currentMetadata.title}</strong>
                <span>{currentMetadata.artist}</span>
                <span>{currentMetadata.album}</span>
              </div>
              <div className="controls">
                <button onClick={playPrevious} type="button">
                  Prev
                </button>
                <button
                  onClick={() => {
                    if (isPlaying) {
                      audioRef.current.pause();
                    } else {
                      void audioRef.current.play();
                    }
                  }}
                  type="button"
                >
                  {isPlaying ? "Pause" : "Play"}
                </button>
                <button onClick={playNext} type="button">
                  Next
                </button>
              </div>
              <div className="timeline">
                <span>{formatDuration(currentTime)}</span>
                <input
                  type="range"
                  min={0}
                  max={duration || 0}
                  value={Math.min(currentTime, duration || 0)}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    audioRef.current.currentTime = value;
                    setCurrentTime(value);
                  }}
                />
                <span>{formatDuration(duration)}</span>
              </div>
            </>
          ) : (
            <p className="empty">Pick a song from the library.</p>
          )}

          <h2>Lyrics</h2>
          <div className="lyrics-box">
            {lyrics.length === 0 ? (
              <p className="empty">No synced lyrics found for this track.</p>
            ) : (
              lyrics.map((line, index) => (
                <p key={`${line.timeMs}-${index}`} className={index === activeLyric ? "lyric-active" : "lyric-line"}>
                  {line.text}
                </p>
              ))
            )}
          </div>

          <h2>Bluetooth Metadata Mapping</h2>
          <div className="mapping-grid">
            {(["title", "artist", "album"] as MetadataField[]).map((field) => (
              <label key={field} className="mapping-row">
                <span>{FIELD_LABELS[field]} field</span>
                <select
                  value={fieldMapping[field]}
                  onChange={(event) => {
                    const value = event.target.value as LyricLineRole;
                    setFieldMapping((prev) => ({
                      ...prev,
                      [field]: value,
                    }));
                  }}
                >
                  {(["previous", "current", "next"] as LyricLineRole[]).map((role) => (
                    <option key={role} value={role}>
                      {LINE_ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <h2>Bluetooth Line Width</h2>
          <div className="mapping-grid">
            <label className="mapping-row">
              <span>Visible width scale ({lyricWidthScale.toFixed(2)}x)</span>
              <input
                type="range"
                min={0.7}
                max={1.1}
                step={0.01}
                value={lyricWidthScale}
                onChange={(event) => {
                  setLyricWidthScale(Number(event.target.value));
                }}
              />
            </label>
            <p className="hint">Lower this if your car still truncates lines. Raise it to show more characters per update.</p>
            <div className="metadata-preview">
              <p>title: {shouldUseLyricsWindow ? lyricWindow[fieldMapping.title] : currentMetadata?.title ?? ""}</p>
              <p>artist: {shouldUseLyricsWindow ? lyricWindow[fieldMapping.artist] : currentMetadata?.artist ?? ""}</p>
              <p>album: {shouldUseLyricsWindow ? lyricWindow[fieldMapping.album] : currentMetadata?.album ?? ""}</p>
            </div>
          </div>

          <h2>Song Metadata Hold</h2>
          <div className="mapping-grid">
            <label className="mapping-row">
              <span>Show song metadata for at least {minSongMetadataSeconds.toFixed(1)}s</span>
              <input
                type="range"
                min={MIN_SONG_METADATA_SECONDS}
                max={MAX_SONG_METADATA_SECONDS}
                step={0.1}
                value={minSongMetadataSeconds}
                onChange={(event) => {
                  setMinSongMetadataSeconds(Number(event.target.value));
                }}
              />
            </label>
            <p className="hint">Lyric metadata starts only after both conditions: first lyric timestamp reached and this minimum time elapsed.</p>
          </div>

          <h2>Bluetooth Scroll Timing</h2>
          <div className="mapping-grid">
            <label className="mapping-row">
              <span>Start dwell ({Math.round(scrollDwellStart * 100)}%)</span>
              <input
                type="range"
                min={0}
                max={0.45}
                step={0.01}
                value={scrollDwellStart}
                onChange={(event) => {
                  handleScrollDwellStartChange(Number(event.target.value));
                }}
              />
            </label>
            <label className="mapping-row">
              <span>End dwell ({Math.round(scrollDwellEnd * 100)}%)</span>
              <input
                type="range"
                min={0}
                max={0.45}
                step={0.01}
                value={scrollDwellEnd}
                onChange={(event) => {
                  handleScrollDwellEndChange(Number(event.target.value));
                }}
              />
            </label>
            <p className="hint">Scroll portion: {Math.round(scrollPortion * 100)}% of line duration.</p>
          </div>

          <h2>Metadata Update Interval</h2>
          <div className="mapping-grid">
            <label className="mapping-row">
              <span>Minimum gap between sends: {metadataRefreshIntervalMs}ms</span>
              <input
                type="range"
                min={MIN_METADATA_REFRESH_INTERVAL_MS}
                max={MAX_METADATA_REFRESH_INTERVAL_MS}
                step={10}
                value={metadataRefreshIntervalMs}
                onChange={(event) => {
                  setMetadataRefreshIntervalMs(Number(event.target.value));
                }}
              />
            </label>
            <p className="hint">Updates send only when text changes, throttled so sends are at least this far apart.</p>
          </div>
        </section>
      </main>
    </div>
  );
}
