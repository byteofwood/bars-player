export interface TrackNode {
  id: string;
  name: string;
  path: string;
  extension: "mp3" | "flac";
  fileHandle: FileSystemFileHandle;
  lrcHandle?: FileSystemFileHandle;
}

export interface DirectoryNode {
  id: string;
  name: string;
  path: string;
  directories: DirectoryNode[];
  tracks: TrackNode[];
}

const AUDIO_EXTENSIONS = new Set(["mp3", "flac"]);

function pathJoin(base: string, segment: string): string {
  return base ? `${base}/${segment}` : segment;
}

function extensionOf(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex < 0) {
    return "";
  }
  return name.slice(dotIndex + 1).toLowerCase();
}

function baseName(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex < 0) {
    return name;
  }
  return name.slice(0, dotIndex);
}

interface ScanResult {
  root: DirectoryNode;
  flatTracks: TrackNode[];
}

export async function scanMusicTree(rootHandle: FileSystemDirectoryHandle): Promise<ScanResult> {
  const allTracks: TrackNode[] = [];

  async function walkDirectory(
    handle: FileSystemDirectoryHandle,
    name: string,
    parentPath: string
  ): Promise<DirectoryNode> {
    const currentPath = pathJoin(parentPath, name);
    const directoryEntries: Array<{ name: string; handle: FileSystemDirectoryHandle }> = [];
    const audioEntries: Array<{ name: string; handle: FileSystemFileHandle; extension: "mp3" | "flac" }> = [];
    const lrcByName = new Map<string, FileSystemFileHandle>();

    for await (const [entryName, entry] of handle.entries()) {
      if (entry.kind === "directory") {
        directoryEntries.push({ name: entryName, handle: entry as FileSystemDirectoryHandle });
        continue;
      }

      const ext = extensionOf(entryName);
      if (AUDIO_EXTENSIONS.has(ext)) {
        audioEntries.push({
          name: entryName,
          handle: entry as FileSystemFileHandle,
          extension: ext as "mp3" | "flac",
        });
      }

      if (ext === "lrc") {
        lrcByName.set(baseName(entryName), entry as FileSystemFileHandle);
      }
    }

    directoryEntries.sort((a, b) => a.name.localeCompare(b.name));
    audioEntries.sort((a, b) => a.name.localeCompare(b.name));

    const directories: DirectoryNode[] = [];
    for (const child of directoryEntries) {
      directories.push(await walkDirectory(child.handle, child.name, currentPath));
    }

    const tracks: TrackNode[] = audioEntries.map((entry) => {
      const track: TrackNode = {
        id: `${currentPath}/${entry.name}`,
        name: entry.name,
        path: `${currentPath}/${entry.name}`,
        extension: entry.extension,
        fileHandle: entry.handle,
        lrcHandle: lrcByName.get(baseName(entry.name)),
      };
      allTracks.push(track);
      return track;
    });

    return {
      id: currentPath,
      name,
      path: currentPath,
      directories,
      tracks,
    };
  }

  const root = await walkDirectory(rootHandle, rootHandle.name, "");
  return { root, flatTracks: allTracks };
}
