/**
 * OpenTelemetry SDK initialisation – must be required FIRST in index.js.
 *
 * Exports traces to Cloud Trace via OTLP/gRPC.
 * W3C traceparent propagation links ADK (Python) spans with Node.js spans
 * in a single Cloud Trace waterfall.
 *
 * Gracefully no-ops if @opentelemetry/sdk-node is not installed
 * (e.g. in unit test environments with stripped node_modules).
 */

'use strict';

const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'ship-date-drift';
const OTEL_ENABLED = process.env.OTEL_ENABLED !== 'false';

if (!OTEL_ENABLED) {
  module.exports = { initialized: false };
  // eslint-disable-next-line no-process-exit
} else {
  try {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
    const { W3CTraceContextPropagator } = require('@opentelemetry/core');
    // @opentelemetry/resources v2 uses resourceFromAttributes instead of new Resource()
    const { resourceFromAttributes } = require('@opentelemetry/resources');

    // Cloud Trace OTLP endpoint (gRPC)
    const traceExporter = new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
           'https://telemetry.googleapis.com',
    });

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        'service.name': 'orchestrator-backend',
        'service.version': '1.0.0',
        'gcp.project_id': GCP_PROJECT,
      }),
      traceExporter,
      // W3C traceparent propagation so ADK + Node.js spans join
      textMapPropagator: new W3CTraceContextPropagator(),
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-http': { enabled: true },
          '@opentelemetry/instrumentation-express': { enabled: true },
        }),
      ],
    });

    sdk.start();

    // Graceful shutdown
    process.on('SIGTERM', () => sdk.shutdown().catch(() => {}));
    process.on('SIGINT',  () => sdk.shutdown().catch(() => {}));

    console.log('[OTel] SDK started — exporting traces to Cloud Trace');
    module.exports = { initialized: true, sdk };
  } catch (err) {
    // OTel packages not installed — silently degrade
    console.warn('[OTel] SDK not available, tracing disabled:', err.message);
    module.exports = { initialized: false };
  }
}
