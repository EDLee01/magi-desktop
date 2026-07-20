import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import YAML from "yaml";

import { MagiConfig, ProviderConfig, validateConfig } from "../config.js";
import { atomicWrite } from "../fs-utils.js";
import { MagiPaths } from "../paths.js";

export type ProviderProtocol = "openai" | "anthropic";

export interface DiscoveredProvider {
  baseUrl: string;
  defaultModel: string;
  models: string[];
}

export class ProviderDiscoveryError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid_input" | "connection" | "authentication" | "response"
  ) {
    super(message);
    this.name = "ProviderDiscoveryError";
  }
}

export async function discoverProviderModels(input: {
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<DiscoveredProvider> {
  const apiKey = normalizeApiKey(input.apiKey);
  const candidates = normalizeCandidates(input.baseUrl, input.protocol);
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let lastFailure = "The provider did not return a usable model list.";

  for (const candidate of candidates) {
    let response: Response;
    try {
      response = await fetchImpl(candidate.modelsUrl, {
        method: "GET",
        headers: discoveryHeaders(input.protocol, apiKey),
        redirect: "error",
        signal: AbortSignal.timeout(input.timeoutMs ?? 15_000)
      });
    } catch (error) {
      throw new ProviderDiscoveryError(
        `Could not connect to ${new URL(candidate.modelsUrl).origin}: ${safeErrorMessage(error)}`,
        "connection"
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProviderDiscoveryError(
        "The provider rejected this API key. Check the key and try again.",
        "authentication"
      );
    }
    if (!response.ok) {
      lastFailure = `The model endpoint returned HTTP ${response.status}.`;
      if (response.status === 404 || response.status === 405) continue;
      throw new ProviderDiscoveryError(lastFailure, "response");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      lastFailure = "The model endpoint did not return JSON.";
      continue;
    }
    const models = readModelIds(payload);
    if (models.length === 0) {
      lastFailure = "The model endpoint returned no model IDs.";
      continue;
    }
    return {
      baseUrl: candidate.providerBaseUrl,
      defaultModel: chooseDefaultModel(models),
      models
    };
  }

  throw new ProviderDiscoveryError(lastFailure, "response");
}

export function configureDiscoveredProvider(input: {
  paths: MagiPaths;
  config: MagiConfig;
  env?: NodeJS.ProcessEnv;
  protocol: ProviderProtocol;
  apiKey: string;
  discovered: DiscoveredProvider;
  providerName: string;
}): { providerName: string; modelRef: string; provider: ProviderConfig } {
  const providerName = input.providerName.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(providerName)) {
    throw new ProviderDiscoveryError("Provider name is invalid.", "invalid_input");
  }
  const apiKey = normalizeApiKey(input.apiKey);
  const apiKeyEnv = keyEnvForProvider(providerName);
  const raw = YAML.parse(readFileSync(input.paths.configFile, "utf8"));
  const document = isRecord(raw) ? raw : {};
  const providers = ensureRecord(document, "providers");
  providers[providerName] =
    input.protocol === "anthropic"
      ? {
          type: "messages-compatible",
          format: "anthropic-messages",
          apiKeyEnv,
          baseUrl: input.discovered.baseUrl,
          defaultModel: input.discovered.defaultModel,
          models: input.discovered.models
        }
      : {
          type: "openai",
          apiKeyEnv,
          baseUrl: input.discovered.baseUrl,
          defaultModel: input.discovered.defaultModel,
          models: input.discovered.models,
          endpoint: "chat"
        };

  const modelsConfig = ensureRecord(document, "models");
  const aliases = ensureRecord(modelsConfig, "aliases");
  const modelRef = `${providerName}:${input.discovered.defaultModel}`;
  if (typeof aliases.main !== "string" || !aliases.main.trim()) aliases.main = modelRef;
  ensureRecord(modelsConfig, "fallbacks");

  const runtimeEnv = input.env ?? process.env;
  const nextEnv = { ...runtimeEnv, [apiKeyEnv]: apiKey };
  const validated = validateConfig(document, input.paths.configFile, nextEnv);
  const provider = validated.providers[providerName];
  if (!provider) {
    throw new ProviderDiscoveryError("Provider configuration could not be validated.", "response");
  }

  persistProviderKey(input.paths, apiKeyEnv, apiKey);
  atomicWrite(input.paths.configFile, YAML.stringify(document), { mode: 0o600, syncDir: true });

  runtimeEnv[apiKeyEnv] = apiKey;
  input.config.providers[providerName] = provider;
  input.config.models.aliases = validated.models.aliases;
  input.config.models.fallbacks = validated.models.fallbacks;
  input.config.models.router = validated.models.router;

  return { providerName, modelRef, provider };
}

function normalizeCandidates(
  raw: string,
  protocol: ProviderProtocol
): Array<{ modelsUrl: string; providerBaseUrl: string }> {
  const value = raw.trim();
  if (!value || value.length > 2_048) {
    throw new ProviderDiscoveryError("Base URL is required.", "invalid_input");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderDiscoveryError(
      "Base URL must be a valid HTTP or HTTPS URL.",
      "invalid_input"
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProviderDiscoveryError("Base URL must use HTTP or HTTPS.", "invalid_input");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderDiscoveryError(
      "Base URL must not contain credentials, query parameters, or a fragment.",
      "invalid_input"
    );
  }

  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/models$/i, "") || "/";
  const normalized = url.toString().replace(/\/+$/, "");
  if (protocol === "anthropic") {
    const providerBaseUrl = normalized.replace(/\/v1$/i, "");
    return [{ modelsUrl: `${providerBaseUrl}/v1/models`, providerBaseUrl }];
  }
  const baseUrls = [normalized];
  if (!url.pathname.replace(/\/+$/, "").endsWith("/v1")) baseUrls.push(`${normalized}/v1`);
  return [...new Set(baseUrls)].map((baseUrl) => ({
    modelsUrl: `${baseUrl}/models`,
    providerBaseUrl: baseUrl
  }));
}

function normalizeApiKey(raw: string): string {
  const value = raw.trim();
  if (!value || value.length > 16_384 || /[\r\n\0]/.test(value)) {
    throw new ProviderDiscoveryError(
      "API key must be a non-empty single-line value.",
      "invalid_input"
    );
  }
  return value;
}

function readModelIds(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const source = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : [];
  const models: string[] = [];
  for (const item of source) {
    const raw =
      typeof item === "string"
        ? item
        : isRecord(item)
          ? [item.id, item.model, item.name].find((value) => typeof value === "string")
          : undefined;
    if (typeof raw !== "string") continue;
    const model = raw.trim();
    if (!model || model.length > 256 || /[\r\n\0]/.test(model)) continue;
    if (!models.includes(model)) models.push(model);
    if (models.length >= 500) break;
  }
  return models;
}

function chooseDefaultModel(models: string[]): string {
  const generative = models.find((model) => {
    const lower = model.toLowerCase();
    if (/embedding|moderation|whisper|transcri|tts|speech|dall-e|image|rerank/.test(lower)) {
      return false;
    }
    return /gpt|codex|claude|deepseek|qwen|gemini|mistral|llama|chat|instruct|kimi/.test(lower);
  });
  return generative ?? models[0];
}

function persistProviderKey(paths: MagiPaths, apiKeyEnv: string, apiKey: string): void {
  const envFile = path.join(paths.root, "provider.env");
  const line = `${apiKeyEnv}=${quoteEnvValue(apiKey)}`;
  const existing = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const pattern = new RegExp(`^(?:export\\s+)?${apiKeyEnv}\\s*=.*$`, "m");
  const next = pattern.test(existing)
    ? existing.replace(pattern, line)
    : `${existing.trimEnd()}${existing.trim() ? "\n" : ""}${line}\n`;
  atomicWrite(envFile, next.endsWith("\n") ? next : `${next}\n`, {
    mode: 0o600,
    syncDir: true
  });
}

function discoveryHeaders(protocol: ProviderProtocol, apiKey: string): Record<string, string> {
  return protocol === "anthropic"
    ? {
        accept: "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      }
    : { accept: "application/json", authorization: `Bearer ${apiKey}` };
}

export function keyEnvForProvider(providerName: string): string {
  const readable = providerName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  const digest = createHash("sha256").update(providerName).digest("hex").slice(0, 8).toUpperCase();
  return `MAGI_PROVIDER_${readable || "CUSTOM"}_${digest}_API_KEY`;
}

function quoteEnvValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;
}

function ensureRecord(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = root[key];
  if (isRecord(current)) return current;
  const next: Record<string, unknown> = {};
  root[key] = next;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "request timed out";
  return error instanceof Error ? error.message : String(error);
}
