import { get, set } from "idb-keyval";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { DirectoryNode, TrackNode, scanMusicTree } from "./lib/fs";
import { activeLyricIndex, LyricLine, parseLrc } from "./lib/lrc";
import { TrackMetadata, parseTrackMetadata } from "./lib/metadata";

const ROOT_HANDLE_KEY = "music-root-handle";
const TREE_OPEN_STATE_KEY = "library-open-directories";
const LYRIC_FIELD_MAPPING_KEY = "bluetooth-lyric-field-mapping";

type MetadataField = "title" | "artist" | "album";
type LyricLineRole = "previous" | "current" | "next";

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

  const audioRef = useRef(new Audio());
  const trackObjectUrlRef = useRef<string | null>(null);
  const artworkUrlRef = useRef<string | null>(null);

  const currentTrackIndex = useMemo(
    () => tracks.findIndex((track) => track.id === currentTrackId),
    [tracks, currentTrackId]
  );

  const activeLyric = useMemo(() => activeLyricIndex(lyrics, currentTime * 1000), [lyrics, currentTime]);

  const lyricWindow = useMemo(() => {
    const previous = activeLyric > 0 ? lyrics[activeLyric - 1].text : "";
    const current = activeLyric >= 0 ? lyrics[activeLyric].text : "";
    const next = activeLyric >= 0 && activeLyric < lyrics.length - 1 ? lyrics[activeLyric + 1].text : "";
    return { previous, current, next };
  }, [lyrics, activeLyric]);

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
    async (track: TrackNode) => {
      const audio = audioRef.current;
      const file = await track.fileHandle.getFile();

      if (trackObjectUrlRef.current) {
        URL.revokeObjectURL(trackObjectUrlRef.current);
      }
      const audioUrl = URL.createObjectURL(file);
      trackObjectUrlRef.current = audioUrl;

      setCurrentTrackId(track.id);
      setCurrentTime(0);
      setDuration(0);

      audio.src = audioUrl;
      await audio.play();

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

  useEffect(() => {
    const audio = audioRef.current;
    const handleTimeUpdate = () => setCurrentTime(audio.currentTime || 0);
    const handleLoadedMetadata = () => setDuration(audio.duration || 0);
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => playNext();

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
    };
  }, [playNext]);

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

    if (!currentMetadata) {
      navigator.mediaSession.metadata = null;
      return;
    }

    const usesLyricsWindow = lyrics.length > 0;

    const resolvedTitle = usesLyricsWindow ? lyricWindow[fieldMapping.title] : currentMetadata.title;
    const resolvedArtist = usesLyricsWindow ? lyricWindow[fieldMapping.artist] : currentMetadata.artist;
    const resolvedAlbum = usesLyricsWindow ? lyricWindow[fieldMapping.album] : currentMetadata.album;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: resolvedTitle,
      artist: resolvedArtist,
      album: resolvedAlbum,
      artwork: currentMetadata.artworkUrl
        ? [
            {
              src: currentMetadata.artworkUrl,
              sizes: "512x512",
              type: "image/jpeg",
            },
          ]
        : [],
    });

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
      audioRef.current.currentTime = Math.min(duration, audioRef.current.currentTime + 10);
    });
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (typeof details.seekTime === "number") {
        audioRef.current.currentTime = details.seekTime;
      }
    });
  }, [currentMetadata, playNext, playPrevious, duration, lyrics.length, lyricWindow, fieldMapping]);

  useEffect(() => {
    return () => {
      audioRef.current.pause();
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
        </section>
      </main>
    </div>
  );
}
