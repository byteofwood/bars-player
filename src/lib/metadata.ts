import { parseBlob } from "music-metadata-browser";

export interface TrackMetadata {
  title: string;
  artist: string;
  album: string;
  artworkUrl?: string;
}

function fileNameWithoutExtension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  return lastDot > 0 ? name.slice(0, lastDot) : name;
}

function titleFromFileName(name: string): string {
  const raw = fileNameWithoutExtension(name);
  return raw.replace(/^\d+\s*[-_.]?\s*/, "").trim() || raw;
}

function fallbackFromPath(path?: string): Pick<TrackMetadata, "artist" | "album"> {
  if (!path) {
    return { artist: "Unknown artist", album: "Unknown album" };
  }

  const parts = path.split("/").filter(Boolean);
  const directories = parts.slice(0, -1);

  if (directories.length >= 2) {
    return {
      artist: directories[directories.length - 2],
      album: directories[directories.length - 1],
    };
  }

  if (directories.length === 1) {
    return {
      artist: directories[0],
      album: "Unknown album",
    };
  }

  return { artist: "Unknown artist", album: "Unknown album" };
}

export async function parseTrackMetadata(file: File, path?: string): Promise<TrackMetadata> {
  const pathFallback = fallbackFromPath(path);
  const fallback = {
    title: titleFromFileName(file.name),
    artist: pathFallback.artist,
    album: pathFallback.album,
  };

  try {
    const metadata = await parseBlob(file);
    const common = metadata.common;

    let artworkUrl: string | undefined;
    const picture = common.picture?.[0];
    if (picture) {
      const blob = new Blob([picture.data], { type: picture.format });
      artworkUrl = URL.createObjectURL(blob);
    }

    return {
      title: common.title || fallback.title,
      artist: common.artist || common.artists?.[0] || fallback.artist,
      album: common.album || fallback.album,
      artworkUrl,
    };
  } catch {
    return fallback;
  }
}
