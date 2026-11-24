import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { DelayedError, Worker, type Job } from 'bullmq';
import {
  QUEUE_NAMES,
  type BlobGcJobName,
  type MediaGenerateJobName,
  type MediaIngestJobName,
  type RenderExportJobName,
} from '../contracts/jobs.ts';
import type { StoragePort } from '../contracts/storage.ts';
import { createDbHandle, type Database } from '../db/client.ts';
import type { AppConfig } from '../infra/config.ts';
import { createLogger, type Logger } from '../infra/logger.ts';
import {
  QueueService,
  hasWaitingUserRenderWork,
  validateBlobGcPayload,
  validateMediaGeneratePayload,
  validateMediaIngestPayload,
  validateRenderExportPayload,
} from '../infra/queues.ts';
import { RedisEventBus, createRedisClient } from '../infra/redis.ts';
import { ShutdownCoordinator } from '../infra/shutdown.ts';
import { StorageService } from '../infra/storage.ts';
import { RedisCatalogFilmstripBakeState } from '../services/catalog-filmstrip-autobake.ts';
import { processBlobGcJob } from './blob-gc.ts';
import {
  processMediaGenerateJob,
  type GatewayCallContext,
  type GatewaySubmitInput,
  type GatewayTaskOutput,
  type GatewayTaskPollResult,
  type PlatformModelGateway,
} from './media-generate.ts';
import { processMediaIngestJob } from './media-ingest.ts';
import {
  processRenderExportQueueJob,
  startRenderHealthHeartbeat,
  sweepStaleRenderTempDirs,
  type RenderHealthHeartbeatHandle,
} from './render-export.ts';

export interface WorkerRuntimeHandle {
  readonly role: 'media' | 'render';
  readonly workerId: string;
  readonly workers: readonly Worker[];
  readonly shutdown: ShutdownCoordinator;
  close(reason?: string): Promise<boolean>;
}

export interface StartWorkerRuntimeOptions {
  readonly config: AppConfig;
  readonly logger?: Logger;
  readonly workerId?: string;
  readonly modelGateway?: PlatformModelGateway;
  readonly shutdownCoordinator?: ShutdownCoordinator;
  readonly installSignals?: boolean;
  readonly onShutdownComplete?: (clean: boolean) => void;
}

const MINIMAL_MOCK_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63f8cfc000000301010018dd8db00000000049454e44ae426082',
  'hex',
);

/**
 * Built-in fallback `PlatformModelGateway` used only when `startWorkerRuntime` is launched
 * without an externally injected gateway (e.g. standalone `MODEL_GATEWAY_MODE=mock` boot).
 * Wave 2C injects the full `OpenDesignModelGateway` / `MockModelGateway` from `auth-mcp-gateway`.
 */
function createFallbackWorkerModelGateway(config: AppConfig): PlatformModelGateway {
  if (config.MODEL_GATEWAY_MODE === 'mock') {
    return {
      providerId: 'opendesign',
      async listMediaModels() {
        return [];
      },
      async uploadReference(_ctx: GatewayCallContext, _input) {
        return { remoteAssetId: `mock_ref_${randomUUID().slice(0, 8)}` };
      },
      async submitTask(_ctx: GatewayCallContext, input: GatewaySubmitInput) {
        return { remoteTaskId: `mock_task_${input.jobId.slice(0, 8)}` };
      },
      async pollTask(_ctx: GatewayCallContext, input): Promise<GatewayTaskPollResult> {
        return {
          remoteTaskId: input.remoteTaskId,
          status: 'succeeded',
          outputs: [
            {
              inlineBytes: MINIMAL_MOCK_PNG,
              mimeType: 'image/png',
              sizeBytes: MINIMAL_MOCK_PNG.byteLength,
            },
          ],
        };
      },
      async downloadOutput(_ctx: GatewayCallContext, output: GatewayTaskOutput) {
        const bytes = output.inlineBytes ?? MINIMAL_MOCK_PNG;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes));
            controller.close();
          },
        });
      },
    };
  }

  // Fail loudly if opendesign live mode runs without Wave 2C injecting OpenDesignModelGateway.
  return {
    providerId: 'opendesign',
    async listMediaModels() {
      throw new Error('MODEL_GATEWAY_UNWIRED: Inject OpenDesignModelGateway into startWorkerRuntime()');
    },
    async uploadReference() {
      throw new Error('MODEL_GATEWAY_UNWIRED: Inject OpenDesignModelGateway into startWorkerRuntime()');
    },
    async submitTask() {
      throw new Error('MODEL_GATEWAY_UNWIRED: Inject OpenDesignModelGateway into startWorkerRuntime()');
    },
    async pollTask() {
      throw new Error('MODEL_GATEWAY_UNWIRED: Inject OpenDesignModelGateway into startWorkerRuntime()');
    },
    async downloadOutput() {
      throw new Error('MODEL_GATEWAY_UNWIRED: Inject OpenDesignModelGateway into startWorkerRuntime()');
    },
  };
}

export function buildWorkerId(role: 'media' | 'render'): string {
  const host = os.hostname().replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 48) || 'worker';
  return `${role}-${host}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

export interface MediaWorkerDeps {
  readonly config: AppConfig;
  readonly db: Database;
  readonly storage: StoragePort;
  readonly eventBus: RedisEventBus;
  readonly queues: QueueService;
  readonly logger: Logger;
  readonly workerId: string;
  readonly modelGateway: PlatformModelGateway;
  readonly shutdown: ShutdownCoordinator;
}

/**
 * Start BullMQ consumers for `WORKER_ROLE=media`:
 * - `media-ingest` (`concurrency = config.MEDIA_CONCURRENCY`)
 * - `media-generate` (`concurrency = config.MEDIA_CONCURRENCY`, `attempts: 1`)
 * - `blob-gc` (`concurrency = 1`, repeatable schedulers)
 */
export async function startMediaWorker(deps: MediaWorkerDeps): Promise<Worker[]> {
  const { config, db, storage, eventBus, queues, logger, workerId, modelGateway, shutdown } = deps;
  const concurrency = config.MEDIA_CONCURRENCY;

  const ingestConn = createRedisClient(config.REDIS_URL, 'bullmq');
  const generateConn = createRedisClient(config.REDIS_URL, 'bullmq');
  const gcConn = createRedisClient(config.REDIS_URL, 'bullmq');

  const mediaIngestWorker = new Worker(
    QUEUE_NAMES.mediaIngest,
    async (job: Job) => {
      const name = job.name as MediaIngestJobName;
      const validated = validateMediaIngestPayload(name, job.data);
      return processMediaIngestJob(
        {
          db,
          storage,
          eventBus,
          queues,
          logger: logger.child({ queue: QUEUE_NAMES.mediaIngest, bullJobId: job.id, jobName: name }),
          workerId,
          allowDohFakeIpFallback: config.ALLOW_DOH_FAKEIP_FALLBACK,
        },
        name,
        validated,
      );
    },
    {
      connection: ingestConn,
      concurrency,
      lockDuration: 120_000,
    },
  );

  const mediaGenerateWorker = new Worker(
    QUEUE_NAMES.mediaGenerate,
    async (job: Job) => {
      const name = job.name as MediaGenerateJobName;
      const validated = validateMediaGeneratePayload(name, job.data);
      return processMediaGenerateJob(
        {
          db,
          storage,
          eventBus,
          logger: logger.child({ queue: QUEUE_NAMES.mediaGenerate, bullJobId: job.id, jobName: name }),
          workerId,
          gateway: modelGateway,
        },
        name,
        validated,
      );
    },
    {
      connection: generateConn,
      concurrency,
      lockDuration: 120_000,
    },
  );

  const blobGcWorker = new Worker(
    QUEUE_NAMES.blobGc,
    async (job: Job) => {
      const name = job.name as BlobGcJobName;
      const validated = validateBlobGcPayload(name, job.data);
      return processBlobGcJob(
        {
          db,
          storage,
          logger: logger.child({ queue: QUEUE_NAMES.blobGc, bullJobId: job.id, jobName: name }),
        },
        name,
        validated,
      );
    },
    {
      connection: gcConn,
      concurrency: 1,
      lockDuration: 120_000,
    },
  );

  const allWorkers = [mediaIngestWorker, mediaGenerateWorker, blobGcWorker];
  for (const worker of allWorkers) {
    worker.on('failed', (job, error) => {
      logger.error('Media worker job failed', {
        queue: worker.name,
        bullJobId: job?.id,
        jobName: job?.name,
        error,
      });
    });
    worker.on('error', (error) => {
      logger.error('Media worker runtime error', { queue: worker.name, error });
    });
  }

  await queues.scheduleBlobGcRepeatable(config.BLOB_GC_GRACE_SECONDS);

  // Register LIFO drain hooks: close BullMQ workers cleanly before quitting Redis connections.
  shutdown.register('bullmq-media-connections', async () => {
    await Promise.allSettled([ingestConn.quit(), generateConn.quit(), gcConn.quit()]);
  });
  shutdown.register('bullmq-media-workers', async () => {
    await Promise.allSettled(allWorkers.map((worker) => worker.close()));
  });

  logger.info('worker-media started', {
    workerId,
    concurrency,
    queues: [QUEUE_NAMES.mediaIngest, QUEUE_NAMES.mediaGenerate, QUEUE_NAMES.blobGc],
    blobGcGraceSeconds: config.BLOB_GC_GRACE_SECONDS,
  });

  return allWorkers;
}

export interface RenderWorkerDeps {
  readonly config: AppConfig;
  readonly db: Database;
  readonly storage: StoragePort;
  readonly eventBus: RedisEventBus;
  readonly queues?: Pick<QueueService, 'renderExport'>;
  readonly logger: Logger;
  readonly workerId: string;
  readonly shutdown: ShutdownCoordinator;
}

const CATALOG_BAKE_YIELD_DELAY_MS = 2_000;

function isYieldedCatalogBakeResult(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'status' in value &&
      (value as { status?: unknown }).status === 'yielded',
  );
}

/**
 * Start BullMQ consumer for `WORKER_ROLE=render`:
 * - Sweeps stale `/tmp/om-render-*`, `/tmp/om-thumb-*`, and `/tmp/om-filmstrip-*` directories left by prior crashes.
 * - Starts periodic Redis heartbeat on `om:workers:render:health`.
 * - Consumes `render-export` (`concurrency = config.RENDER_CONCURRENCY`, default 1, `attempts: 1`).
 * - Registers LIFO drain on `ShutdownCoordinator` so in-flight renders finish cleanly on `SIGTERM`.
 */
export async function startRenderWorker(deps: RenderWorkerDeps): Promise<{
  workers: Worker[];
  heartbeat: RenderHealthHeartbeatHandle;
}> {
  const { config, db, storage, eventBus, queues, logger, workerId, shutdown } = deps;
  const concurrency = config.RENDER_CONCURRENCY;

  const swept = await sweepStaleRenderTempDirs(os.tmpdir(), logger);
  if (swept > 0) {
    logger.info('Swept stale ephemeral render temp directories', { count: swept });
  }

  const heartbeat = startRenderHealthHeartbeat({
    eventBus,
    logger,
    workerId,
    concurrency,
  });

  const renderConn = createRedisClient(config.REDIS_URL, 'bullmq');
  const bakeStateConn = createRedisClient(config.REDIS_URL, 'command');
  const bakeState = new RedisCatalogFilmstripBakeState(bakeStateConn);
  const shouldYieldCatalogBake = queues
    ? () => hasWaitingUserRenderWork(queues.renderExport)
    : undefined;
  let activeJobs = 0;

  const renderWorker = new Worker(
    QUEUE_NAMES.renderExport,
    async (job: Job, token?: string) => {
      const name = job.name as RenderExportJobName;
      const validated = validateRenderExportPayload(name, job.data);
      activeJobs += 1;
      heartbeat.setActiveJobs(activeJobs);
      void heartbeat.pulse().catch(() => {});
      try {
        const result = await processRenderExportQueueJob(
          {
            db,
            storage,
            eventBus,
            logger: logger.child({ queue: QUEUE_NAMES.renderExport, bullJobId: job.id, jobName: name }),
            workerId,
            concurrency,
            bakeState,
            shouldYieldCatalogBake,
          },
          name,
          validated,
        );
        if (name === 'bake_catalog_filmstrips' && isYieldedCatalogBakeResult(result) && token) {
          await job.moveToDelayed(Date.now() + CATALOG_BAKE_YIELD_DELAY_MS, token);
          throw new DelayedError();
        }
        return result;
      } finally {
        activeJobs = Math.max(0, activeJobs - 1);
        heartbeat.setActiveJobs(activeJobs);
        void heartbeat.pulse().catch(() => {});
      }
    },
    {
      connection: renderConn,
      concurrency,
      lockDuration: 120_000,
      stalledInterval: 30_000,
      maxStalledCount: 1,
    },
  );

  renderWorker.on('failed', (job, error) => {
    logger.error('Render worker job failed', {
      queue: QUEUE_NAMES.renderExport,
      bullJobId: job?.id,
      jobName: job?.name,
      error,
    });
  });
  renderWorker.on('error', (error) => {
    logger.error('Render worker runtime error', { queue: QUEUE_NAMES.renderExport, error });
  });

  // Register LIFO drain hooks:
  // 1) Stop heartbeat -> 2) Drain active render cleanly via renderWorker.close() -> 3) Quit Redis.
  shutdown.register('bullmq-render-connection', async () => {
    await Promise.allSettled([renderConn.quit(), bakeStateConn.quit()]);
  });
  shutdown.register('bullmq-render-worker', async () => {
    await renderWorker.close();
  });
  shutdown.register('render-health-heartbeat', () => {
    heartbeat.stop();
  });

  logger.info('worker-render started', {
    workerId,
    concurrency,
    queue: QUEUE_NAMES.renderExport,
  });

  return { workers: [renderWorker], heartbeat };
}

/**
 * Unified cloud worker runtime switched by `config.WORKER_ROLE` (`media` | `render`).
 * Connects DB, Storage, RedisEventBus, QueueService, installs graceful SIGTERM drain via
 * `ShutdownCoordinator`, and launches role-specific BullMQ workers.
 */
export async function startWorkerRuntime(options: StartWorkerRuntimeOptions): Promise<WorkerRuntimeHandle> {
  const { config } = options;
  if (config.WORKER_ROLE !== 'media' && config.WORKER_ROLE !== 'render') {
    throw new Error(
      `INVALID_WORKER_ROLE: src/entrypoints/worker.ts requires WORKER_ROLE=media or WORKER_ROLE=render (received "${config.WORKER_ROLE}")`,
    );
  }
  const role: 'media' | 'render' = config.WORKER_ROLE;
  const workerId = options.workerId ?? buildWorkerId(role);
  const logger =
    options.logger ??
    createLogger({
      level: config.LOG_LEVEL,
      bindings: { service: `worker-${role}`, role, workerId },
    });

  // Give render workers enough drain grace to finish an in-flight export (aligned with K8s 1800s grace).
  const shutdownTimeoutMs = role === 'render' ? 1_700_000 : 90_000;
  const shutdown =
    options.shutdownCoordinator ??
    new ShutdownCoordinator({
      logger,
      timeoutMs: shutdownTimeoutMs,
    });

  const dbHandle = createDbHandle({
    connectionString: config.DATABASE_URL,
    max: Math.min(config.PG_POOL_MAX, role === 'render' ? 5 : 15),
  });
  const presignCacheWindowSec = (config as { S3_PRESIGN_CACHE_WINDOW_SEC?: number })
    .S3_PRESIGN_CACHE_WINDOW_SEC;
  const storage = new StorageService({
    textRevisionDb: dbHandle.db,
    bucket: config.S3_BUCKET,
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    publicEndpoint: config.S3_PUBLIC_ENDPOINT,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    defaultPresignPutTtlSec: config.S3_PRESIGN_PUT_TTL_SEC,
    defaultPresignGetTtlSec: config.S3_PRESIGN_GET_TTL_SEC,
    ...(typeof presignCacheWindowSec === 'number'
      ? { defaultPresignCacheWindowSec: presignCacheWindowSec }
      : {}),
    publicOrigin: config.APP_PUBLIC_ORIGIN,
  });
  const eventBus = new RedisEventBus(config.REDIS_URL);
  const queues = new QueueService(config.REDIS_URL);

  // Register base infrastructure close hooks first (so LIFO shuts workers down BEFORE closing DB/S3/Redis!).
  shutdown.register('db-pool', async () => {
    await dbHandle.close();
  });
  shutdown.register('storage-s3', () => {
    storage.close();
  });
  shutdown.register('redis-event-bus', async () => {
    await eventBus.close();
  });
  shutdown.register('bullmq-queues', async () => {
    await queues.close();
  });

  if (options.installSignals !== false) {
    shutdown.installSignalHandlers(options.onShutdownComplete);
  }

  let workers: Worker[] = [];
  try {
    if (role === 'media') {
      const gateway = options.modelGateway ?? createFallbackWorkerModelGateway(config);
      workers = await startMediaWorker({
        config,
        db: dbHandle.db,
        storage,
        eventBus,
        queues,
        logger,
        workerId,
        modelGateway: gateway,
        shutdown,
      });
    } else {
      const started = await startRenderWorker({
        config,
        db: dbHandle.db,
        storage,
        eventBus,
        queues,
        logger,
        workerId,
        shutdown,
      });
      workers = started.workers;
    }
  } catch (error) {
    logger.error('Failed to boot worker runtime; cleaning up resources', { role, error });
    await shutdown.shutdown('startup_error');
    throw error;
  }

  return {
    role,
    workerId,
    workers,
    shutdown,
    close: (reason = 'manual_close') => shutdown.shutdown(reason),
  };
}
