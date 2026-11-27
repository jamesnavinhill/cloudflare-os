// The one MCP server this deployment configures centrally, if any.
//
// This connector otherwise connects whatever endpoint a user pastes, and a pasted endpoint can
// only be probed: public, or OAuth. A deployment's own gateway may be neither -- the agency
// gateway (tools.yrka.io/mcp) has always authenticated with the deployment's Bearer key, an
// auth kind the account layer supports as "token" but which no probe can discover and no user
// should ever be handed to paste. Configuring the server here, the way the MCP Server Portals
// connector configures its portal, is what lets that gateway connect as what it is:
// deployment-provenance, deployment-named, token-authed. Unconfigured, nothing changes: the
// connector offers only user-supplied endpoints, exactly as before. See the yrka pipeline
// (scripts/yrka/yrka-config.ts), which is where this deployment sets it.

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { ConnectedServer, ServerAuthKind } from "@gadgets/mcp-shared/account";
import { fetchOptions } from "@gadgets/mcp-shared/fetch";
import { sameEndpoint } from "@gadgets/mcp-shared/scope";
import { serverIdFromEndpoint } from "./server-id.js";

/** The configured server, once the deployment's vars have been read and validated. */
export type ServerConfig = {
  /** The server's MCP endpoint URL (Streamable HTTP). */
  endpoint: string;
  /** Display name shown in the connector list and in every approval prompt. */
  name: string;
  /** How to authenticate. */
  auth: ServerAuthKind;
};

/**
 * Reads the deployment's configured server, or null when none is configured. A missing or
 * unusable `MCP_SERVER_URL` returns null rather than throwing, so the connector simply does
 * not advertise the configured resource.
 */
export function readServerConfig(env: Env): ServerConfig | null {
  const raw = env.MCP_SERVER_URL?.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // The same rule `guardedFetch` applies anyway. Enforcing it here means an `http://` typo
  // hides the resource rather than failing on the first request, with an error naming a URL
  // the user never saw.
  if (url.protocol !== "https:" && !(fetchOptions(env).allowInsecure && url.protocol === "http:")) {
    return null;
  }
  // URL userinfo is an ambient credential: URL and fetch APIs can copy it into requests, while
  // this connector also persists and returns the endpoint to users and configurator frames.
  // Server auth has explicit OAuth/token settings, so reject rather than silently stripping
  // credentials and contacting a different endpoint than the administrator configured.
  if (url.username || url.password) return null;
  url.hash = "";

  const configured = env.MCP_SERVER_AUTH?.trim().toLowerCase();
  const auth: ServerAuthKind =
    configured === "none" || configured === "token" ? configured : "oauth";

  return {
    endpoint: url.toString(),
    name: env.MCP_SERVER_NAME?.trim() || `MCP server (${url.host})`,
    auth,
  };
}

/** The resource type for the configured server, scoped to its exact endpoint. */
export function configuredResource(config: ServerConfig): SupportedResource {
  return {
    id: "deployment-server",
    // Endpoint-scoped (the endpoint itself and anything under it), so a resource URL for any
    // other server matches nothing this entry offers.
    urlPattern: `${config.endpoint}*`,
    title: config.name,
    description:
      "The MCP server this deployment is configured with. Reads happen straight away; " +
      "anything that writes waits for your approval.",
  };
}

/**
 * The connected-server record stored on an account for the configured server, derived entirely
 * from configuration. `provenance` is what keeps the far side from renaming itself over
 * `MCP_SERVER_NAME` in every approval prompt (see `McpAccountBase.complete`).
 */
export function configuredServer(config: ServerConfig): ConnectedServer {
  return {
    endpoint: config.endpoint,
    provenance: "deployment",
    auth: config.auth,
    serverId: serverIdFromEndpoint(config.endpoint),
    serverName: config.name,
  };
}

/**
 * Probing may legitimately move between none and OAuth. A preissued token is deployment
 * authority, so entering or leaving that mode requires the account to reconnect against
 * current configuration.
 */
export function serverAuthRequiresReconnect(
  connected: ServerAuthKind, configured: ServerAuthKind,
): boolean {
  return (connected === "token") !== (configured === "token");
}

/**
 * The preissued token, but only for the endpoint the deployment currently names.
 *
 * `MCP_SERVER_TOKEN` is the one credential in this connector read from live configuration
 * rather than from an account's storage. Everything else an account hands out was minted for
 * the endpoint that account records, so it is safe to send there by construction. This is
 * not: an administrator repoints the server by editing the URL and its token together, which
 * touches no account, so until someone reconnects the account still names the old host while
 * this value is already the new deployment's secret. An account-side endpoint check cannot
 * catch that -- it compares the caller against storage that has not moved yet -- so the
 * scoping has to happen here, against the configuration the token actually belongs to.
 *
 * Null means "this deployment has no token for that endpoint", covering both a server with
 * no token configured and one that has since been repointed. Callers fail the request closed
 * either way. A user-connected server never matches the configured endpoint check unless it
 * IS the configured endpoint, so the token cannot leak to a pasted endpoint on another host
 * or path.
 */
export function serverTokenFor(env: Env, endpoint: string): string | null {
  const config = readServerConfig(env);
  if (config?.auth !== "token" || !sameEndpoint(config.endpoint, endpoint)) return null;
  return env.MCP_SERVER_TOKEN || null;
}
