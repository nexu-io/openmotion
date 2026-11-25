import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getConfig } from '../infra/config.ts';
import { createLogger } from '../infra/logger.ts';
import { createPlatformModelGateway } from '../services/model-gateway.ts';
import { startWorkerRuntime, type WorkerRuntimeHandle } from '../workers/worker.ts';

export async function runWorkerEntrypoint(): Promise<WorkerRuntimeHandle> {
  const config = getConfig();
  const logger = createLogger({
    level: config.LOG_LEVEL,
    bindings: { service: `worker-${config.WORKER_ROLE}`, role: config.WORKER_ROLE },
  });
  logger.info('Booting OpenMotion cloud worker entrypoint', {
    role: config.WORKER_ROLE,
    nodeEnv: config.NODE_ENV,
    mediaConcurrency: config.MEDIA_CONCURRENCY,
    renderConcurrency: config.RENDER_CONCURRENCY,
    renderCaptureWorkers: config.RENDER_CAPTURE_WORKERS,
    modelGatewayMode: config.MODEL_GATEWAY_MODE,
  });
  const modelGateway =
    config.WORKER_ROLE === 'media' ? createPlatformModelGateway(config) : undefined;
  return startWorkerRuntime({
    config,
    logger,
    modelGateway,
    installSignals: true,
  });
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectEntry()) {
  runWorkerEntrypoint().catch((error) => {
    const logger = createLogger({ level: 'error', bindings: { service: 'worker-entrypoint' } });
    logger.error('Fatal worker startup failure', { error });
    process.exit(1);
  });
}
