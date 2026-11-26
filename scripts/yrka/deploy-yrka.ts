#!/usr/bin/env node

// Deploys this fork as a stable instance on the YRKA Cloudflare account. Staged, not run:
// every command here is prepared and locally validated, but the deployment itself is executed
// by its operator (lulu reviews and pushes; the run happens after that).
//
//   node scripts/yrka/deploy-yrka.ts plan              what would deploy, touching no network
//   node scripts/yrka/deploy-yrka.ts config            provision resources + write the configs
//   node scripts/yrka/deploy-yrka.ts deploy            provision, build, deploy, secrets
//   node scripts/yrka/deploy-yrka.ts verify            hit the live origin end to end
//
// The tiers, and why this order (the preview pipeline's order, same reasons):
//
//   1. internal workers (pdf-renderer, only when a chosen gatekeeper binds it) — bind nothing.
//   2. the gatekeepers   — bind tier 1 alone, and no hostname: reached only via the router.
//   3. workshop-backend  — binds every gatekeeper via GatekeeperVendor; no hostname either.
//   4. router            — the only public worker; binds backend + gatekeepers, serves the
//                          frontend assets, and owns the origin.
//
// Secrets are uploaded with `wrangler secret bulk` (values on stdin, never in argv or the
// config, which wrangler prints) immediately after each worker's own deploy. The window where
// a worker is live without its secrets is unreachable: workers_dev is false on every tier but
// the router, and the router deploys last, after the backend's secrets are in.
//
// Model wiring is deliberately absent from this script: on the YRKA deployment AI Gateway mode
// is OFF (no CF_AI_GATEWAY* variable is set anywhere here — standing rule: never Cloudflare AI
// Gateway), so the backend runs in direct-provider mode and each user adds the chat models as
// their own in the Workshop's settings, pointed at gateway.yrka.io. See the deploy-prep report
// for the exact provider/model settings.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { isGatekeeperPackage, readDeployablePackages, type DeployablePackage } from "../release/manifest-lib.ts";
import {
  PACKAGES_DIR, ROOT, YRKA_CONFIG_NAME, buildYrkaConfigs,
  customDomainForYrkaOrigin, internalWorkersFor, resolveYrkaGatekeepers, resolveYrkaOrigin,
  resolveYrkaTarget, yrkaResourcePlan, writeYrkaConfig, type YrkaConfig,
} from "./yrka-config.ts";

type Command = "plan" | "config" | "deploy" | "verify";

const USAGE = "Usage: deploy-yrka.ts <plan|config|deploy|verify> [--skip-build]";
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");

// The gatekeepers that take no third-party OAuth app (manifest-lib.ts
// NO_DEFAULT_CRED_INPUTS, plus homeassistant whose users connect a URL+token in-app): no
// credentials are looked up for these, and listing one under YRKA_<VENDOR>_CLIENT_ID would
// silently do nothing.
const NO_OAUTH_GATEKEEPERS = new Set([
  "gatekeeper-context", "gatekeeper-homeassistant", "gatekeeper-mcp", "gatekeeper-mcp-portal",
  "gatekeeper-scheduler",
]);

function parseArgs(argv: string[]): { command: Command; skipBuild: boolean } {
  const command = argv[0] as Command;
  if (!["plan", "config", "deploy", "verify"].includes(command)) throw new Error(USAGE);
  const unknown = argv.slice(1).filter((arg) => arg !== "--skip-build");
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}\n${USAGE}`);
  return { command, skipBuild: argv.includes("--skip-build") };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {})
    : Promise<{ status: number | null; stdout: string; stderr: string }> {
  console.log(`running: ${command}${options.cwd ? ` (in ${options.cwd})` : ""} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: ["pipe", "inherit", "inherit"], ...options });
    child.stdin.end(options.input ?? "");
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout: "", stderr: "" }));
  });
}

async function runOrThrow(pkg: DeployablePackage | { name: string; dir: string }, args: string[],
                          input?: string): Promise<void> {
  const result = await run(WRANGLER, args, { cwd: pkg.dir, input });
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed for ${pkg.name} with exit code ${result.status}`);
  }
}

// --- Cloudflare API (provisioning; CLOUDFLARE_API_TOKEN needs Workers Scripts Edit, KV Edit,
// R2 Edit on the target account) -------------------------------------------------------------

async function cloudflareApi(path: string, init?: RequestInit): Promise<unknown> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required (Workers/KV/R2 edit on the account).");
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => ({})) as { success?: boolean; errors?: unknown; result?: unknown };
  if (!response.ok || body.success === false) {
    throw new Error(`Cloudflare API ${init?.method ?? "GET"} ${path} failed with ${response.status}: ` +
        JSON.stringify(body.errors ?? body));
  }
  return body.result;
}

async function fetchWorkersDevHost(accountId: string): Promise<string> {
  const subdomain = await cloudflareApi(`/accounts/${accountId}/workers/subdomain`) as
      { subdomain?: string; enabled?: boolean };
  if (!subdomain?.subdomain || subdomain.enabled === false) {
    throw new Error("The account's workers.dev subdomain is missing or disabled; set " +
        "YRKA_PUBLIC_BASE_URL to a custom domain on the router instead.");
  }
  // The API returns the bare account subdomain (here: "jamie-5fd"), not the workers.dev host,
  // so the router's URL is https://router.<subdomain>.workers.dev — the suffix must be added or
  // every deployed origin var (PUBLIC_BASE_URL, gatekeeper BASE_URLs, context sharingDomain)
  // points at a hostname that does not resolve. Tolerate a value already carrying the suffix.
  return subdomain.subdomain.endsWith(".workers.dev")
      ? subdomain.subdomain
      : `${subdomain.subdomain}.workers.dev`;
}

interface ProvisionedResources { kvIds: Record<string, string>; r2Names: Record<string, string> }

/** List the account's KV namespaces and R2 buckets, keyed by what this deploy names them. */
async function findExistingResources(accountId: string): Promise<ProvisionedResources> {
  const [kvList, bucketList] = await Promise.all([
    cloudflareApi(`/accounts/${accountId}/storage/kv/namespaces`) as Promise<{ id: string; title: string }[]>,
    cloudflareApi(`/accounts/${accountId}/r2/buckets`) as Promise<{ buckets: { name: string }[] }>,
  ]);
  return {
    kvIds: Object.fromEntries(kvList.map((ns) => [ns.title, ns.id])),
    r2Names: Object.fromEntries((bucketList.buckets ?? []).map((b) => [b.name, b.name])),
  };
}

/**
 * Provision the deployment's KV namespaces and R2 bucket (create-if-missing), and return the
 * concrete ids the generated configs pin. Names are fixed (yrkaResourcePlan), so a rerun finds
 * the first run's resources rather than provisioning a second set — which is exactly why the
 * configs pin ids instead of leaving binding-only entries for wrangler to auto-provision.
 */
async function provisionResources(accountId: string, workers: readonly string[]): Promise<ProvisionedResources> {
  const { kvTitles, r2Names } = yrkaResourcePlan(workers);
  const existing = await findExistingResources(accountId);
  const kvIds: Record<string, string> = {};
  for (const [binding, title] of Object.entries(kvTitles)) {
    if (existing.kvIds[title]) {
      kvIds[binding] = existing.kvIds[title];
      continue;
    }
    const created = await cloudflareApi(`/accounts/${accountId}/storage/kv/namespaces`,
        { method: "POST", body: JSON.stringify({ title }) }) as { id: string };
    console.log(`created KV namespace ${title} (${binding})`);
    kvIds[binding] = created.id;
  }
  const bucketNames: Record<string, string> = {};
  for (const [binding, name] of Object.entries(r2Names)) {
    if (existing.r2Names[name]) {
      bucketNames[binding] = name;
      continue;
    }
    await cloudflareApi(`/accounts/${accountId}/r2/buckets`,
        { method: "POST", body: JSON.stringify({ name }) });
    console.log(`created R2 bucket ${name} (${binding})`);
    bucketNames[binding] = name;
  }
  return { kvIds, r2Names: bucketNames };
}

// --- secrets --------------------------------------------------------------------------------

/** The backend's secrets, keyed by the variable names it reads them as. */
function backendSecrets({ admins = process.env.YRKA_ADMINS }): Record<string, string> {
  if (!admins?.trim()) {
    throw new Error("YRKA_ADMINS is required: the deployment's admin usernames/emails, " +
        "comma-separated. Without it the /admin panel is unreachable.");
  }
  const secrets: Record<string, string> = {
    // A secret is always text, so the array goes over as JSON, the form #isAdmin() accepts.
    ADMINS: JSON.stringify(admins.split(",").map((admin) => admin.trim()).filter(Boolean)),
  };
  // Cloudflare Access is optional: with neither set the deployment runs username/password
  // login (the self-hosting default). The pair moves together — either alone verifies nothing.
  const aud = process.env.YRKA_CF_ACCESS_AUD?.trim();
  const iss = process.env.YRKA_CF_ACCESS_ISS?.trim();
  if (aud && iss) {
    secrets.CF_ACCESS_AUD = aud;
    secrets.CF_ACCESS_ISS = iss;
  } else if (aud || iss) {
    throw new Error("YRKA_CF_ACCESS_AUD and YRKA_CF_ACCESS_ISS must be set together.");
  }
  return secrets;
}

/** Whether this deployment authenticates via Cloudflare Access (the backend secret pair set). */
function cfAccessMode(): boolean {
  return !!(process.env.YRKA_CF_ACCESS_AUD?.trim() && process.env.YRKA_CF_ACCESS_ISS?.trim());
}

/**
 * One OAuth gatekeeper's secrets, from YRKA_<VENDOR>_CLIENT_ID and YRKA_<VENDOR>_CLIENT_SECRET
 * (vendor = the package name minus "gatekeeper-", uppercase, - -> _; e.g. YRKA_MCP_PORTAL_*).
 * The pair moves together — a gatekeeper holding half an OAuth app throws on the first click,
 * so a half pair fails the deploy instead (mirrors addOAuthApp in the preview pipeline).
 */
function gatekeeperSecrets(pkgName: string): Record<string, string> | undefined {
  if (NO_OAUTH_GATEKEEPERS.has(pkgName)) return undefined;
  const vendor = pkgName.replace(/^gatekeeper-/, "").replaceAll("-", "_").toUpperCase();
  const clientId = process.env[`YRKA_${vendor}_CLIENT_ID`]?.trim();
  const clientSecret = process.env[`YRKA_${vendor}_CLIENT_SECRET`]?.trim();
  const secrets: Record<string, string> = {};
  if (pkgName === "gatekeeper-microsoft") {
    const tenantId = process.env.YRKA_MICROSOFT_TENANT_ID?.trim();
    if (tenantId) secrets.MICROSOFT_TENANT_ID = tenantId;
  }
  if (pkgName === "gatekeeper-gitlab") {
    const gitlabUrl = process.env.YRKA_GITLAB_URL?.trim();
    if (gitlabUrl) secrets.GITLAB_URL = gitlabUrl; // not secret, but the same upload channel
  }
  if (clientId && clientSecret) {
    secrets.CLIENT_ID = clientId;
    secrets.CLIENT_SECRET = clientSecret;
    return secrets;
  }
  if (clientId || clientSecret) {
    throw new Error(`YRKA_${vendor}_CLIENT_ID and YRKA_${vendor}_CLIENT_SECRET must be set ` +
        `together: they are one OAuth app, and ${pkgName} refuses to start a flow with half of it.`);
  }
  console.warn(`YRKA_${vendor}_CLIENT_ID is unset: ${pkgName} deploys unconfigured, and ` +
      "connecting it will fail until its secrets are uploaded.");
  return Object.keys(secrets).length > 0 ? secrets : undefined;
}

// --- the deployment --------------------------------------------------------------------------

interface Resolved {
  accountId: string;
  baseUrl: string;
  /** The custom-domain hostname the router serves, when YRKA_PUBLIC_BASE_URL names one. */
  customDomain: string | null;
  packages: DeployablePackage[];
  gatekeepers: string[];
  internal: string[];
  workers: string[];
}

async function resolveDeployment(): Promise<Resolved> {
  const accountId = resolveYrkaTarget();
  const gatekeepers = resolveYrkaGatekeepers();
  const packages = readDeployablePackages(PACKAGES_DIR);
  const internal = internalWorkersFor(packages, gatekeepers);
  const workers = [...internal, ...gatekeepers, "workshop-backend", "router"];
  // resolveYrkaOrigin needs YRKA_PUBLIC_BASE_URL or YRKA_WORKERS_DEV_HOST; with neither set,
  // fall back to reading the subdomain from the API (the `deploy`/`config`/`verify` paths,
  // which are allowed to touch the account; `plan` resolves its origin below without network).
  let baseUrl: string;
  try {
    baseUrl = resolveYrkaOrigin();
  } catch {
    const host = await fetchWorkersDevHost(accountId);
    baseUrl = `https://router.${host}`;
  }
  const customDomain = customDomainForYrkaOrigin();
  if (customDomain && new URL(baseUrl).hostname !== customDomain) {
    throw new Error(`YRKA_PUBLIC_BASE_URL is inconsistent: the origin is ${baseUrl} but its ` +
        `hostname is not the custom domain ${customDomain}.`);
  }
  return { accountId, baseUrl, customDomain, packages, gatekeepers, internal, workers };
}

/** Generate and write every chosen worker's wrangler.yrka.jsonc. */
async function writeConfigs(resolved: Resolved, resources: ProvisionedResources): Promise<void> {
  const configs: Map<string, YrkaConfig> = buildYrkaConfigs({
    packages: resolved.packages,
    accountId: resolved.accountId,
    baseUrl: resolved.baseUrl,
    gatekeepers: resolved.gatekeepers,
    kvIds: resources.kvIds,
    r2Names: resources.r2Names,
    customDomainHostname: resolved.customDomain,
  });
  for (const pkg of resolved.packages) {
    const config = configs.get(pkg.name);
    if (config) {
      writeYrkaConfig(pkg.dir, config);
      console.log(`generated: ${join(pkg.dir, YRKA_CONFIG_NAME)}`);
    }
  }
}

/** Fail before touching the account when required secrets are missing or half-set. */
function assertSecretsReady(resolved: Resolved): void {
  backendSecrets({}); // throws on missing/invalid ADMINS or a half Access pair
  for (const pkg of resolved.gatekeepers) gatekeeperSecrets(pkg);
}

// The frontend's auth mode is a build-time flag (workshop-frontend/src/useAuth.ts): a build
// with VITE_CF_ACCESS_MODE=true has no local login — the SPA authenticates through the backend's
// CF Access JWT check, which rejects every password. The flag must match what the backend is
// deployed with (the YRKA_CF_ACCESS_AUD/ISS pair): a frontend built for passwords on an
// Access-mode backend serves a login form the backend refuses every password from, and the
// mirror image locks an Access-mode frontend out of a password-mode backend.
async function buildWorkspace(skipBuild: boolean): Promise<void> {
  if (skipBuild) {
    console.log("--skip-build: reusing the existing build");
    return;
  }
  const accessMode = cfAccessMode() ? "true" : "false";
  const result = await run("pnpm", ["run", "build"],
      { cwd: ROOT, env: { ...process.env, VITE_CF_ACCESS_MODE: accessMode } });
  if (result.status !== 0) throw new Error(`pnpm run build failed with exit code ${result.status}`);
}

async function deployWorker(pkg: DeployablePackage, secrets: Record<string, string> | undefined): Promise<void> {
  await runOrThrow(pkg, ["deploy", "-c", YRKA_CONFIG_NAME]);
  // After the worker's own deploy, not before: `secret bulk` targets a worker, and the
  // secrets-less window is unreachable (see the header comment's tier ordering).
  if (secrets) await runOrThrow(pkg, ["secret", "bulk", "-c", YRKA_CONFIG_NAME], JSON.stringify(secrets));
}

function pkgByName(resolved: Resolved, name: string): DeployablePackage {
  const pkg = resolved.packages.find((p) => p.name === name);
  if (!pkg) throw new Error(`missing deployable package: ${name}`);
  return pkg;
}

async function deploy({ skipBuild }: { skipBuild: boolean }): Promise<void> {
  const resolved = await resolveDeployment();
  assertSecretsReady(resolved);
  const resources = await provisionResources(resolved.accountId, resolved.workers);
  await writeConfigs(resolved, resources);
  await buildWorkspace(skipBuild);

  for (const name of resolved.internal) {
    await deployWorker(pkgByName(resolved, name), undefined);
  }
  for (const name of resolved.gatekeepers) {
    await deployWorker(pkgByName(resolved, name), gatekeeperSecrets(name));
  }
  await deployWorker(pkgByName(resolved, "workshop-backend"), backendSecrets({}));
  // Last: the router is the only public worker, so nothing is reachable until everything
  // below it is deployed and carrying its secrets.
  await deployWorker(pkgByName(resolved, "router"), undefined);

  console.log(`\nDeployed to account ${resolved.accountId}; the Workshop is live at ${resolved.baseUrl}`);
  console.log("Post-deploy (see the deploy-prep report for the full checklist): sign up the first " +
      "account, add the gateway.yrka.io models in Settings, then disable signups in /admin.");
}

async function plan(): Promise<void> {
  const accountId = resolveYrkaTarget();
  const gatekeepers = resolveYrkaGatekeepers();
  const packages = readDeployablePackages(PACKAGES_DIR);
  const internal = internalWorkersFor(packages, gatekeepers);
  const { kvTitles, r2Names } = yrkaResourcePlan([...internal, ...gatekeepers, "workshop-backend", "router"]);
  console.log(`plan for the YRKA deployment (account ${accountId}):`);
  console.log(`  origin: ${process.env.YRKA_PUBLIC_BASE_URL ?? "https://router.<workers.dev subdomain>"}`);
  const customDomain = customDomainForYrkaOrigin();
  if (customDomain) {
    console.log(`  custom domain: ${customDomain} — the router attaches it (route) and keeps ` +
        "its workers.dev URL; any prior attachment on another worker must be detached first");
  }
  console.log(`  tier 1 (internal): ${internal.join(", ") || "none"}`);
  console.log(`  tier 2 (gatekeepers): ${gatekeepers.join(", ")}`);
  console.log(`  tier 3: workshop-backend — secrets: ADMINS${process.env.YRKA_CF_ACCESS_AUD ? ", CF_ACCESS_AUD, CF_ACCESS_ISS" : ""}${process.env.YRKA_CF_ACCESS_AUD ? ` (auth mode: Cloudflare Access; the frontend builds with VITE_CF_ACCESS_MODE=true)` : ""}`);
  for (const name of gatekeepers) {
    const secrets = gatekeeperSecrets(name);
    console.log(`    ${name}${secrets ? ` — secrets: ${Object.keys(secrets).join(", ")}` : ""}`);
  }
  console.log(`  tier 4: router — serves the frontend, owns the origin`);
  console.log(`  resources to provision: KV ${Object.values(kvTitles).join(", ") || "none"}; ` +
      `R2 ${Object.values(r2Names).join(", ") || "none"}`);
}

async function config(): Promise<void> {
  const resolved = await resolveDeployment();
  const existing = await findExistingResources(resolved.accountId);
  const { kvTitles, r2Names } = yrkaResourcePlan(resolved.workers);
  const missing = [
    ...Object.values(kvTitles).filter((title) => !existing.kvIds[title]),
    ...Object.values(r2Names).filter((name) => !existing.r2Names[name]),
  ];
  if (missing.length > 0) {
    throw new Error(`Not provisioned yet (${missing.join(", ")}): run \`deploy\`, which provisions ` +
        "resources before generating configs.");
  }
  await writeConfigs(resolved, {
    kvIds: Object.fromEntries(Object.entries(kvTitles).map(([binding, title]) => [binding, existing.kvIds[title]])),
    r2Names,
  });
}

async function verify(): Promise<void> {
  const resolved = await resolveDeployment();
  const accessMode = cfAccessMode();
  const frontend = await fetch(resolved.baseUrl, { redirect: "manual" });
  console.log(`GET ${resolved.baseUrl} -> ${frontend.status}`);
  if (accessMode) {
    // Behind a Cloudflare Access application an anonymous request never reaches the Workshop:
    // the gate answers with a redirect to the team's login. That redirect IS the proof the
    // origin is gated (the bare Workshop or an open signup page would be a misconfiguration);
    // the authenticated chain is proven out of band, with an Access service token.
    const location = frontend.headers.get("location") ?? "";
    if (frontend.status >= 300 && frontend.status < 400 && location.includes("cloudflareaccess.com")) {
      console.log("  the Access gate fronts the origin (login redirect).");
    } else {
      throw new Error("Access mode is configured but the origin is not behind the Access gate.");
    }
  } else {
    if (!frontend.ok) throw new Error("The router did not serve the frontend.");
  }
  const api = await fetch(`${resolved.baseUrl}/api`, { redirect: "manual" });
  console.log(`GET ${resolved.baseUrl}/api -> ${api.status}`);
  // Any non-5xx from /api proves the router -> backend service binding chain answers — in
  // Access mode the gate's redirect for an anonymous request, or the backend itself otherwise.
  if (api.status >= 500) throw new Error("The backend answered with a server error.");
  if (resolved.customDomain) {
    // The router keeps its workers.dev URL when a custom domain is attached; a custom-domain
    // deployment must leave it reachable (it is the address the instance was first deployed at,
    // and the one this pipeline derives when YRKA_PUBLIC_BASE_URL is unset).
    const host = await fetchWorkersDevHost(resolved.accountId);
    const workersDev = await fetch(`https://router.${host}`, { redirect: "manual" });
    console.log(`GET https://router.${host} -> ${workersDev.status}`);
    if (!workersDev.ok) throw new Error("The router's workers.dev origin stopped serving.");
  }
  console.log("The instance answers end to end.");
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "plan") await plan();
  else if (args.command === "config") await config();
  else if (args.command === "deploy") await deploy(args);
  else await verify();
} catch (error) {
  console.error(describe(error));
  process.exit(1);
}
