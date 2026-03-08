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

function extractDefaultComponentName(source) {
  const match = source.match(/export\s+default\s+function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (match?.[1]) return match[1];

  const exprMatch = source.match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;/);
  if (exprMatch?.[1]) return exprMatch[1];

  return "App";
}

async function renderReactSourceToHtml({ source, title = "My Website" }) {
  const rewritten = rewriteBareImportsForBrowser(source);
  const componentName = extractDefaultComponentName(source);

  const entry = `
import React from "https://esm.sh/react@18";
import { createRoot } from "https://esm.sh/react-dom@18/client";
${rewritten}

const __Component =
  typeof ${componentName} !== "undefined"
    ? ${componentName}
    : (typeof App !== "undefined" ? App : null);

if (!__Component) {
  throw new Error("Could not locate default React component export.");
}

const __root = createRoot(document.getElementById("root"));
__root.render(React.createElement(__Component));
`;

  let transpiled;
  try {
    transpiled = await esbuild.transform(entry, {
      loader: "jsx",
      format: "esm",
      target: "es2020"
    });
  } catch (error) {
    throw new Error(`React source compilation failed: ${error.message}`);
  }

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
${transpiled.code}
  </script>
</body>
</html>`;
}

async function resolveWebsiteHtml({ html, website_file }) {
  if (typeof html === "string" && html.trim()) {
    return html;
  }

  if (website_file?.download_url) {
    const response = await fetch(website_file.download_url);
    if (!response.ok) {
      throw new Error(`Failed to download uploaded file (${response.status}).`);
    }
    const text = await response.text();
    return text;
  }

  throw new Error("Provide html content or an uploaded website_file.");
}

async function publishWebsiteInternal(website) {
  ensureVercelConfigured();

  await vercel.createProjectIfMissing(website.projectName, config.vercelDefaultRegion);
  let html = renderWebsiteHtml(website);
  if (website?.sourceMode === "html" && website?.htmlSource) {
    html = website.htmlSource;
  } else if (website?.sourceMode === "react" && website?.reactSource) {
    html = await renderReactSourceToHtml({
      source: website.reactSource,
      title: website.displayName || "My Website"
    });
  }
  const deployment = await vercel.deployStaticHtml({ projectName: website.projectName, html });

  let domainStatus = null;
  if (website.domain) {
    try {
      await vercel.attachDomain(website.projectName, website.domain);
    } catch (error) {
      if (!String(error.message).toLowerCase().includes("already")) {
        throw error;
      }
    }
    domainStatus = await vercel.getDomainStatus(website.projectName, website.domain);
  }

  const deploymentUrl = deployment?.url ? `https://${deployment.url}` : null;
  const liveUrl = website.domain ? `https://${website.domain}` : deploymentUrl;

  const updated = updateWebsite((current) => ({
    ...current,
    latestDeploymentId: deployment?.id ?? current?.latestDeploymentId ?? null,
    latestDeploymentUrl: deploymentUrl,
    websiteUrl: liveUrl,
    lastPublishedAt: new Date().toISOString(),
    domainVerified: Boolean(domainStatus?.verified),
    status: domainStatus?.verified === false ? "pending_dns" : "published"
  }));

  return { website: updated, deployment, domainStatus };
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
    "create_my_website",
    {
      title: "Create my website",
      description: "Create your personal website. Each user can have one website.",
      inputSchema: z.object({
        display_name: z.string().min(2),
        headline: z.string().optional(),
        bio: z.string().optional(),
        sections: z.array(z.string()).optional(),
        style: z.enum(["classic", "modern", "minimal"]).optional()
      }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "Creating your website...",
        "openai/toolInvocation/invoked": "Website created."
      }
    },
    async ({ display_name, headline, bio, sections, style }) => {
      const existing = getWebsite();
      if (existing) {
        return {
          structuredContent: {
            status: "already_exists",
            website_url: existing.websiteUrl,
            domain: existing.domain ?? null
          },
          content: toolText("You already have a website. Use update_my_website to change it.")
        };
      }

      const projectName = `${config.vercelProjectPrefix}-${slugify(display_name || "website") || "website"}`;
      const website = updateWebsite(() => ({
        displayName: display_name,
        headline: headline ?? "",
        bio: bio ?? "",
        sections: sections ?? [],
        style: style ?? "classic",
        sourceMode: "generated",
        htmlSource: null,
        reactSource: null,
        projectName,
        latestDeploymentId: null,
        latestDeploymentUrl: null,
        websiteUrl: null,
        domain: null,
        domainVerified: false,
        lastPublishedAt: null,
        status: "created"
      }));

      return {
        structuredContent: {
          status: "created",
          project_name: projectName,
          website_url: website.websiteUrl,
          source_mode: "generated",
          has_uploaded_html: false
        },
        content: toolText("Your website has been created. Upload or paste HTML with set_website_html, then publish.")
      };
    }
  );

  registerAppTool(
    server,
    "set_website_react_source",
    {
      title: "Set website React source",
      description: "Paste React JSX source code for your website component and use it for publishing.",
      inputSchema: z.object({
        component_jsx: z.string().min(10).describe("React component source code (.jsx)"),
        title: z.string().optional().describe("Optional browser page title override")
      }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "Saving React source...",
        "openai/toolInvocation/invoked": "React source saved."
      }
    },
    async ({ component_jsx, title }) => {
      const existing = getWebsite();
      if (!existing) {
        throw new Error("No website found. Create one first with create_my_website.");
      }

      if (component_jsx.length > 700_000) {
        throw new Error("React source is too large. Keep it under 700KB.");
      }

      updateWebsite((current) => ({
        ...current,
        sourceMode: "react",
        reactSource: component_jsx,
        htmlSource: null,
        displayName: title ?? current.displayName,
        status: "react_source_set"
      }));

      return {
        structuredContent: {
          status: "saved",
          source_mode: "react",
          bytes: component_jsx.length
        },
        content: toolText("React source saved. Say 'publish my website' to compile and deploy it.")
      };
    }
  );

  registerAppTool(
    server,
    "set_website_html",
    {
      title: "Set website HTML",
      description: "Upload or paste the HTML you want deployed for your website.",
      inputSchema: z.object({
        html: z.string().optional().describe("Raw HTML for the website"),
        website_file: z
          .object({
            download_url: z.string(),
            file_id: z.string().optional()
          })
          .optional()
          .describe("Uploaded HTML file object")
      }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "Saving your website HTML...",
        "openai/toolInvocation/invoked": "Website HTML saved.",
        "openai/fileParams": ["website_file"]
      }
    },
    async ({ html, website_file }) => {
      const existing = getWebsite();
      if (!existing) {
        throw new Error("No website found. Create one first with create_my_website.");
      }

      const resolved = await resolveWebsiteHtml({ html, website_file });
      if (resolved.length > 500_000) {
        throw new Error("HTML file is too large. Keep it under 500KB.");
      }

      updateWebsite((current) => ({
        ...current,
        sourceMode: "html",
        htmlSource: resolved,
        reactSource: null,
        status: "html_set"
      }));

      return {
        structuredContent: {
          status: "saved",
          bytes: resolved.length
        },
        content: toolText("Website HTML saved. Say 'publish my website' when ready.")
      };
    }
  );

  registerAppTool(
    server,
    "update_my_website",
    {
      title: "Update my website",
      description: "Update your personal website content and publish changes.",
      inputSchema: z.object({
        headline: z.string().optional(),
        bio: z.string().optional(),
        sections: z.array(z.string()).optional(),
        style: z.enum(["classic", "modern", "minimal"]).optional(),
        confirm_update: z.boolean()
      }),
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "Updating your website...",
        "openai/toolInvocation/invoked": "Website updated."
      }
    },
    async ({ headline, bio, sections, style, confirm_update }) => {
      if (!confirm_update) {
        return {
          structuredContent: { requires_confirmation: true },
          content: toolText("Update not executed. Confirm update to continue.")
        };
      }

      const existing = getWebsite();
      if (!existing) {
        throw new Error("No website found. Create one first with create_my_website.");
      }

      const updated = updateWebsite((current) => ({
        ...current,
        headline: headline ?? current.headline,
        bio: bio ?? current.bio,
        sections: sections ?? current.sections,
        style: style ?? current.style,
        htmlSource: current.htmlSource ?? null,
        status: "updated"
      }));

      await publishWebsiteInternal(updated);
      const current = getWebsite();

      return {
        structuredContent: {
          status: "updated",
          website_url: current.websiteUrl,
          last_published_at: current.lastPublishedAt
        },
        content: toolText(`Website updated and published${current.domain ? ` at ${current.domain}` : ""}.`)
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

      const existing = getWebsite();
      if (!existing) {
        throw new Error("No website found. Create one first with create_my_website.");
      }

      const { website } = await publishWebsiteInternal(existing);
      return {
        structuredContent: {
          status: website.status,
          website_url: website.latestDeploymentUrl,
          domain_url: website.domain ? `https://${website.domain}` : null,
          source_mode: website.sourceMode ?? "generated",
          has_uploaded_html: Boolean(website.htmlSource),
          message: website.domain && !website.domainVerified ? "Domain linked, waiting for DNS propagation." : "Website is published."
        },
        content: toolText(
          website.domain
            ? website.domainVerified
              ? `Your website is live at https://${website.domain}.`
              : `Website published. Domain ${website.domain} is linked and waiting for DNS propagation.`
            : `Your website is live at ${website.latestDeploymentUrl}.`
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
      let website = getWebsite();
      if (!website) {
        const projectName = `${config.vercelProjectPrefix}-website`;
        website = updateWebsite(() => ({
          displayName: contact.name,
          headline: "",
          bio: "",
          sections: [],
          style: "classic",
          sourceMode: "generated",
          htmlSource: null,
          reactSource: null,
          projectName,
          latestDeploymentId: null,
          latestDeploymentUrl: null,
          websiteUrl: null,
          domain: null,
          domainVerified: false,
          lastPublishedAt: null,
          status: "created"
        }));
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

      const { website: published, domainStatus } = await publishWebsiteInternal(website);
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
      const website = getWebsite();
      if (!website) {
        return {
          structuredContent: {
            website_exists: false,
            message: "No website yet."
          },
          content: toolText("You don't have a website yet. Say 'create my website' to get started.")
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
          source_mode: website.sourceMode ?? "generated",
          has_uploaded_html: Boolean(website.htmlSource),
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

app.listen(config.port, () => {
  process.stdout.write(`OlaCV MCP server listening on :${config.port}\n`);
});
