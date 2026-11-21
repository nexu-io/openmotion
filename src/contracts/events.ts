export type ProjectEvent =
  | {
      type: 'file-change' | 'files-changed';
      workspaceId: string;
      projectId: string;
      revision: string;
      versionId?: string;
      paths: string[];
      writeToken?: string;
      affectsPreview?: boolean;
      affectedCompositions?: string[];
      ts: number;
    }
  | {
      type: 'history-changed';
      workspaceId: string;
      projectId: string;
      revision: string;
      versionId?: string;
      historySeq: number;
      ts: number;
    }
  | {
      type: 'render-updated';
      workspaceId: string;
      projectId: string;
      jobId: string;
      state: string;
      progress: number;
      stage?: string;
      ts: number;
    }
  | {
      type: 'media-derived-ready';
      workspaceId: string;
      projectId: string;
      sha256: string;
      kind: 'thumbnail' | 'sprite' | 'waveform' | 'proxy' | 'metadata';
      status: 'ready' | 'failed';
      path?: string;
      ts: number;
    }
  | {
      type: 'media-ingest-status';
      workspaceId: string;
      projectId: string;
      ticketId?: string;
      jobId?: string;
      filename: string;
      targetPath?: string;
      bytes?: number;
      source: 'mcp_upload' | 'mcp_url' | 'web_upload';
      state: 'waiting_upload' | 'processing' | 'completed' | 'failed';
      stage?: string;
      progress?: number;
      error?: string;
      expiresAt?: string;
      ts: number;
    };

export interface JobProgressEvent {
  jobId: string;
  workspaceId: string;
  projectId?: string | null;
  kind: string;
  state: 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  stage?: string;
  progress: number;
  errorCode?: string;
  errorMessage?: string;
  resultJson?: Record<string, unknown>;
  ts: number;
}

export interface JobCancelEvent {
  jobId: string;
  workspaceId: string;
  requestedAt: number;
}

export interface SelectionEvent {
  workspaceId: string;
  projectId: string;
  compositionId?: string;
  elementIds: string[];
  senderId?: string;
  ts: number;
}

export interface McpSessionEvent {
  workspaceId: string;
  sessionId: string;
  event: string;
  data: unknown;
  ts: number;
}

export interface RenderWorkerHealth {
  workerId: string;
  ffmpeg: boolean;
  ffprobe: boolean;
  chromium: boolean;
  concurrency: number;
  activeJobs: number;
  updatedAt: number;
}
