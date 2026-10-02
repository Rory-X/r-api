import 'dotenv/config';

let telemetrySdk: { shutdown(): Promise<void> } | null = null;

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value || '').trim().toLowerCase());
}

function shouldEnableTelemetry(env: NodeJS.ProcessEnv): boolean {
  if (isTruthy(env.OTEL_SDK_DISABLED)) return false;
  const exporter = (env.OTEL_TRACES_EXPORTER || '').trim().toLowerCase();
  if (exporter === 'none') return false;
  return !!(
    env.OTEL_EXPORTER_OTLP_ENDPOINT
    || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    || exporter.split(',').map((value) => value.trim()).includes('otlp')
  );
}

export async function initializeOpenTelemetry(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (telemetrySdk || !shouldEnableTelemetry(env)) return telemetrySdk !== null;
  const [
    sdkModule,
    exporterModule,
    httpInstrumentationModule,
    undiciInstrumentationModule,
    pgInstrumentationModule,
    mysql2InstrumentationModule,
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-undici'),
    import('@opentelemetry/instrumentation-pg'),
    import('@opentelemetry/instrumentation-mysql2'),
  ]);
  const sdk = new sdkModule.NodeSDK({
    serviceName: (env.OTEL_SERVICE_NAME || 'r-api').trim() || 'r-api',
    traceExporter: new exporterModule.OTLPTraceExporter(),
    instrumentations: [
      new httpInstrumentationModule.HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => {
          const url = request.url?.split('?')[0] || '';
          return url === '/livez'
            || url === '/readyz'
            || url === '/metrics'
            || url.startsWith('/health/');
        },
      }),
      new undiciInstrumentationModule.UndiciInstrumentation(),
      new pgInstrumentationModule.PgInstrumentation(),
      new mysql2InstrumentationModule.MySQL2Instrumentation(),
    ],
  });
  sdk.start();
  telemetrySdk = sdk;
  console.info('[observability] OpenTelemetry tracing enabled');
  return true;
}

export async function shutdownOpenTelemetry(): Promise<void> {
  const sdk = telemetrySdk;
  telemetrySdk = null;
  if (!sdk) return;
  await sdk.shutdown();
}
