// Matrix plugin module implements http client behavior.
import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/ssrf-dispatcher";
import type { SsrFPolicy } from "../../runtime-api.js";
import { buildHttpError } from "./event-helpers.js";
import {
  createMatrixTransport,
  type HttpMethod,
  type MatrixTransport,
  type QueryParams,
} from "./transport.js";

type MatrixAuthedHttpClientParams = {
  homeserver: string;
  accessToken: string;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  transport?: MatrixTransport;
};

export class MatrixAuthedHttpClient {
  private readonly homeserver: string;
  private readonly accessToken: string;
  private readonly ssrfPolicy?: SsrFPolicy;
  private readonly dispatcherPolicy?: PinnedDispatcherPolicy;
  private readonly transport: MatrixTransport;

  constructor(params: MatrixAuthedHttpClientParams) {
    this.homeserver = params.homeserver;
    this.accessToken = params.accessToken;
    this.ssrfPolicy = params.ssrfPolicy;
    this.dispatcherPolicy = params.dispatcherPolicy;
    this.transport =
      params.transport ??
      createMatrixTransport({
        ssrfPolicy: params.ssrfPolicy,
        dispatcherPolicy: params.dispatcherPolicy,
      });
  }

  async requestJson(params: {
    method: HttpMethod;
    endpoint: string;
    qs?: QueryParams;
    body?: unknown;
    timeoutMs: number;
    allowAbsoluteEndpoint?: boolean;
  }): Promise<unknown> {
    const { response, text } = await this.transport.request({
      homeserver: this.homeserver,
      accessToken: this.accessToken,
      method: params.method,
      endpoint: params.endpoint,
      qs: params.qs,
      body: params.body,
      timeoutMs: params.timeoutMs,
      ssrfPolicy: this.ssrfPolicy,
      dispatcherPolicy: this.dispatcherPolicy,
      allowAbsoluteEndpoint: params.allowAbsoluteEndpoint,
    });
    if (!response.ok) {
      throw buildHttpError(response.status, text);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType === "application/json") {
      if (!text.trim()) {
        return {};
      }
      try {
        return JSON.parse(text);
      } catch {
        throw Object.assign(new Error("Matrix homeserver returned malformed JSON"), {
          statusCode: response.status,
        });
      }
    }
    return text;
  }

  async requestRaw(params: {
    method: HttpMethod;
    endpoint: string;
    qs?: QueryParams;
    timeoutMs: number;
    maxBytes?: number;
    readIdleTimeoutMs?: number;
    allowAbsoluteEndpoint?: boolean;
  }): Promise<Buffer> {
    const { response, buffer } = await this.transport.request({
      homeserver: this.homeserver,
      accessToken: this.accessToken,
      method: params.method,
      endpoint: params.endpoint,
      qs: params.qs,
      timeoutMs: params.timeoutMs,
      raw: true,
      maxBytes: params.maxBytes,
      readIdleTimeoutMs: params.readIdleTimeoutMs,
      ssrfPolicy: this.ssrfPolicy,
      dispatcherPolicy: this.dispatcherPolicy,
      allowAbsoluteEndpoint: params.allowAbsoluteEndpoint,
    });
    if (!response.ok) {
      throw buildHttpError(response.status, buffer.toString("utf8"));
    }
    return buffer;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
