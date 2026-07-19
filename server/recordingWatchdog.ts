import { readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { RecordingTerminationCode, RelaySession, SessionStore } from "./db.js";

export type MediaPathSnapshot = {
  name: string;
  tracks: string[];
  bytesReceived: number;
  sourceType: string | null;
  sourceId: string | null;
};

export interface MediaMtxControl {
  listPaths(): Promise<MediaPathSnapshot[]>;
  kickWebRtcSession(id: string): Promise<void>;
}

export type RecordingStorageState = "ok" | "warning" | "blocked" | "unavailable";

export type RecordingStorageStatus = {
  state: RecordingStorageState;
  initialized: boolean;
  usedBytes: number | null;
  maxBytes: number;
  freeBytes: number | null;
  sessionMaxBytes: number;
  lastSuccessfulScanAt: string | null;
};

type RecordingGuardStore = Pick<SessionStore, "list" | "findByPath" | "setState">;
type Logger = (event: Record<string, unknown>) => void;

export type RecordingWatchdogDependencies = {
  config: AppConfig;
  store: RecordingGuardStore;
  mediaMtx: MediaMtxControl;
  directorySize?: (path: string) => Promise<number>;
  freeBytes?: (path: string) => Promise<number>;
  now?: () => number;
  logger?: Logger;
};

type RateSample = { at: number; bytes: number };

function logJson(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}

export async function directorySize(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(async (entry) => {
    if (entry.isSymbolicLink()) return 0;
    const target = join(path, entry.name);
    if (entry.isDirectory()) {
      return directorySize(target);
    }
    return entry.isFile() ? (await stat(target)).size : 0;
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

async function directorySizeOrZero(path: string): Promise<number> {
  try {
    return await directorySize(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function filesystemFreeBytes(path: string): Promise<number> {
  const details = await statfs(path, { bigint: true });
  return Number(details.bavail * details.bsize);
}

function normalizedTracks(tracks: string[]): string[] {
  return tracks.map((track) => track.trim().toLowerCase()).filter(Boolean);
}

export class MediaMtxControlClient implements MediaMtxControl {
  constructor(private readonly apiUrl: string) {}

  async listPaths(): Promise<MediaPathSnapshot[]> {
    const response = await fetch(new URL("/v3/paths/list", this.apiUrl), {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error(`MediaMTX path scan failed (${response.status})`);
    const payload = await response.json() as { items?: unknown };
    if (!Array.isArray(payload.items)) throw new Error("MediaMTX path scan response was invalid");
    return payload.items.flatMap((raw): MediaPathSnapshot[] => {
      if (!raw || typeof raw !== "object") return [];
      const item = raw as Record<string, unknown>;
      if (typeof item.name !== "string") return [];
      const source = item.source && typeof item.source === "object" ? item.source as Record<string, unknown> : null;
      const tracks = Array.isArray(item.tracks) ? item.tracks.flatMap((track) => {
        if (typeof track === "string") return [track];
        if (track && typeof track === "object") {
          const codec = (track as Record<string, unknown>).codec;
          return typeof codec === "string" ? [codec] : [];
        }
        return [];
      }) : [];
      return [{
        name: item.name,
        tracks,
        bytesReceived: typeof item.bytesReceived === "number" && Number.isFinite(item.bytesReceived) ? item.bytesReceived : 0,
        sourceType: typeof source?.type === "string" ? source.type : null,
        sourceId: typeof source?.id === "string" ? source.id : null,
      }];
    });
  }

  async kickWebRtcSession(id: string): Promise<void> {
    const response = await fetch(new URL(`/v3/webrtcsessions/kick/${encodeURIComponent(id)}`, this.apiUrl), {
      method: "POST",
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error(`MediaMTX publisher kick failed (${response.status})`);
  }
}

export class RecordingWatchdog {
  private status: RecordingStorageStatus;
  private fastTimer: NodeJS.Timeout | null = null;
  private archiveTimer: NodeJS.Timeout | null = null;
  private fastScanRunning = false;
  private archiveScanRunning = false;
  private readonly samples = new Map<string, RateSample[]>();
  private readonly rateViolations = new Map<string, number>();
  private readonly sizeDirectory: (path: string) => Promise<number>;
  private readonly getFreeBytes: (path: string) => Promise<number>;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(private readonly dependencies: RecordingWatchdogDependencies) {
    this.sizeDirectory = dependencies.directorySize ?? directorySizeOrZero;
    this.getFreeBytes = dependencies.freeBytes ?? filesystemFreeBytes;
    this.now = dependencies.now ?? Date.now;
    this.logger = dependencies.logger ?? logJson;
    this.status = {
      state: "unavailable",
      initialized: false,
      usedBytes: null,
      maxBytes: dependencies.config.recordingArchiveMaxBytes,
      freeBytes: null,
      sessionMaxBytes: dependencies.config.recordingSessionMaxBytes,
      lastSuccessfulScanAt: null,
    };
  }

  getStatus(): RecordingStorageStatus {
    return { ...this.status };
  }

  canCreateRecording(): boolean {
    return this.status.initialized && this.status.state !== "blocked" && this.status.state !== "unavailable";
  }

  async initialize(): Promise<void> {
    await this.scanArchive();
  }

  start(): void {
    if (this.fastTimer || this.archiveTimer) return;
    this.fastTimer = setInterval(() => void this.scanActive(), this.dependencies.config.recordingActiveScanMs);
    this.archiveTimer = setInterval(() => void this.scanArchive(), this.dependencies.config.recordingArchiveScanMs);
    this.fastTimer.unref();
    this.archiveTimer.unref();
    void this.scanActive();
  }

  stop(): void {
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.archiveTimer) clearInterval(this.archiveTimer);
    this.fastTimer = null;
    this.archiveTimer = null;
  }

  async scanArchive(): Promise<void> {
    if (this.archiveScanRunning) return;
    this.archiveScanRunning = true;
    try {
      const [recordingBytes, playbackBytes, freeBytes] = await Promise.all([
        this.sizeDirectory(this.dependencies.config.recordingsPath),
        this.sizeDirectory(this.dependencies.config.recordingPlaybackPath),
        this.getFreeBytes(this.dependencies.config.recordingsPath),
      ]);
      const usedBytes = recordingBytes + playbackBytes;
      const blocked = usedBytes >= this.dependencies.config.recordingArchiveMaxBytes ||
        freeBytes <= this.dependencies.config.recordingHostFreeFloorBytes;
      const warning = usedBytes >= this.dependencies.config.recordingArchiveMaxBytes * this.dependencies.config.recordingArchiveWarningRatio ||
        freeBytes <= this.dependencies.config.recordingHostFreeWarningBytes;
      this.status = {
        ...this.status,
        state: blocked ? "blocked" : warning ? "warning" : "ok",
        initialized: true,
        usedBytes,
        freeBytes,
        lastSuccessfulScanAt: new Date(this.now()).toISOString(),
      };
      if (warning || blocked) {
        this.logger({
          level: blocked ? "error" : "warn",
          event: blocked ? "recording_storage_blocked" : "recording_storage_warning",
          usedBytes,
          freeBytes,
        });
      }
      if (blocked) await this.endActiveRecordings("recording_archive_limit");
    } catch (error) {
      this.status = { ...this.status, state: "unavailable" };
      this.logger({
        level: "error",
        event: "recording_watchdog_error",
        scan: "archive",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      this.archiveScanRunning = false;
    }
  }

  async scanActive(): Promise<void> {
    if (this.fastScanRunning) return;
    this.fastScanRunning = true;
    try {
      const active = this.activeRecordingSessions();
      await Promise.all(active.map(async (session) => {
          const bytes = await this.sizeDirectory(join(this.dependencies.config.recordingsPath, session.mediaPath));
          if (bytes >= this.dependencies.config.recordingSessionMaxBytes) {
            await this.terminate(session, "recording_session_limit", null);
          }
      }));
      const publishing = active.filter((session) => session.startedAt && session.state !== "ended" && session.state !== "expired");
      if (publishing.length === 0) {
        this.restoreMeasuredStorageState();
        return;
      }
      const paths = await this.dependencies.mediaMtx.listPaths();
      const activeByPath = new Map(publishing.map((session) => [session.mediaPath, session]));
      for (const path of paths) {
        const session = activeByPath.get(path.name);
        if (!session) continue;
        await this.enforceMediaPolicy(session, path);
      }
      this.restoreMeasuredStorageState();
    } catch (error) {
      this.status = { ...this.status, state: "unavailable" };
      this.logger({
        level: "error",
        event: "recording_watchdog_error",
        scan: "active",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      this.fastScanRunning = false;
    }
  }

  private activeRecordingSessions(): RelaySession[] {
    return this.dependencies.store.list().filter((session) => session.recordingRequested &&
      session.state !== "ended" && session.state !== "expired");
  }

  private restoreMeasuredStorageState(): void {
    if (!this.status.initialized || this.status.usedBytes === null || this.status.freeBytes === null) return;
    const blocked = this.status.usedBytes >= this.dependencies.config.recordingArchiveMaxBytes ||
      this.status.freeBytes <= this.dependencies.config.recordingHostFreeFloorBytes;
    const warning = this.status.usedBytes >= this.dependencies.config.recordingArchiveMaxBytes * this.dependencies.config.recordingArchiveWarningRatio ||
      this.status.freeBytes <= this.dependencies.config.recordingHostFreeWarningBytes;
    this.status = { ...this.status, state: blocked ? "blocked" : warning ? "warning" : "ok" };
  }

  private async endActiveRecordings(code: RecordingTerminationCode): Promise<void> {
    await Promise.all(this.activeRecordingSessions().map((session) => this.terminate(session, code, null)));
  }

  private async enforceMediaPolicy(session: RelaySession, path: MediaPathSnapshot): Promise<void> {
    const tracks = normalizedTracks(path.tracks);
    if (tracks.length > 0 && (tracks.length !== 1 || tracks[0] !== "opus")) {
      await this.terminate(session, "recording_media_policy", path);
      return;
    }

    const now = this.now();
    const samples = [...(this.samples.get(path.name) ?? []), { at: now, bytes: path.bytesReceived }]
      .filter((sample) => now - sample.at <= this.dependencies.config.recordingIngressWindowMs);
    this.samples.set(path.name, samples);
    const oldest = samples[0];
    const elapsedMs = oldest ? now - oldest.at : 0;
    if (!oldest || elapsedMs < this.dependencies.config.recordingIngressWindowMs * 0.9) return;
    const rate = Math.max(0, path.bytesReceived - oldest.bytes) / (elapsedMs / 1000);
    if (rate > this.dependencies.config.recordingIngressMaxBytesPerSecond) {
      const violations = (this.rateViolations.get(path.name) ?? 0) + 1;
      this.rateViolations.set(path.name, violations);
      if (violations >= this.dependencies.config.recordingIngressConsecutiveViolations) {
        await this.terminate(session, "recording_media_policy", path, rate);
      }
    } else {
      this.rateViolations.set(path.name, 0);
    }
  }

  private async terminate(
    session: RelaySession,
    code: RecordingTerminationCode,
    path: MediaPathSnapshot | null,
    measuredRate?: number,
  ): Promise<void> {
    const updated = this.dependencies.store.setState(session.id, "ended", null, code);
    if (!updated || updated.terminationCode !== code) return;
    this.samples.delete(session.mediaPath);
    this.rateViolations.delete(session.mediaPath);
    this.logger({
      level: "warn",
      event: "recording_policy_termination",
      sessionId: session.id,
      code,
      ...(measuredRate === undefined ? {} : { measuredBytesPerSecond: Math.round(measuredRate) }),
    });
    if (path?.sourceId && path.sourceType?.toLowerCase().includes("webrtc")) {
      try {
        await this.dependencies.mediaMtx.kickWebRtcSession(path.sourceId);
      } catch (error) {
        this.logger({
          level: "error",
          event: "recording_publisher_kick_failed",
          sessionId: session.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  }
}
