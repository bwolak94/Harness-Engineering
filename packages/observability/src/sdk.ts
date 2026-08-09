import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import type { MetricReader } from "@opentelemetry/sdk-metrics";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

export interface HarnessOtelConfig {
  /** Service name reported in all spans and metrics. */
  serviceName: string;
  /** Service version, e.g. "0.0.0". */
  serviceVersion?: string;
  /**
   * OTLP collector endpoint (HTTP).
   * Defaults to http://localhost:4318 (standard collector HTTP port).
   */
  otlpEndpoint?: string;
  /**
   * Whether to actually start the SDK.
   * Set to false in unit tests to avoid connecting to a real collector.
   */
  enabled?: boolean;
}

/**
 * initOtelSdk — create and start the OpenTelemetry NodeSDK.
 *
 * Must be called ONCE at the composition root BEFORE any other import that
 * uses the OTel API, so the global tracer / meter providers are registered
 * before instrumentation code runs.
 *
 * Returns the SDK instance so the caller can shut it down on SIGTERM:
 *   process.on("SIGTERM", () => sdk.shutdown());
 */
export function initOtelSdk(config: HarnessOtelConfig): NodeSDK {
  const endpoint = config.otlpEndpoint ?? "http://localhost:4318";
  const enabled = config.enabled ?? true;

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion ?? "0.0.0",
  });

  const sdkConfig: Partial<NodeSDKConfiguration> & {
    resource: Resource;
    metricReader?: MetricReader;
  } = {
    resource,
  };
  if (enabled) {
    sdkConfig.traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });
    sdkConfig.metricReader = new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 30_000,
    });
  }

  // biome-ignore lint/suspicious/noExplicitAny: NodeSDK constructor type is overly strict with exactOptionalPropertyTypes
  const sdk = new NodeSDK(sdkConfig as any);

  if (enabled) {
    sdk.start();
  }

  return sdk;
}
