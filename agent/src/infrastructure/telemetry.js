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

const INSTRUMENTATION_NAME = 'pi-enterprise-agent';
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

export async function startTelemetry(env = process.env, options = {}) {
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
          timeoutMillis: positiveInteger(env.OTEL_EXPORTER_OTLP_TIMEOUT, 10_000),
        }),
        {
          maxQueueSize: positiveInteger(env.OTEL_BSP_MAX_QUEUE_SIZE, 2_048),
          maxExportBatchSize: positiveInteger(
            env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE,
            512,
          ),
          scheduledDelayMillis: positiveInteger(
            env.OTEL_BSP_SCHEDULE_DELAY,
            5_000,
          ),
          exportTimeoutMillis: positiveInteger(
            env.OTEL_BSP_EXPORT_TIMEOUT,
            10_000,
          ),
        },
      )
    : new NoopSpanProcessor();
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: String(
        env.OTEL_SERVICE_NAME || options.serviceName || 'pi-enterprise-agent',
      ),
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

export function carrierFromRunJob(ref) {
  return {
    traceparent: ref?.traceparent,
    tracestate: ref?.tracestate,
  };
}

export function contextFromRunJob(ref) {
  return propagation.extract(ROOT_CONTEXT, carrierFromRunJob(ref));
}

export function injectTraceCarrier(target = {}) {
  propagation.inject(context.active(), target);
  return target;
}

export function formatStoredTraceCarrier(run) {
  const traceId = String(run?.traceId || '').toLowerCase();
  const spanId = String(run?.traceParentSpanId || '').toLowerCase();
  const flags = String(run?.traceFlags || '01').toLowerCase();
  if (
    !/^[0-9a-f]{32}$/.test(traceId) ||
    !/^[0-9a-f]{16}$/.test(spanId) ||
    !/^[0-9a-f]{2}$/.test(flags)
  ) {
    return {};
  }
  return {
    traceparent: `00-${traceId}-${spanId}-${flags}`,
    ...(run?.traceState ? { tracestate: String(run.traceState) } : {}),
  };
}

export function contextFromTraceFields(value, options = {}) {
  const traceId = String(value?.traceId || '').toLowerCase();
  const spanId = String(value?.spanId || value?.parentSpanId || '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) {
    return ROOT_CONTEXT;
  }
  const rawFlags = String(value?.traceFlags || '01');
  const parsedFlags = Number.parseInt(rawFlags, 16);
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId,
    traceFlags: Number.isFinite(parsedFlags) ? parsedFlags : TraceFlags.SAMPLED,
    isRemote: options.isRemote !== false,
    ...(value?.traceState ? { traceState: createTraceState(value.traceState) } : {}),
  });
}

export function activeTraceFields() {
  const spanContext = trace.getSpanContext(context.active());
  if (!spanContext?.traceId || !spanContext?.spanId) return null;
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceFlags: Number(spanContext.traceFlags || 0)
      .toString(16)
      .padStart(2, '0'),
    traceState: spanContext.traceState?.serialize?.() || null,
  };
}

export function startHttpServerSpan(req, resolved) {
  let parent = propagation.extract(ROOT_CONTEXT, {
    traceparent: req?.headers?.traceparent,
    tracestate: req?.headers?.tracestate,
  });
  if (!trace.getSpanContext(parent)) parent = contextFromTraceFields(resolved);
  return startSpan(
    `${String(req?.method || 'HTTP')} ${String(req?.url || '/').split('?')[0]}`,
    { kind: SpanKind.SERVER },
    parent,
  );
}

export function startSpan(name, options = {}, parent = context.active()) {
  const tracer = trace.getTracer(INSTRUMENTATION_NAME, '4.0.0');
  const span = tracer.startSpan(name, options, parent);
  const activeContext = trace.setSpan(parent, span);
  let ended = false;
  const end = (error, statusCode) => {
    if (ended) return;
    ended = true;
    if (error || Number(statusCode) >= 500) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        ...(error instanceof Error ? { message: error.message } : {}),
      });
      if (error instanceof Error) span.recordException(error);
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    if (Number(statusCode)) span.setAttribute('http.response.status_code', Number(statusCode));
    span.end();
  };
  return { span, activeContext, end };
}

export async function withActiveContext(activeContext, fn) {
  return context.with(activeContext, fn);
}

export { SpanKind };
