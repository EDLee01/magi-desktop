import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { ensureMagiHome, getMagiPaths } from "../src/paths.js";
import {
  ProviderDiscoveryError,
  configureDiscoveredProvider,
  discoverProviderModels,
  keyEnvForProvider
} from "../src/providers/discovery.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

let temp: TempRoot | undefined;

afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

describe("OpenAI-compatible provider discovery", () => {
  it("falls back to /v1/models and extracts common model payloads", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://models.example/models") {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      return Response.json({
        data: [{ id: "text-embedding-3-small" }, { id: "gpt-coder" }, { id: "gpt-coder" }]
      });
    });

    await expect(
      discoverProviderModels({
        protocol: "openai",
        baseUrl: "https://models.example",
        apiKey: "secret-key",
        fetchImpl
      })
    ).resolves.toEqual({
      baseUrl: "https://models.example/v1",
      defaultModel: "gpt-coder",
      models: ["text-embedding-3-small", "gpt-coder"]
    });
    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      "https://models.example/models",
      "https://models.example/v1/models"
    ]);
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get("authorization")).toBe(
      "Bearer secret-key"
    );
  });

  it("reports provider authentication failures without echoing the key", async () => {
    const key = "very-secret-key";
    const error = await discoverProviderModels({
      protocol: "openai",
      baseUrl: "https://models.example/v1",
      apiKey: key,
      fetchImpl: async () => Response.json({ error: "bad key" }, { status: 401 })
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderDiscoveryError);
    expect((error as Error).message).not.toContain(key);
  });

  it("persists the discovered models and key with owner-only permissions", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    const config = loadConfig(paths, temp.env);

    const result = configureDiscoveredProvider({
      paths,
      config,
      env: temp.env,
      protocol: "openai",
      providerName: "team-openai",
      apiKey: 'sk-test-$-"',
      discovered: {
        baseUrl: "https://models.example/v1",
        defaultModel: "coder-main",
        models: ["coder-main", "coder-fast"]
      }
    });

    const keyEnv = keyEnvForProvider("team-openai");
    expect(result.modelRef).toBe("team-openai:coder-main");
    expect(config.providers["team-openai"].models).toEqual(["coder-main", "coder-fast"]);
    expect(config.models.aliases.main).toBe("team-openai:coder-main");
    expect(temp.env[keyEnv]).toBe('sk-test-$-"');

    const reloaded = loadConfig(paths, {
      ...temp.env,
      [keyEnv]: 'sk-test-$-"'
    });
    expect(reloaded.providers["team-openai"].baseUrl).toBe("https://models.example/v1");
    expect(readFileSync(path.join(paths.root, "provider.env"), "utf8")).toContain(`${keyEnv}=`);
    expect(statSync(paths.configFile).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(paths.root, "provider.env")).mode & 0o777).toBe(0o600);
  });

  it("uses Anthropic model discovery headers and persists the protocol base URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ id: "claude-main" }, { id: "claude-fast" }] })
    );
    const discovered = await discoverProviderModels({
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "anthropic-key",
      fetchImpl
    });

    expect(discovered.baseUrl).toBe("https://api.anthropic.com");
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://api.anthropic.com/v1/models");
    const headers = new Headers(fetchImpl.mock.calls[0][1]?.headers);
    expect(headers.get("x-api-key")).toBe("anthropic-key");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("authorization")).toBeNull();
  });
});
