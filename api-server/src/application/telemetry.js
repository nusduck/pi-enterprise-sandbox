import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  createTraceState,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  NoopSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const INSTRUMENTATION_NAME = 'pi-enterprise-bff';
const DEFAULT_EXPORT_TIMEOUT_MS = 10_000;
const DEFAULT_SCHEDULE_DELAY_MS = 5_000;
const DEFAULT_MAX_QUEUE_SIZE = 2_048;
const DEFAULT_MAX_EXPORT_BATCH_SIZE = 512;

let telemetry = null;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function configuredEndpoint(env) {
  const traces = String(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || '').trim();
  if (traces) return traces;
  const base = String(env.OTEL_EXPORTER_OTLP_ENDPOINT || '').trim().replace(/\/$/, '');
  return base ? `${base}/v1/traces` : null;
}

export async function startTelemetry(env = process.env) {
  if (telemetry) return telemetry;
  const endpoint = configuredEndpoint(env);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  if (String(env.OTEL_SDK_DISABLED || '').toLowerCase() === 'true') {
    telemetry = Object.freeze({ enabled: false, async shutdown() {} });
    return telemetry;
  }

  const spanProcessor = endpoint
    ? new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: endpoint,
          timeoutMillis: positiveInteger(
            env.OTEL_EXPORTER_OTLP_TIMEOUT,
            DEFAULT_EXPORT_TIMEOUT_MS,
          ),
        }),
        {
          maxQueueSize: positiveInteger(
            env.OTEL_BSP_MAX_QUEUE_SIZE,
            DEFAULT_MAX_QUEUE_SIZE,
          ),
          maxExportBatchSize: positiveInteger(
            env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE,
            DEFAULT_MAX_EXPORT_BATCH_SIZE,
          ),
          scheduledDelayMillis: positiveInteger(
            env.OTEL_BSP_SCHEDULE_DELAY,
            DEFAULT_SCHEDULE_DELAY_MS,
          ),
          exportTimeoutMillis: positiveInteger(
            env.OTEL_BSP_EXPORT_TIMEOUT,
            DEFAULT_EXPORT_TIMEOUT_MS,
          ),
        },
      )
    : new NoopSpanProcessor();
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: String(env.OTEL_SERVICE_NAME || 'pi-enterprise-bff'),
      [ATTR_SERVICE_VERSION]: '4.0.0',
      'deployment.environment.name': String(
        env.DEPLOYMENT_ENV || env.NODE_ENV || 'development',
      ),
    }),
    spanProcessors: [spanProcessor],
    textMapPropagator: new W3CTraceContextPropagator(),
    instrumentations: [
      new UndiciInstrumentation({
        requireParentforSpans: true,
        headersToSpanAttributes: {
          requestHeaders: [],
          responseHeaders: [],
        },
      }),
    ],
  });
  sdk.start();
  let stopped = false;
  telemetry = Object.freeze({
    enabled: Boolean(endpoint),
    endpoint,
    async shutdown() {
      if (stopped) return;
      stopped = true;
      await sdk.shutdown();
    },
  });
  return telemetry;
}

export function requestCarrier(headers = {}) {
  const carrier = {};
  for (const name of ['traceparent', 'tracestate']) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (typeof value === 'string' && value) carrier[name] = value;
  }
  return carrier;
}

export function contextFromTraceContext(value) {
  const traceId = String(value?.traceId || '').toLowerCase();
  const spanId = String(value?.parentSpanId || value?.spanId || '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) {
    return ROOT_CONTEXT;
  }
  const flags = Number.parseInt(String(value?.traceFlags || '01'), 16);
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId,
    traceFlags: Number.isFinite(flags) ? flags : TraceFlags.SAMPLED,
    isRemote: true,
    ...(value?.tracestate ? { traceState: createTraceState(value.tracestate) } : {}),
  });
}

export function startHttpServerSpan(req, resolvedTraceContext) {
  const parent = propagation.extract(ROOT_CONTEXT, requestCarrier(req?.headers));
  const parentContext = trace.getSpanContext(parent)
    ? parent
    : contextFromTraceContext(resolvedTraceContext);
  const tracer = trace.getTracer(INSTRUMENTATION_NAME, '4.0.0');
  const span = tracer.startSpan(
    `${String(req?.method || 'HTTP')} ${String(req?.url || '/').split('?')[0]}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        'http.request.method': String(req?.method || 'UNKNOWN'),
        'url.path': String(req?.url || '/').split('?')[0],
      },
    },
    parentContext,
  );
  const activeContext = trace.setSpan(parentContext, span);
  let ended = false;
  const end = (error, statusCodeValue) => {
    if (ended) return;
    ended = true;
    const statusCode = Number(statusCodeValue || 0);
    if (error || statusCode >= 500) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        ...(error instanceof Error ? { message: error.message } : {}),
      });
      if (error instanceof Error) span.recordException(error);
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    if (statusCode) span.setAttribute('http.response.status_code', statusCode);
    span.end();
  };
  return { span, activeContext, end };
}

export async function withActiveContext(activeContext, fn) {
  return context.with(activeContext, fn);
}
