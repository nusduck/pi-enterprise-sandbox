"""OpenTelemetry runtime for the Sandbox HTTP process.

The durable MySQL trace projection remains the product query source. This
module is the runtime exporter/propagator used for distributed tracing; it
never records request bodies, tool arguments, credentials, or response data.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Iterator

from opentelemetry import propagate, trace
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import (
    NonRecordingSpan,
    Span,
    SpanContext,
    SpanKind,
    Status,
    StatusCode,
    TraceFlags,
    TraceState,
)
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

_provider: TracerProvider | None = None
_shutdown = False


def _positive_int(value: object, fallback: int) -> int:
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def _endpoint() -> str | None:
    traces = os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "").strip()
    if traces:
        return traces
    base = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip().rstrip("/")
    return f"{base}/v1/traces" if base else None


def start_telemetry(service_name: str = "pi-enterprise-sandbox") -> TracerProvider:
    """Install a process-wide provider and W3C propagator once."""

    global _provider, _shutdown
    if _provider is not None:
        return _provider

    # Explicitly select W3C even when no exporter is configured. Propagation
    # and local spans are useful in development and do not require a backend.
    propagate.set_global_textmap(TraceContextTextMapPropagator())
    provider = TracerProvider(
        resource=Resource.create(
            {
                "service.name": os.getenv("OTEL_SERVICE_NAME", service_name),
                "service.version": "4.0.0",
                "deployment.environment.name": os.getenv(
                    "DEPLOYMENT_ENV", os.getenv("SANDBOX_DEPLOYMENT_ENV", "development")
                ),
            }
        )
    )
    endpoint = _endpoint()
    if endpoint and os.getenv("OTEL_SDK_DISABLED", "").strip().lower() != "true":
        exporter = OTLPSpanExporter(
            endpoint=endpoint,
            timeout=_positive_int(os.getenv("OTEL_EXPORTER_OTLP_TIMEOUT"), 10),
        )
        provider.add_span_processor(
            BatchSpanProcessor(
                exporter,
                max_queue_size=_positive_int(os.getenv("OTEL_BSP_MAX_QUEUE_SIZE"), 2048),
                max_export_batch_size=_positive_int(
                    os.getenv("OTEL_BSP_MAX_EXPORT_BATCH_SIZE"), 512
                ),
                schedule_delay_millis=_positive_int(
                    os.getenv("OTEL_BSP_SCHEDULE_DELAY"), 5000
                ),
                export_timeout_millis=_positive_int(
                    os.getenv("OTEL_BSP_EXPORT_TIMEOUT"), 10000
                ),
            )
        )
    trace.set_tracer_provider(provider)
    _provider = provider
    _shutdown = False
    return provider


def shutdown_telemetry() -> None:
    global _shutdown
    if _shutdown or _provider is None:
        return
    _shutdown = True
    _provider.shutdown()


def tracer(service_name: str = "pi-enterprise-sandbox"):
    start_telemetry(service_name)
    return trace.get_tracer(service_name, "4.0.0")


def extracted_parent(headers: object) -> Context:
    """Extract a W3C parent from a Starlette headers mapping."""

    try:
        return propagate.extract(dict(headers))
    except (TypeError, ValueError):
        return Context()


def synthetic_trace_parent(trace_id: str, span_id: str) -> Context | None:
    """Build a remote parent for legacy X-Trace-Id-only callers."""

    if (
        not isinstance(trace_id, str)
        or not isinstance(span_id, str)
        or len(trace_id) != 32
        or len(span_id) != 16
        or trace_id == "0" * 32
        or span_id == "0" * 16
    ):
        return None
    try:
        parent = SpanContext(
            trace_id=int(trace_id, 16),
            span_id=int(span_id, 16),
            is_remote=True,
            trace_flags=TraceFlags(TraceFlags.SAMPLED),
            trace_state=TraceState(),
        )
    except (TypeError, ValueError):
        return None
    return trace.set_span_in_context(NonRecordingSpan(parent))


@contextmanager
def server_span(
    method: str,
    path: str,
    parent: Context | None = None,
) -> Iterator[Span]:
    """Yield a server span with only low-cardinality safe attributes."""

    span = tracer().start_span(
        f"{method} {path}",
        context=parent,
        kind=SpanKind.SERVER,
        attributes={
            "http.request.method": method,
            "url.path": path,
        },
    )
    with trace.use_span(span, end_on_exit=True):
        try:
            yield span
        except Exception as exc:
            span.record_exception(exc)
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            raise


def finish_server_span(span: Span, status_code: int) -> None:
    span.set_attribute("http.response.status_code", int(status_code))
    if status_code >= 500:
        span.set_status(Status(StatusCode.ERROR))
    elif status_code >= 100:
        span.set_status(Status(StatusCode.OK))
