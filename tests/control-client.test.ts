import { describe, expect, it } from "vitest";

import { HeadlessClientError, MagiHeadlessClient } from "../src/control/client.js";

describe("MagiHeadlessClient", () => {
  it("pairs once and sends device credentials to versioned endpoints", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/v1/pairing")) {
        return Response.json({
          deviceId: "desktop-1",
          token: "magi_token",
          expiresAt: "2027-01-01T00:00:00.000Z"
        });
      }
      return Response.json({ status: "ready" });
    };
    const client = new MagiHeadlessClient({ baseUrl: "http://127.0.0.1:8765/", fetch: fetchImpl });

    await expect(client.status()).rejects.toBeInstanceOf(HeadlessClientError);
    await client.pair("desktop", 365 * 24 * 60 * 60_000);
    await client.status();

    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:8765/v1/pairing",
      "http://127.0.0.1:8765/v1/status"
    ]);
    expect(requests[0].init?.body).toBe(
      JSON.stringify({ name: "desktop", ttlMs: 365 * 24 * 60 * 60_000 })
    );
    const headers = requests[1].init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer magi_token");
    expect(headers.get("x-magi-device-id")).toBe("desktop-1");
  });

  it("parses typed SSE frames and sends a reconnect cursor", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              "retry: 2000",
              "event: ready",
              'data: {"ok":true}',
              "",
              "id: 43",
              "event: audit",
              'data: {"action":"agent.text.delta"}',
              "",
              ""
            ].join("\n")
          )
        );
        controller.close();
      }
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    };
    const client = new MagiHeadlessClient({
      baseUrl: "http://127.0.0.1:8765",
      credentials: { deviceId: "desktop-1", token: "magi_token" },
      fetch: fetchImpl
    });

    const events = [];
    for await (const event of client.streamEvents({ jobId: "job-1", afterId: 42 })) {
      events.push(event);
    }

    expect(events).toEqual([
      { id: undefined, event: "ready", data: { ok: true } },
      { id: 43, event: "audit", data: { action: "agent.text.delta" } }
    ]);
    expect(requests[0].url).toBe("http://127.0.0.1:8765/v1/events?jobId=job-1");
    expect((requests[0].init?.headers as Headers).get("last-event-id")).toBe("42");
  });

  it("loads the provider catalog for desktop model selection", async () => {
    const requests: string[] = [];
    const client = new MagiHeadlessClient({
      baseUrl: "http://127.0.0.1:8765",
      credentials: { deviceId: "desktop-1", token: "magi_token" },
      fetch: async (input) => {
        requests.push(String(input));
        return Response.json({
          providers: [
            { name: "local", type: "openai-compatible", defaultModel: "coder", configured: true }
          ],
          aliases: { main: "local/coder" }
        });
      }
    });

    await expect(client.listProviders()).resolves.toMatchObject({
      aliases: { main: "local/coder" }
    });
    expect(requests).toEqual(["http://127.0.0.1:8765/v1/providers"]);
  });

  it("submits local provider discovery credentials to the versioned endpoint", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new MagiHeadlessClient({
      baseUrl: "http://127.0.0.1:8765",
      credentials: { deviceId: "desktop-1", token: "magi_token" },
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json({ ok: true, selectedModel: "desktop:coder" });
      }
    });

    await client.configureProvider({
      providerName: "team-openai",
      protocol: "openai",
      baseUrl: "https://models.example/v1",
      apiKey: "secret"
    });

    expect(requests[0].url).toBe("http://127.0.0.1:8765/v1/providers/discover");
    expect(requests[0].init?.body).toBe(
      JSON.stringify({
        providerName: "team-openai",
        protocol: "openai",
        baseUrl: "https://models.example/v1",
        apiKey: "secret"
      })
    );
  });
});
