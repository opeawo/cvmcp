import express from "express";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import * as esbuild from "esbuild";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { loadConfig, normalizeCvDomain } from "./config.js";
import { OlaClient } from "./ola-client.js";
import { VercelClient } from "./vercel-client.js";
import { StateStore } from "./state-store.js";

const config = loadConfig();
const ola = new OlaClient({
  baseUrl: config.olaBaseUrl,
  apiToken: config.olaApiToken,
  authPrefix: config.olaAuthPrefix
});
const vercel = config.vercelToken
  ? new VercelClient({ token: config.vercelToken, teamId: config.vercelTeamId })
  : null;
const state = new StateStore(config.stateFilePath);

const requestContext = new AsyncLocalStorage();
const INTERNAL_VISIBILITY = { ui: { visibility: ["app"] } };

function toolText(text) {
  return [{ type: "text", text }];
}

function slugify(input) {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function resolveUserId(req) {
  const byHeader =
    req.header("x-chatgpt-user-id") ||
    req.header("x-user-id") ||
    req.header("x-forwarded-user");
  if (byHeader) return byHeader;

  const bodyMetaUserId = req.body?.params?._meta?.["openai/userId"];
  if (bodyMetaUserId) return String(bodyMetaUserId);

  const sessionId = req.header("mcp-session-id");
  if (sessionId) return `session:${sessionId}`;

  return "anonymous";
}

function currentUserId() {
  return requestContext.getStore()?.userId ?? "anonymous";
}

function getWebsite() {
  return state.getUser(currentUserId()).website;
}

function updateWebsite(updater) {
  return state.updateUser(currentUserId(), (user) => {
    user.website = updater(user.website);
    return user;
  }).website;
}

function ensureVercelConfigured() {
  if (!vercel) {
    throw new Error("Managed hosting is not configured yet. Missing VERCEL_TOKEN.");
  }
}

function nowIso() {
  return new Date().toISOString();
}

function createVersionRecord({ sourceMode, htmlSource = null, reactSource = null, title = null }) {
  return {
    id: randomUUID(),
    sourceMode,
    htmlSource,
    reactSource,
    title,
    createdAt: nowIso()
  };
}

function ensureWebsiteShape(website) {
  if (!website) return null;
  return {
    ...website,
    versions: Array.isArray(website.versions) ? website.versions : [],
    draftVersionId: website.draftVersionId ?? null,
    publishedVersionId: website.publishedVersionId ?? null
  };
}

function getVersionById(website, versionId) {
  const w = ensureWebsiteShape(website);
  return w?.versions?.find((v) => v.id === versionId) ?? null;
}

function getDraftVersion(website) {
  const w = ensureWebsiteShape(website);
  if (!w?.draftVersionId) return null;
  return getVersionById(w, w.draftVersionId);
}

function getPublishedVersion(website) {
  const w = ensureWebsiteShape(website);
  if (!w?.publishedVersionId) return null;
  return getVersionById(w, w.publishedVersionId);
}

function resolveProjectName(displayName = "website") {
  return config.vercelProjectName || `${config.vercelProjectPrefix}-${slugify(displayName) || "website"}`;
}

function domainFromResponse(response) {
  return response?.domain || response?.name || response?.fqdn || response?.data?.domain || null;
}

function availabilityFromResponse(response, domain) {
  const key = String(domain ?? "").toLowerCase();
  const available =
    response?.available ??
    response?.is_available ??
    response?.data?.available ??
    response?.data?.[key]?.available ??
    response?.result?.available ??
    false;

  return Boolean(available);
}

function contactFromResponse(response) {
  return response?.data ?? response ?? null;
}

async function findDomainByName(domainName) {
  const normalized = String(domainName).toLowerCase();
  const result = await ola.listDomains({ perPage: 100, page: 1 });
  const domains = Array.isArray(result?.data) ? result.data : [];
  return domains.find((d) => String(d?.domain ?? "").toLowerCase() === normalized) ?? null;
}

function renderWebsiteHtml(website) {
  const sections = Array.isArray(website?.sections) ? website.sections : [];
  const sectionHtml = sections
    .map((s) => `<li>${String(s).replace(/</g, "&lt;")}</li>`)
    .join("\n");
  const headline = website?.headline ? `<h2>${website.headline}</h2>` : "";
  const bio = website?.bio ? `<p>${website.bio}</p>` : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${website.displayName}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
    .wrap { max-width: 860px; margin: 0 auto; padding: 32px 20px 60px; }
    h1 { margin: 0; font-size: 2.2rem; }
    h2 { margin: 4px 0 18px; color: #334155; font-size: 1.1rem; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-top: 18px; }
    ul { line-height: 1.7; }
  </style>
</head>
<body>
  <main class="wrap">
    <h1>${website.displayName}</h1>
    ${headline}
    <section class="card">
      ${bio}
      ${sectionHtml ? `<ul>${sectionHtml}</ul>` : ""}
    </section>
  </main>
</body>
</html>`;
}

function rewriteBareImportsForBrowser(code) {
  return code
    .replace(/from\s+["']([^"'./][^"']*)["']/g, (_match, specifier) => {
      if (specifier.startsWith("http://") || specifier.startsWith("https://")) {
        return `from "${specifier}"`;
      }
      return `from "https://esm.sh/${specifier}"`;
    })
    .replace(/import\(\s*["']([^"'./][^"']*)["']\s*\)/g, (_match, specifier) => {
      if (specifier.startsWith("http://") || specifier.startsWith("https://")) {
        return `import("${specifier}")`;
      }
      return `import("https://esm.sh/${specifier}")`;
    });
}

async function renderReactSourceToHtml({ source, title = "My Website" }) {
  const rewrittenInput = rewriteBareImportsForBrowser(source);
  let transpiled;
  try {
    transpiled = await esbuild.transform(rewrittenInput, {
      loader: "jsx",
      format: "esm",
      target: "es2020",
      jsx: "automatic"
    });
  } catch (error) {
    throw new Error(`React source compilation failed: ${error.message}`);
  }
  const transpiledModule = rewriteBareImportsForBrowser(transpiled.code);
  const escapedModule = JSON.stringify(transpiledModule);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${String(title).replace(/</g, "&lt;")}</title>
</head>
<body>
  <div id="root"></div>
  <script type="module">
import React from "https://esm.sh/react@18";
import { createRoot } from "https://esm.sh/react-dom@18/client";

const __moduleCode = ${escapedModule};
const __blob = new Blob([__moduleCode], { type: "text/javascript" });
const __url = URL.createObjectURL(__blob);

try {
  const __mod = await import(__url);
  const __component =
    __mod.default ??
    __mod.App ??
    Object.values(__mod).find((v) => typeof v === "function") ??
    null;

  if (!__component) {
    throw new Error("No React component export found. Export a default component.");
  }

  const __root = createRoot(document.getElementById("root"));
  __root.render(React.createElement(__component));
} finally {
  URL.revokeObjectURL(__url);
}
  </script>
</body>
</html>`;
}

async function publishWebsiteInternal(website) {
  ensureVercelConfigured();
  const projectName = config.vercelProjectName || website.projectName || resolveProjectName(website.displayName);

  await vercel.createProjectIfMissing(projectName, config.vercelDefaultRegion);
  const deployment = await vercel.deployStaticHtml({ projectName, html: routerShellHtml() });

  let domainStatus = null;
  if (website.domain) {
    const domain = website.domain;
    try {
      domainStatus = await vercel.getDomainStatus(projectName, domain);
    } catch (error) {
      const notFound = String(error.message).toLowerCase().includes("not found");
      if (!notFound) {
        throw error;
      }

      try {
        await vercel.attachDomain(projectName, domain);
      } catch (attachError) {
        const msg = String(attachError.message).toLowerCase();
        const transferable =
          msg.includes("already") ||
          msg.includes("in use") ||
          msg.includes("another project") ||
          msg.includes("assigned");

        if (!transferable) {
          throw attachError;
        }

        const projects = await vercel.listProjects();
        for (const p of projects) {
          if (!p?.name || p.name === projectName) continue;
          try {
            const domains = await vercel.listProjectDomains(p.name);
            if (domains.some((d) => String(d?.name).toLowerCase() === String(domain).toLowerCase())) {
              await vercel.removeDomain(p.name, domain);
            }
          } catch {
            // Ignore unrelated project/domain errors during transfer scan.
          }
        }

        await vercel.attachDomain(projectName, domain);
      }

      domainStatus = await vercel.getDomainStatus(projectName, domain);
    }
  }

  const deploymentUrl = deployment?.url ? `https://${deployment.url}` : `https://${projectName}.vercel.app`;
  const liveUrl = website.domain ? `https://${website.domain}` : deploymentUrl;

  const updated = updateWebsite((current) => ({
    ...current,
    projectName,
    latestDeploymentId: deployment?.id ?? current?.latestDeploymentId ?? null,
    latestDeploymentUrl: deploymentUrl,
    websiteUrl: liveUrl,
    lastPublishedAt: new Date().toISOString(),
    domainVerified: Boolean(domainStatus?.verified),
    status: domainStatus?.verified === false ? "pending_dns" : "published"
  }));

  return { website: updated, deployment, domainStatus };
}

async function promoteDraftToPublished() {
  const existing = ensureWebsiteShape(getWebsite());
  if (!existing) {
    throw new Error("No website draft found. Set JSX first with set_my_site_source.");
  }

  let draft = getDraftVersion(existing);
  let draftId = existing.draftVersionId;

  if (!draft) {
    throw new Error("No website draft found. Set JSX first with set_my_site_source.");
  }

  const renderedHtml = await renderVersionToHtml(existing, draft);
  const published = updateWebsite((current) => {
    const shaped = ensureWebsiteShape(current);
    return {
      ...shaped,
      sourceMode: draft.sourceMode,
      htmlSource: draft.sourceMode === "html" ? draft.htmlSource : null,
      reactSource: draft.sourceMode === "react" ? draft.reactSource : null,
      publishedVersionId: draftId,
      versions: (shaped.versions || []).map((v) =>
        v.id === draftId
          ? { ...v, renderedHtml, publishedAt: nowIso() }
          : v
      )
    };
  });

  return { published, draftId };
}

async function renderVersionToHtml(website, version) {
  if (!version) {
    return renderWebsiteHtml(website);
  }

  if (version.sourceMode === "html") {
    return version.htmlSource;
  }

  if (version.sourceMode === "react") {
    return renderReactSourceToHtml({
      source: version.reactSource,
      title: version.title || website.displayName || "My Website"
    });
  }

  if (version.sourceMode === "generated") {
    return version.htmlSource || renderWebsiteHtml(website);
  }

  return renderWebsiteHtml(website);
}

function routerShellHtml() {
  const apiBase = process.env.PUBLIC_API_BASE_URL || "https://dotcvmcp.up.railway.app";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Website</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; }
    #appFrame { border: 0; width: 100vw; height: 100vh; display: block; }
    #fallback { font-family: Arial, sans-serif; padding: 24px; }
  </style>
</head>
<body>
  <iframe id="appFrame" title="website"></iframe>
  <div id="fallback" style="display:none">No published content found for this domain yet.</div>
  <script>
    (async () => {
      const host = window.location.hostname;
      const res = await fetch("${apiBase}/site-content?domain=" + encodeURIComponent(host));
      if (!res.ok) {
        document.getElementById("appFrame").style.display = "none";
        document.getElementById("fallback").style.display = "block";
        return;
      }
      const payload = await res.json();
      if (!payload || !payload.html) {
        document.getElementById("appFrame").style.display = "none";
        document.getElementById("fallback").style.display = "block";
        return;
      }
      const iframe = document.getElementById("appFrame");
      iframe.srcdoc = payload.html;
    })();
  </script>
</body>
</html>`;
}

const contactSchema = z.object({
  name: z.string().min(1).describe("Contact full name"),
  email: z.string().email().describe("Contact email address"),
  phone: z.string().min(3).describe("Contact phone number"),
  fax: z.string().optional().describe("Optional contact fax number"),
  organization: z.string().optional().describe("Optional contact organization"),
  address: z.string().min(1).describe("Street or physical address"),
  city: z.string().min(1).describe("City"),
  state: z.string().optional().describe("Optional state or province"),
  postcode: z.string().min(1).describe("Postal code"),
  country: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/)
    .describe("2-letter ISO country code like US, GB, NG")
});

function createMcpServer() {
  const server = new McpServer({ name: "olacv-domains", version: "0.2.0" });

  registerAppTool(
    server,
    "set_my_site_source",
    {
      title: "Set my site source",
      description: "Save your website source as full React JSX module code.",
      inputSchema: z.object({
        component_jsx: z.string().min(10).describe("Full React module source (.jsx) with a default component export"),
        title: z.string().optional().describe("Optional browser page title override")
      }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "Saving site source...",
        "openai/toolInvocation/invoked": "Site source saved."
      }
    },
    async ({ component_jsx, title }) => {
      if (component_jsx.length > 2_000_000) {
        throw new Error("React source is too large. Keep it under 2MB.");
      }

      if (/<html[\s>]/i.test(component_jsx) || /<!doctype\s+html/i.test(component_jsx)) {
        throw new Error("This builder accepts JSX only. Provide a React component module, not raw HTML.");
      }

      const existing = ensureWebsiteShape(getWebsite());
      const displayName = (title || existing?.displayName || "Website").trim();
      const projectName = existing?.projectName || resolveProjectName(displayName);
      const source = component_jsx.trim();

      const version = createVersionRecord({
        sourceMode: "react",
        reactSource: source,
        title: title ?? existing?.displayName ?? "Website"
      });

      updateWebsite((current) => {
        const shaped = ensureWebsiteShape(current);
        if (!shaped) {
          return {
            displayName,
            headline: "",
            bio: "",
            sections: [],
            style: "classic",
            sourceMode: "react",
            htmlSource: null,
            reactSource: source,
            projectName,
            latestDeploymentId: null,
            latestDeploymentUrl: null,
            websiteUrl: null,
            domain: null,
            domainVerified: false,
            lastPublishedAt: null,
            status: "react_source_set",
            versions: [version],
            draftVersionId: version.id,
            publishedVersionId: null
          };
        }

        return {
          ...shaped,
          displayName,
          sourceMode: "react",
          reactSource: source,
          htmlSource: null,
          status: "react_source_set",
          versions: [...(shaped.versions || []), version],
          draftVersionId: version.id
        };
      });

      return {
        structuredContent: {
          status: "saved",
          source_mode: "react",
          bytes: source.length,
          draft_version_id: version.id
        },
        content: toolText("Site JSX saved. Call publish_my_website to compile and deploy.")
      };
    }
  );

  registerAppTool(
    server,
    "publish_my_website",
    {
      title: "Publish my website",
      description: "Publish your website and verify its live status.",
      inputSchema: z.object({ confirm_publish: z.boolean() }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "Publishing your website...",
        "openai/toolInvocation/invoked": "Website publish complete."
      }
    },
    async ({ confirm_publish }) => {
      if (!confirm_publish) {
        return {
          structuredContent: { requires_confirmation: true },
          content: toolText("Publish not executed. Confirm publish to continue.")
        };
      }

      const { published: promoted, draftId } = await promoteDraftToPublished();
      const { website: published } = await publishWebsiteInternal(promoted);
      return {
        structuredContent: {
          status: published.status,
          website_url: published.latestDeploymentUrl,
          domain_url: published.domain ? `https://${published.domain}` : null,
          source_mode: published.sourceMode ?? "react",
          draft_version_id: draftId ?? null,
          published_version_id: published.publishedVersionId ?? null,
          message: published.domain && !published.domainVerified ? "Domain linked, waiting for DNS propagation." : "Website is published."
        },
        content: toolText(
          published.domain
            ? published.domainVerified
              ? `Your website is live at https://${published.domain}.`
              : `Website published. Domain ${published.domain} is linked and waiting for DNS propagation.`
            : `Your website is live at ${published.latestDeploymentUrl}.`
        )
      };
    }
  );

  registerAppTool(
    server,
    "set_my_domain",
    {
      title: "Set my domain",
      description: "Register and connect your .cv domain to your website in one step.",
      inputSchema: z.object({
        domain: z.string(),
        contact: contactSchema,
        confirm_purchase: z.boolean()
      }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "Setting up your domain...",
        "openai/toolInvocation/invoked": "Domain setup complete."
      }
    },
    async ({ domain, contact, confirm_purchase }) => {
      if (!confirm_purchase) {
        return {
          structuredContent: { requires_confirmation: true, action: "set_domain", domain },
          content: toolText("Domain setup not executed. Confirm purchase to continue.")
        };
      }

      ensureVercelConfigured();
      const normalized = normalizeCvDomain(domain);
      const ownerCheck = state.findWebsiteByDomain(normalized);
      if (ownerCheck && ownerCheck.userId !== currentUserId()) {
        throw new Error(`${normalized} is already connected to another user website.`);
      }
      let website = ensureWebsiteShape(getWebsite());
      if (!website) {
        throw new Error("No website source found. Call set_my_site_source first.");
      }

      const existingDomain = await findDomainByName(normalized);
      if (!existingDomain) {
        const check = await ola.checkDomain(normalized);
        const available = availabilityFromResponse(check, normalized);
        if (!available) {
          throw new Error(`${normalized} is not available and not present in this account.`);
        }

        const createdContact = await ola.createContact({
          ...contact,
          country: contact.country.toUpperCase()
        });
        const createdContactId = contactFromResponse(createdContact)?.id;
        if (!createdContactId) {
          throw new Error("Failed to create contact for domain registration.");
        }

        await ola.registerDomain({
          domain: normalized,
          years: config.defaultRegistrationYears,
          registrantContactId: createdContactId,
          autoRenew: false,
          nameservers: ["ns1.vercel-dns.com", "ns2.vercel-dns.com"]
        });
      }

      website = updateWebsite((current) => ({
        ...current,
        domain: normalized,
        status: "domain_set"
      }));

      const { published: promoted } = await promoteDraftToPublished();
      const { website: published, domainStatus } = await publishWebsiteInternal(promoted);
      const connected = Boolean(domainStatus?.verified);

      return {
        structuredContent: {
          status: connected ? "connected" : "pending",
          domain: normalized,
          live_url: `https://${normalized}`,
          website_url: published.latestDeploymentUrl,
          message: connected ? "Domain is connected." : "Domain connected, waiting for DNS propagation."
        },
        content: toolText(
          connected
            ? `Done. Your website is connected to ${normalized}.`
            : `Domain ${normalized} is connected. It may take a little time to propagate globally.`
        )
      };
    }
  );

  registerAppTool(
    server,
    "my_website_status",
    {
      title: "My website status",
      description: "Check your website/domain live status.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "Checking your website status...",
        "openai/toolInvocation/invoked": "Status ready."
      }
    },
    async () => {
      const website = ensureWebsiteShape(getWebsite());
      if (!website) {
        return {
          structuredContent: {
          website_exists: false,
            message: "No website source yet."
          },
          content: toolText("No site source yet. Call set_my_site_source with JSX first.")
        };
      }

      let domainVerified = website.domainVerified;
      if (website.domain && vercel) {
        try {
          const status = await vercel.getDomainStatus(website.projectName, website.domain);
          domainVerified = Boolean(status?.verified);
          updateWebsite((current) => ({ ...current, domainVerified }));
        } catch {
          // Keep last known status if API is temporarily unavailable.
        }
      }

      return {
        structuredContent: {
          website_exists: true,
          website_url: website.latestDeploymentUrl,
          domain: website.domain,
          source_mode: website.sourceMode ?? "react",
          draft_version_id: website.draftVersionId ?? null,
          published_version_id: website.publishedVersionId ?? null,
          domain_connected: Boolean(website.domain),
          ssl_ready: Boolean(domainVerified),
          last_published_at: website.lastPublishedAt,
          message: website.domain
            ? domainVerified
              ? "Website and domain are live."
              : "Website is live. Domain is connected and propagating."
            : "Website exists without a custom domain."
        },
        content: toolText(
          website.domain
            ? domainVerified
              ? `Your site is live at https://${website.domain}.`
              : `Your site is published. ${website.domain} is still propagating.`
            : `Your site is published at ${website.latestDeploymentUrl ?? "(not published yet)"}.`
        )
      };
    }
  );

  // Internal provider-level tools (kept for backend compatibility, hidden from model).
  registerAppTool(
    server,
    "check_domain",
    {
      title: "Check .cv domain availability (internal)",
      description: "Internal provider tool.",
      inputSchema: z.object({ domain: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: { ui: INTERNAL_VISIBILITY.ui }
    },
    async ({ domain }) => {
      const normalized = normalizeCvDomain(domain);
      const result = await ola.checkDomain(normalized);
      return {
        structuredContent: { domain: normalized, available: availabilityFromResponse(result, normalized), raw: result },
        content: toolText("OK")
      };
    }
  );

  registerAppTool(
    server,
    "register_domain",
    {
      title: "Register domain (internal)",
      description: "Internal provider tool.",
      inputSchema: z.object({
        domain: z.string(),
        registrant_contact_id: z.string(),
        confirm_purchase: z.boolean(),
        years: z.number().int().min(1).max(10).optional(),
        auto_renew: z.boolean().optional(),
        nameservers: z.array(z.string()).optional()
      }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: { ui: INTERNAL_VISIBILITY.ui }
    },
    async ({ domain, registrant_contact_id, confirm_purchase, years, auto_renew, nameservers }) => {
      if (!confirm_purchase) {
        return { structuredContent: { requires_confirmation: true }, content: toolText("Confirmation required") };
      }
      const normalized = normalizeCvDomain(domain);
      const result = await ola.registerDomain({
        domain: normalized,
        registrantContactId: registrant_contact_id,
        years: years ?? config.defaultRegistrationYears,
        autoRenew: auto_renew ?? false,
        nameservers
      });
      return { structuredContent: { domain: domainFromResponse(result) ?? normalized, raw: result }, content: toolText("OK") };
    }
  );

  registerAppTool(
    server,
    "list_domains",
    {
      title: "List domains (internal)",
      description: "Internal provider tool.",
      inputSchema: z.object({ per_page: z.number().int().min(1).max(100).optional(), page: z.number().int().min(1).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: { ui: INTERNAL_VISIBILITY.ui }
    },
    async ({ per_page, page }) => {
      const result = await ola.listDomains({ perPage: per_page, page });
      return { structuredContent: { raw: result, domains: result?.data ?? [] }, content: toolText("OK") };
    }
  );

  registerAppTool(
    server,
    "renew_domain",
    {
      title: "Renew domain (internal)",
      description: "Internal provider tool.",
      inputSchema: z.object({ domain: z.string(), confirm_renewal: z.boolean(), years: z.number().int().min(1).max(10).optional() }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: { ui: INTERNAL_VISIBILITY.ui }
    },
    async ({ domain, confirm_renewal, years }) => {
      if (!confirm_renewal) {
        return { structuredContent: { requires_confirmation: true }, content: toolText("Confirmation required") };
      }
      const normalized = normalizeCvDomain(domain);
      const domainRecord = await findDomainByName(normalized);
      if (!domainRecord?.id) throw new Error(`Could not find domain id for ${normalized}.`);
      const result = await ola.renewDomain({ domainId: domainRecord.id, years: years ?? config.defaultRenewalYears });
      return { structuredContent: { raw: result }, content: toolText("OK") };
    }
  );

  registerAppTool(
    server,
    "update_dns",
    {
      title: "Update dns (internal)",
      description: "Internal provider tool.",
      inputSchema: z.object({ domain: z.string(), nameservers: z.array(z.string()).min(2), confirm_dns_update: z.boolean() }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: { ui: INTERNAL_VISIBILITY.ui }
    },
    async ({ domain, nameservers, confirm_dns_update }) => {
      if (!confirm_dns_update) {
        return { structuredContent: { requires_confirmation: true }, content: toolText("Confirmation required") };
      }
      const normalized = normalizeCvDomain(domain);
      const domainRecord = await findDomainByName(normalized);
      if (!domainRecord?.id) throw new Error(`Could not find domain id for ${normalized}.`);
      const result = await ola.updateDns({ domainId: domainRecord.id, nameservers });
      return { structuredContent: { raw: result }, content: toolText("OK") };
    }
  );

  registerAppTool(
    server,
    "create_contact",
    {
      title: "Create contact (internal)",
      description: "Internal provider tool.",
      inputSchema: contactSchema,
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: { ui: INTERNAL_VISIBILITY.ui }
    },
    async (input) => {
      const result = await ola.createContact({ ...input, country: input.country.toUpperCase() });
      return { structuredContent: { contact: contactFromResponse(result), raw: result }, content: toolText("OK") };
    }
  );

  registerAppTool(
    server,
    "list_contacts",
    {
      title: "List contacts (internal)",
      description: "Internal provider tool.",
      inputSchema: z.object({ per_page: z.number().int().min(1).max(100).optional(), page: z.number().int().min(1).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: { ui: INTERNAL_VISIBILITY.ui }
    },
    async ({ per_page, page }) => {
      const result = await ola.listContacts({ perPage: per_page, page });
      return { structuredContent: { contacts: result?.data ?? [], raw: result }, content: toolText("OK") };
    }
  );

  registerAppTool(
    server,
    "fetch_contact",
    {
      title: "Fetch contact (internal)",
      description: "Internal provider tool.",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: { ui: INTERNAL_VISIBILITY.ui }
    },
    async ({ id }) => {
      const result = await ola.fetchContact(id);
      return { structuredContent: { contact: contactFromResponse(result), raw: result }, content: toolText("OK") };
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

const sessions = new Map();

async function getOrCreateSession(req) {
  const sessionId = req.header("mcp-session-id");
  if (sessionId && sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, server });
    }
  });

  const server = createMcpServer();

  transport.onclose = async () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
    await server.close();
  };

  await server.connect(transport);
  return { transport, server };
}

app.post("/mcp", async (req, res) => {
  requestContext.run({ userId: resolveUserId(req) }, async () => {
    try {
      const { transport } = await getOrCreateSession(req);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Internal server error"
        },
        id: req.body?.id ?? null
      });
    }
  });
});

app.get("/mcp", async (req, res) => {
  requestContext.run({ userId: resolveUserId(req) }, async () => {
    const sessionId = req.header("mcp-session-id");
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send("Invalid or missing mcp-session-id");
      return;
    }

    await sessions.get(sessionId).transport.handleRequest(req, res);
  });
});

app.delete("/mcp", async (req, res) => {
  requestContext.run({ userId: resolveUserId(req) }, async () => {
    const sessionId = req.header("mcp-session-id");
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send("Invalid or missing mcp-session-id");
      return;
    }

    await sessions.get(sessionId).transport.handleRequest(req, res);
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "olacv-domains", version: "0.2.0" });
});

app.get("/site-content", async (req, res) => {
  const requestedDomain = String(
    req.query.domain || req.header("x-forwarded-host") || req.header("host") || ""
  )
    .toLowerCase()
    .split(":")[0]
    .trim();

  if (!requestedDomain) {
    res.status(400).json({ error: "Missing domain query parameter." });
    return;
  }

  const found = state.findWebsiteByDomain(requestedDomain);
  if (!found?.website) {
    res.status(404).json({ error: "No website mapped for this domain." });
    return;
  }

  const website = ensureWebsiteShape(found.website);
  const publishedVersion = getPublishedVersion(website);
  if (!publishedVersion) {
    res.status(404).json({ error: "No published version for this domain yet." });
    return;
  }

  const html =
    publishedVersion.renderedHtml ||
    (await renderVersionToHtml(website, publishedVersion));

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({
    domain: requestedDomain,
    source_mode: publishedVersion.sourceMode,
    version_id: publishedVersion.id,
    html
  });
});

app.listen(config.port, () => {
  process.stdout.write(`OlaCV MCP server listening on :${config.port}\n`);
});
