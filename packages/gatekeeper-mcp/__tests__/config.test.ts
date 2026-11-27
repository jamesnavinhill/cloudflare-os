import { describe, expect, it } from "vitest";
import {
  configuredResource,
  configuredServer,
  readServerConfig,
  serverAuthRequiresReconnect,
  serverTokenFor,
} from "../src/config.js";

function env(overrides: Record<string, string> = {}): Env {
  return overrides as unknown as Env;
}

const GATEWAY = { MCP_SERVER_URL: "https://tools.example.com/mcp" };

describe("readServerConfig", () => {
  it("returns null when unconfigured, so no configured resource is advertised", () => {
    expect(readServerConfig(env())).toBeNull();
    expect(readServerConfig(env({ MCP_SERVER_URL: "   " }))).toBeNull();
  });

  it("returns null for an unparseable or non-HTTP URL", () => {
    expect(readServerConfig(env({ MCP_SERVER_URL: "not a url" }))).toBeNull();
    expect(readServerConfig(env({ MCP_SERVER_URL: "file:///etc/passwd" }))).toBeNull();
    expect(readServerConfig(env({ MCP_SERVER_URL: "javascript:alert(1)" }))).toBeNull();
  });

  it("rejects URL credentials rather than persisting or displaying them", () => {
    expect(readServerConfig(env({
      MCP_SERVER_URL: "https://admin:secret@tools.example.com/mcp",
    }))).toBeNull();
    expect(readServerConfig(env({
      MCP_SERVER_URL: "https://admin@tools.example.com/mcp",
    }))).toBeNull();
  });

  it("reads the endpoint and strips any fragment, defaulting the name and auth kind", () => {
    const defaulted = readServerConfig(env({ MCP_SERVER_URL: "https://tools.example.com/mcp#x" }));
    expect(defaulted?.endpoint).toBe("https://tools.example.com/mcp");
    expect(defaulted?.name).toBe("MCP server (tools.example.com)");
    expect(defaulted?.auth).toBe("oauth");
  });

  it("honours the configured name and the token/none auth kinds", () => {
    const named = readServerConfig(env({
      ...GATEWAY, MCP_SERVER_NAME: "tools (agency gateway)", MCP_SERVER_AUTH: "token",
    }));
    expect(named?.name).toBe("tools (agency gateway)");
    expect(named?.auth).toBe("token");
    expect(readServerConfig(env({ ...GATEWAY, MCP_SERVER_AUTH: "none" }))?.auth).toBe("none");
    expect(readServerConfig(env({ ...GATEWAY, MCP_SERVER_AUTH: "bogus" }))?.auth).toBe("oauth");
  });
});

describe("configuredServer / configuredResource", () => {
  it("derives a deployment-provenance record from configuration alone", () => {
    const config = readServerConfig(env({
      ...GATEWAY, MCP_SERVER_NAME: "tools (agency gateway)", MCP_SERVER_AUTH: "token",
    }))!;
    const server = configuredServer(config);
    expect(server.endpoint).toBe("https://tools.example.com/mcp");
    expect(server.provenance).toBe("deployment");
    expect(server.auth).toBe("token");
    expect(server.serverName).toBe("tools (agency gateway)");
    expect(server.serverId).toBe("tools");
  });

  it("scopes the resource to the configured endpoint", () => {
    const config = readServerConfig(env(GATEWAY))!;
    const resource = configuredResource(config);
    expect(resource.urlPattern).toBe("https://tools.example.com/mcp*");
    expect(resource.title).toBe(config.name);
  });
});

describe("serverTokenFor", () => {
  const tokenEnv = {
    ...GATEWAY, MCP_SERVER_AUTH: "token", MCP_SERVER_TOKEN: "sekrit",
  };

  it("returns the token only for the configured endpoint in token mode", () => {
    expect(serverTokenFor(env(tokenEnv), "https://tools.example.com/mcp")).toBe("sekrit");
    // Endpoint identity is the whole URL (sameEndpoint): a trailing slash is a different
    // endpoint, and the token fails closed there too.
    expect(serverTokenFor(env(tokenEnv), "https://tools.example.com/mcp/")).toBeNull();
  });

  it("never returns the token for another endpoint, host or path", () => {
    expect(serverTokenFor(env(tokenEnv), "https://other.example.com/mcp")).toBeNull();
    expect(serverTokenFor(env(tokenEnv), "https://tools.example.com/other")).toBeNull();
    expect(serverTokenFor(env(tokenEnv), "https://tools.example.com/mcp-v2")).toBeNull();
  });

  it("returns null when auth is not token, unconfigured, or no token is set", () => {
    expect(serverTokenFor(env({ ...GATEWAY, MCP_SERVER_TOKEN: "sekrit" }),
      "https://tools.example.com/mcp")).toBeNull();
    expect(serverTokenFor(env({ MCP_SERVER_TOKEN: "sekrit" }),
      "https://tools.example.com/mcp")).toBeNull();
    expect(serverTokenFor(env({ ...GATEWAY, MCP_SERVER_AUTH: "token" }),
      "https://tools.example.com/mcp")).toBeNull();
  });
});

describe("serverAuthRequiresReconnect", () => {
  it("only entering or leaving token mode requires a reconnect", () => {
    expect(serverAuthRequiresReconnect("oauth", "token")).toBe(true);
    expect(serverAuthRequiresReconnect("token", "oauth")).toBe(true);
    expect(serverAuthRequiresReconnect("token", "token")).toBe(false);
    expect(serverAuthRequiresReconnect("oauth", "none")).toBe(false);
  });
});
