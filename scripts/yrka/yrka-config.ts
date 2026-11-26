#!/usr/bin/env node

// Generates a `wrangler.yrka.jsonc` next to every package this fork installs on the YRKA
// Cloudflare account, describing that worker as it runs in the YRKA production deployment.
// The generated files are gitignored (.gitignore, beside `wrangler.staging.jsonc`) — they are
// build output, regenerated on every deploy (scripts/yrka/deploy-yrka.ts).
//
// This is the YRKA counterpart of scripts/preview/staging-config.ts: same deployable packages,
// same binding topology, but a stable production instance rather than a per-PR Worker Preview.
// The differences from the preview generator are all consequences of that:
//
//   - Account pinned to YRKA. The preview generator hardcodes no account because the upstream
//     repository is public; this fork exists to deploy to one account, and a wrong-but-plausible
//     default would deploy to the wrong account only silently. The jami-studio account id is
//     hardcoded as a refusal instead: that account exists to hold Workers AI credits and nothing
//     else, so deploying a Workshop instance to it is never what anyone means.
//   - Concrete KV ids and R2 bucket names, not binding-only entries. The preview baselines use
//     binding-only entries because they are throwaways deployed once; wrangler auto-provisioning
//     on a repeated `wrangler deploy` of the live instance could hand it fresh resources instead
//     of the ones holding its data, so deploy-yrka.ts provisions named `cfos-*` resources once
//     and pins their ids here.
//   - No `previews` block, no `preview_urls`, no draft-wrangler features: plain
//     `wrangler deploy` with released wrangler is the whole deployment path.
//   - A chosen subset of gatekeepers (YRKA_GATEKEEPERS), because a private deployment does not
//     want every vendor connector it does not have OAuth apps for, and two gatekeepers are
//     refused outright (see REFUSED_GATEKEEPERS).
//
// Secrets (the backend's ADMINS and optional Cloudflare Access pair, a gatekeeper's OAuth app
// credentials) are deliberately absent here, as they are absent from the preview configs: wrangler
// prints every plain-text var in its deploy summary, so deploy-yrka.ts uploads them over stdin
// with `wrangler secret bulk`, which prints names and `********`.

import { writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  INTERNAL_WORKERS, gatekeeperShortName, isGatekeeperPackage, readDeployablePackages,
  type BindingDecl, type DeployablePackage, type ServiceBinding, type WranglerConfig,
} from "../release/manifest-lib.ts";
import { gatekeeperBindingName } from "../preview/staging-config.ts";

/**
 * A generated `wrangler.yrka.jsonc`: everything a committed wrangler.jsonc carries, plus the
 * keys that exist only for this deployment. The committed configs carry no account-specific
 * values (the preview ones are added by run-dev-server, the release manifest's by the deploy
 * service), so everything account-specific lands here.
 */
export interface YrkaConfig extends WranglerConfig {
  /** The Cloudflare account the worker deploys to. Always the YRKA account (see resolveYrkaTarget). */
  account_id?: string;
  /** Whether the worker gets a workers.dev hostname. Only the router does. */
  workers_dev?: boolean;
  /**
   * Routes. Deleted on every worker but the router when the origin is a custom domain: a
   * `custom_domain` route is how wrangler attaches YRKA_PUBLIC_BASE_URL's hostname to the router,
   * which otherwise no generated config would own (see customDomainForYrkaOrigin).
   */
  routes?: { pattern: string; custom_domain: boolean }[];
  /** Workers AI binding, injected for the backend (as the release manifest does for every deploy). */
  ai?: BindingDecl;
}

/** The repository root. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The directory holding every deployable package. */
export const PACKAGES_DIR = join(ROOT, "packages");

/** The generated per-package config file name (gitignored — it is build output). */
export const YRKA_CONFIG_NAME = "wrangler.yrka.jsonc";

/**
 * The YRKA Cloudflare account this fork deploys to (verified 2026-11-24 against the live
 * account list: it already runs the agency services; it holds no Workers AI credits, which live
 * on jami-studio — the account below).
 */
export const YRKA_ACCOUNT_ID = "5fda12e0ca49798931b92e6f223d37b6";

/**
 * Accounts a YRKA deploy must refuse outright. jami-studio (verified live: the `keikis-web`
 * worker) is reserved for Workers AI credits; the standing rule for this fork is that a
 * Workshop deployment never lands there, so a refusal here beats a warning nobody reads.
 */
export const FORBIDDEN_ACCOUNT_IDS: ReadonlySet<string> = new Set([
  "c294df364db8742bc02db57c046043ef",
]);

/**
 * The gatekeepers a YRKA deploy installs by default. The three ambient ones minus websearch,
 * plus the two MCP ones, which take no third-party OAuth app (dynamic client registration):
 * a private deployment wants the Context Library, Scheduled Tasks and MCP from day one, and
 * every OAuth gatekeeper is one deliberate add away (YRKA_GATEKEEPERS).
 */
export const DEFAULT_YRKA_GATEKEEPERS = [
  "gatekeeper-context",
  "gatekeeper-scheduler",
  "gatekeeper-mcp",
  "gatekeeper-mcp-portal",
];

/**
 * Gatekeepers no YRKA deploy may install, with the reason. Kept here — refusing in the
 * resolver, rather than leaving the name out of the defaults — so an operator who lists one
 * gets an explanation instead of a silent skip or a deploy that spends money:
 *
 *   - gatekeeper-websearch runs every search on the account's Workers AI binding through its
 *     default AI Gateway and bills per search (docs/public-server.md). Standing rule for this
 *     fork: never use Cloudflare AI Gateway. If searches are ever wanted, route them through
 *     gateway.yrka.io from a hand-written gatekeeper instead.
 *   - gatekeeper-email needs an Email Routing zone (manifest-lib.ts NOT_INSTALLABLE), and the
 *     YRKA origin is a workers.dev URL with no zone.
 */
export const REFUSED_GATEKEEPERS: Readonly<Record<string, string>> = {
  "gatekeeper-websearch":
      "its searches run through the account's default Cloudflare AI Gateway and bill per search; " +
      "this fork's standing rule is to never use Cloudflare AI Gateway.",
  "gatekeeper-email":
      "Email Routing needs a zone, and the YRKA origin is a workers.dev URL.",
};

/**
 * The concrete resources this deployment's workers need, by binding: the KV namespaces as
 * (binding -> title to provision under) and the R2 buckets as (binding -> bucket name). Titles
 * and names carry a `cfos-` prefix rather than the committed configs' `gadgets-` names, so the
 * YRKA account's resource list reads as this deployment's and cannot collide with anything
 * provisioned for the upstream project.
 */
export function yrkaResourcePlan(packages: readonly string[]): {
  kvTitles: Record<string, string>;
  r2Names: Record<string, string>;
} {
  const kvTitles: Record<string, string> = {};
  const r2Names: Record<string, string> = {};
  if (packages.includes("workshop-backend")) {
    kvTitles.BLUEPRINTS = "cfos-blueprint-metadata";
    kvTitles.AVATARS = "cfos-avatars";
    r2Names.BLUEPRINT_CONTENT = "cfos-blueprint-content";
  }
  if (packages.includes("gatekeeper-context")) {
    kvTitles.CONTEXT_COLLECTIONS = "cfos-context-collections";
  }
  return { kvTitles, r2Names };
}

/**
 * The account a YRKA deploy targets. Defaults to the YRKA account — this fork exists to deploy
 * there — and refuses a jami-studio target whatever set it. Any other override requires both
 * the override and a deliberate opt-out env, so a stray variable in a shell cannot quietly
 * redeploy the instance somewhere else.
 */
export function resolveYrkaTarget({
  accountId = process.env.YRKA_ACCOUNT_ID,
  allowOtherAccount = process.env.YRKA_ALLOW_OTHER_ACCOUNT,
}: { accountId?: string; allowOtherAccount?: string } = {}): string {
  const resolved = accountId ?? YRKA_ACCOUNT_ID;
  if (FORBIDDEN_ACCOUNT_IDS.has(resolved)) {
    throw new Error("Refusing to deploy to the jami-studio account: it holds this team's " +
        "Workers AI credits and nothing else. The YRKA deploy target is the yrka account.");
  }
  if (resolved !== YRKA_ACCOUNT_ID && allowOtherAccount !== "i-know-what-i-am-doing") {
    throw new Error(`YRKA_ACCOUNT_ID names ${resolved}, not the yrka account. Set ` +
        "YRKA_ALLOW_OTHER_ACCOUNT=i-know-what-i-am-doing if that is really the intent.");
  }
  return resolved;
}

/**
 * The deployment's public origin. Either an explicit YRKA_PUBLIC_BASE_URL (a custom domain on
 * the router, set up out of band) or the router's workers.dev URL, derived from the account's
 * workers.dev subdomain, which deploy-yrka.ts reads from the Cloudflare API and passes in
 * (YRKA_WORKERS_DEV_HOST) — the generator does no network of its own.
 */
export function resolveYrkaOrigin({
  publicBaseUrl = process.env.YRKA_PUBLIC_BASE_URL,
  workersDevHost = process.env.YRKA_WORKERS_DEV_HOST,
}: { publicBaseUrl?: string; workersDevHost?: string } = {}): string {
  if (publicBaseUrl) return publicBaseUrl.replace(/\/+$/, "");
  if (!workersDevHost) {
    throw new Error("The YRKA origin is unknown: set YRKA_PUBLIC_BASE_URL, or " +
        "YRKA_WORKERS_DEV_HOST (the account's workers.dev subdomain, which deploy-yrka.ts " +
        "reads from the Cloudflare API when it runs).");
  }
  // YRKA_WORKERS_DEV_HOST carries what the API's subdomain endpoint returns — the bare account
  // subdomain, no ".workers.dev" — so the suffix is appended here rather than trusted from the
  // value. A host that already ends in .workers.dev passes through unchanged.
  const host = workersDevHost.endsWith(".workers.dev")
      ? workersDevHost
      : `${workersDevHost}.workers.dev`;
  return `https://router.${host}`;
}

/**
 * The custom-domain hostname the router serves alongside its workers.dev URL, or null. Set only
 * when YRKA_PUBLIC_BASE_URL names a zone hostname (not a workers.dev one): the attachment is made
 * by `wrangler deploy` from the route this generator writes for the router, so the origin the
 * other vars carry and the hostname traffic actually reaches can never drift apart. The DNS
 * record and any prior attachment (another worker's custom domain) are arranged out of band —
 * wrangler refuses to attach a hostname that is still attached elsewhere.
 */
export function customDomainForYrkaOrigin({
  publicBaseUrl = process.env.YRKA_PUBLIC_BASE_URL,
}: { publicBaseUrl?: string } = {}): string | null {
  if (!publicBaseUrl) return null;
  const hostname = new URL(publicBaseUrl).hostname;
  return hostname.endsWith(".workers.dev") ? null : hostname;
}

/**
 * The gatekeepers this deploy installs, from YRKA_GATEKEEPERS or the defaults. Validated
 * against the deployable packages (a typo would otherwise deploy a half-wired instance whose
 * backend binds a worker that does not exist) and against REFUSED_GATEKEEPERS, with each
 * refusal's reason in the error.
 */
export function resolveYrkaGatekeepers({
  configured = process.env.YRKA_GATEKEEPERS,
}: { configured?: string } = {}): string[] {
  const listed = (configured ?? DEFAULT_YRKA_GATEKEEPERS.join(","))
      .split(",").map((name) => name.trim()).filter(Boolean);
  const deployable = new Set(readDeployablePackages(PACKAGES_DIR).map((pkg) => pkg.name));
  const gatekeepers: string[] = [];
  for (const name of listed) {
    if (!isGatekeeperPackage(name) || !deployable.has(name)) {
      throw new Error(`YRKA_GATEKEEPERS lists "${name}", which is not a deployable gatekeeper.`);
    }
    const refusal = REFUSED_GATEKEEPERS[name];
    if (refusal) throw new Error(`Refusing to install ${name}: ${refusal}`);
    if (!gatekeepers.includes(name)) gatekeepers.push(name);
  }
  if (gatekeepers.length === 0) throw new Error("YRKA_GATEKEEPERS is empty.");
  return gatekeepers.toSorted();
}

/**
 * The internal workers the chosen gatekeepers make necessary, derived from what each chosen
 * gatekeeper's committed wrangler.jsonc actually binds (today: gatekeeper-google binds
 * pdf-renderer for Drive PDF reading) rather than a second list that could drift from the
 * configs. An internal worker nothing binds is still harmless to deploy, so a superset
 * (YRKA_GATEKEEPERS adding google later) is fine; a missing one would leave the gatekeeper
 * binding a nonexistent worker, which buildYrkaConfigs' chosen-set check catches.
 */
export function internalWorkersFor(
  packages: readonly DeployablePackage[],
  gatekeepers: readonly string[],
): string[] {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg.config]));
  const internal = new Set<string>();
  for (const gatekeeper of gatekeepers) {
    for (const service of byName.get(gatekeeper)?.services ?? []) {
      if (INTERNAL_WORKERS.has(service.service)) internal.add(service.service);
    }
  }
  return [...internal].toSorted();
}

// How the backend calls gatekeepers: the GatekeeperVendor RPC entrypoint, with the Context
// gatekeeper's sharingDomain prop (the instance's own origin, as the release manifest's
// $PUBLIC_BASE_URL template does for customer instances).
function backendGatekeeperServices(gatekeepers: readonly string[], baseUrl: string): ServiceBinding[] {
  return gatekeepers.map((pkgName) => ({
    binding: gatekeeperBindingName(pkgName),
    service: pkgName,
    entrypoint: "GatekeeperVendor",
    ...(pkgName === "gatekeeper-context" ? { props: { sharingDomain: baseUrl } } : {}),
  }));
}

// How the router calls gatekeepers: the default entrypoint, since it forwards whole HTTP
// requests rather than making vendor RPC calls.
function routerGatekeeperServices(gatekeepers: readonly string[]): ServiceBinding[] {
  return gatekeepers.map((pkgName) => ({
    binding: gatekeeperBindingName(pkgName),
    service: pkgName,
  }));
}

/**
 * Build the configs for every worker this deploy installs. Pure: `packages` is the parsed
 * wrangler.jsonc of every deployable package, `resources` the provisioned KV ids and R2 bucket
 * names (see yrkaResourcePlan), and the result a Map from package name to its YRKA config.
 *
 * Every resource binding the chosen set needs must have a provisioned id here: a missing one
 * fails the config generation rather than letting wrangler auto-provision a fresh namespace or
 * bucket the instance's data would then live in unnamed and unrepeatable (the preview baselines
 * accept exactly that because they are throwaways; this instance is not).
 */
export function buildYrkaConfigs({
  packages, accountId, baseUrl, gatekeepers, kvIds, r2Names, customDomainHostname,
}: {
  packages: readonly DeployablePackage[];
  accountId: string;
  baseUrl: string;
  gatekeepers: readonly string[];
  kvIds: Record<string, string>;
  r2Names: Record<string, string>;
  customDomainHostname?: string | null;
}): Map<string, YrkaConfig> {
  const internal = internalWorkersFor(packages, gatekeepers);
  const chosen = new Set([...internal, ...gatekeepers, "workshop-backend", "router"]);
  const configs = new Map<string, YrkaConfig>();

  for (const pkg of packages) {
    if (!chosen.has(pkg.name)) continue;
    const config: YrkaConfig = structuredClone(pkg.config);
    if (config.name !== pkg.name) {
      // Same check as the preview generator: every URL and service binding here is derived
      // from the package directory name, so a worker whose own name diverges from it would be
      // silently misconfigured rather than merely renamed.
      throw new Error(`${pkg.name}/wrangler.jsonc declares worker name "${config.name}"; the ` +
          "YRKA generator requires them to match");
    }

    // Stated rather than left to defaults, so reachability never depends on a default changing
    // or on what the dashboard was last toggled to — a deploy overwrites the dashboard value
    // either way. Only the router is public; everything else is reached over service bindings.
    // The router keeps its workers.dev URL when a custom domain is attached, so the URL the
    // deployment was first reached at never breaks.
    Object.assign(config, {
      name: pkg.name,
      account_id: accountId,
      workers_dev: pkg.name === "router",
    });
    // The router owns the custom domain (its route attaches the hostname to the router); every
    // other worker stays hostname-less, reached only through service bindings.
    if (pkg.name === "router" && customDomainHostname) {
      config.routes = [{ pattern: customDomainHostname, custom_domain: true }];
    } else {
      delete config.routes;
    }

    // Concrete resource ids: binding-only entries are for wrangler to provision, which is what
    // the preview baselines want and this instance does not (see buildYrkaConfigs doc comment).
    config.kv_namespaces = (config.kv_namespaces ?? []).map((kv) => {
      const id = kvIds[kv.binding];
      if (!id) throw new Error(`No provisioned KV namespace for ${pkg.name}'s ${kv.binding}.`);
      return { binding: kv.binding, id };
    });
    config.r2_buckets = (config.r2_buckets ?? []).map((r2) => {
      const bucketName = r2Names[r2.binding];
      if (!bucketName) throw new Error(`No provisioned R2 bucket for ${pkg.name}'s ${r2.binding}.`);
      return { binding: r2.binding, bucket_name: bucketName };
    });

    if (isGatekeeperPackage(pkg.name)) {
      config.vars = {
        ...config.vars,
        // Mounted under the router's origin, exactly as the release manifest templates it for
        // customer instances ($PUBLIC_BASE_URL/gatekeeper/<short>).
        BASE_URL: `${baseUrl}/gatekeeper/${gatekeeperShortName(pkg.name)}`,
      };
    } else if (pkg.name === "workshop-backend") {
      // Injected rather than read from wrangler.jsonc, mirroring what manifest-lib.ts hardcodes
      // for every deployed backend: webFetch's document-to-Markdown conversion depends on it.
      // On the YRKA account the binding covers the free toMarkdown conversions; the chat models
      // never ride it (they are user-added models pointed at gateway.yrka.io — see the deploy
      // prep report at /data/workspace/research/cfos-deploy-prep.md; no CF_AI_GATEWAY* vars are
      // set, so AI Gateway mode is off and no request touches Cloudflare AI Gateway).
      config.ai = { binding: "WORKERS_AI" };
      config.services = backendGatekeeperServices(gatekeepers, baseUrl);
      // The origin is the only value the backend needs that is safe to write down here: ADMINS
      // and the optional Cloudflare Access pair are uploaded as secrets instead (deploy-yrka.ts).
      config.vars = { ...config.vars, PUBLIC_BASE_URL: baseUrl };
    } else if (pkg.name === "router") {
      config.services = [
        { binding: "WORKSHOP_BACKEND", service: "workshop-backend" },
        ...routerGatekeeperServices(gatekeepers),
      ];
    }
    // Internal workers (pdf-renderer) are told nothing of the instance: no origin, no mount,
    // no resources — reached only through the bindings of the workers deployed after them.

    configs.set(pkg.name, config);
  }

  for (const expected of chosen) {
    if (!configs.has(expected)) {
      throw new Error(`no YRKA config was generated for ${expected}; the chosen set names a ` +
          "package readDeployablePackages did not find");
    }
  }
  return configs;
}

/** Write one package's generated config to its `wrangler.yrka.jsonc`. */
export function writeYrkaConfig(pkgDir: string, config: YrkaConfig): void {
  writeFileSync(join(pkgDir, YRKA_CONFIG_NAME), JSON.stringify(config, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error("Run scripts/yrka/deploy-yrka.ts instead: it provisions the resources these " +
      "configs pin, then generates them.");
  process.exit(1);
}
