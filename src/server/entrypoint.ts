import { initializeOpenTelemetry } from './observability/telemetry.js';

await initializeOpenTelemetry();
await import('./index.js');
