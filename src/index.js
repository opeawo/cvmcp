import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { loadConfig, normalizeCvDomain } from "./config.js";
import { OlaClient } from "./ola-client.js";

const config = loadConfig();
const ola = new OlaClient({
  baseUrl: config.olaBaseUrl,
  apiToken: config.olaApiToken,
  authPrefix: config.olaAuthPrefix
});

function toolText(text) {
  return [{ type: "text", text }];
}

function domainFromResponse(response) {
  return response?.domain || response?.name || response?.fqdn || response?.data?.domain || null;
}

function availabilityFromResponse(response, domain) {
  const domainKey = String(domain ?? "").toLowerCase();
  const available =
    response?.available ??
    response?.is_available ??
    response?.data?.available ??
    response?.data?.[domainKey]?.available ??
    response?.result?.available ??
    false;

  return Boolean(available);
}

function createMcpServer() {
  const server = new McpServer({
    name: "olacv-domains",
    version: "0.1.0"
  });

  registerAppTool(
    server,
    "check_domain",
    {
      title: "Check .cv domain availability",
      description:
        "Use this when the user asks if a .cv domain is available or asks to search .cv names.",
      inputSchema: z.object({
        domain: z.string().describe("Domain name with or without .cv (example: johnsmith or johnsmith.cv)")
      }),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false
      },
      _meta: {
        "openai/toolInvocation/invoking": "Checking domain availability...",
        "openai/toolInvocation/invoked": "Domain check complete."
      }
    },
    async ({ domain }) => {
      const normalized = normalizeCvDomain(domain);
      const result = await ola.checkDomain(normalized);
      const available = availabilityFromResponse(result, normalized);

      return {
        structuredContent: {
          domain: normalized,
          available,
          raw: result
        },
        content: toolText(
          available
            ? `${normalized} is available. Ask the user if they want to register it now.`
            : `${normalized} is not available.`
        )
      };
    }
  );

  registerAppTool(
    server,
    "register_domain",
    {
      title: "Register .cv domain",
      description:
        "Use this only when the user explicitly confirms purchase. Requires registrant contact id from Ola account.",
      inputSchema: z.object({
        domain: z.string().describe("Domain to register, with or without .cv"),
        registrant_contact_id: z
          .string()
          .describe("Ola contact id to assign as registrant for this domain"),
        years: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("Registration period in years. Defaults to 1 year."),
        auto_renew: z.boolean().optional().describe("Enable auto-renew on the domain"),
        confirm_purchase: z
          .boolean()
          .describe("Must be true only after the user confirms purchase in the current turn")
      }),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false
      },
      _meta: {
        "openai/toolInvocation/invoking": "Registering domain...",
        "openai/toolInvocation/invoked": "Domain registration complete."
      }
    },
    async ({ domain, registrant_contact_id, years, auto_renew, confirm_purchase }) => {
      const normalized = normalizeCvDomain(domain);

      if (!confirm_purchase) {
        return {
          structuredContent: {
            requires_confirmation: true,
            action: "register",
            domain: normalized
          },
          content: toolText(
            `Registration not executed. Ask: \"Register ${normalized} now?\" and call again with confirm_purchase=true.`
          )
        };
      }

      const result = await ola.registerDomain({
        domain: normalized,
        years: years ?? config.defaultRegistrationYears,
        registrantContactId: registrant_contact_id,
        autoRenew: auto_renew ?? false
      });

      return {
        structuredContent: {
          domain: domainFromResponse(result) ?? normalized,
          status: "registered",
          raw: result
        },
        content: toolText(`Successfully registered ${normalized}.`)
      };
    }
  );

  registerAppTool(
    server,
    "list_domains",
    {
      title: "List my .cv domains",
      description: "Use this when the user asks to show, list, or manage their domains.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false
      },
      _meta: {
        "openai/toolInvocation/invoking": "Loading your domains...",
        "openai/toolInvocation/invoked": "Domain list ready."
      }
    },
    async () => {
      const result = await ola.listDomains();
      const domains = Array.isArray(result?.domains)
        ? result.domains
        : Array.isArray(result)
          ? result
          : Array.isArray(result?.data)
            ? result.data
            : result?.data?.domains ?? [];

      return {
        structuredContent: {
          count: domains.length,
          domains,
          raw: result
        },
        content: toolText(domains.length ? `Found ${domains.length} domain(s).` : "No domains found for this account.")
      };
    }
  );

  registerAppTool(
    server,
    "renew_domain",
    {
      title: "Renew .cv domain",
      description: "Use this when the user asks to renew a domain and confirms the renewal.",
      inputSchema: z.object({
        domain: z.string().describe("Domain to renew"),
        years: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("Renewal period in years. Defaults to 1 year."),
        confirm_renewal: z
          .boolean()
          .describe("Must be true only after the user confirms renewal in the current turn")
      }),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false
      },
      _meta: {
        "openai/toolInvocation/invoking": "Renewing domain...",
        "openai/toolInvocation/invoked": "Domain renewal complete."
      }
    },
    async ({ domain, years, confirm_renewal }) => {
      const normalized = normalizeCvDomain(domain);

      if (!confirm_renewal) {
        return {
          structuredContent: {
            requires_confirmation: true,
            action: "renew",
            domain: normalized
          },
          content: toolText(
            `Renewal not executed. Ask: \"Renew ${normalized}?\" and call again with confirm_renewal=true.`
          )
        };
      }

      const result = await ola.renewDomain({
        domain: normalized,
        years: years ?? config.defaultRenewalYears
      });

      return {
        structuredContent: {
          domain: normalized,
          status: "renewed",
          raw: result
        },
        content: toolText(`Successfully renewed ${normalized}.`)
      };
    }
  );

  registerAppTool(
    server,
    "update_dns",
    {
      title: "Update domain nameservers",
      description: "Use this to update nameservers on a .cv domain.",
      inputSchema: z.object({
        domain: z.string().describe("Domain to update"),
        nameservers: z
          .array(z.string().min(3))
          .min(2)
          .max(8)
          .describe("Nameserver hostnames (example: [ns1.provider.com, ns2.provider.com])"),
        confirm_dns_update: z
          .boolean()
          .describe("Must be true only after the user confirms DNS update in the current turn")
      }),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false
      },
      _meta: {
        "openai/toolInvocation/invoking": "Updating DNS...",
        "openai/toolInvocation/invoked": "DNS update complete."
      }
    },
    async ({ domain, nameservers, confirm_dns_update }) => {
      const normalized = normalizeCvDomain(domain);

      if (!confirm_dns_update) {
        return {
          structuredContent: {
            requires_confirmation: true,
            action: "update_dns",
            domain: normalized,
            nameservers
          },
          content: toolText(
            `DNS update not executed. Ask the user to confirm nameservers for ${normalized}, then call with confirm_dns_update=true.`
          )
        };
      }

      const result = await ola.updateDns({ domain: normalized, nameservers });

      return {
        structuredContent: {
          domain: normalized,
          nameservers,
          status: "updated",
          raw: result
        },
        content: toolText(`Updated nameservers for ${normalized}.`)
      };
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

app.get("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).send("Invalid or missing mcp-session-id");
    return;
  }

  await sessions.get(sessionId).transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).send("Invalid or missing mcp-session-id");
    return;
  }

  await sessions.get(sessionId).transport.handleRequest(req, res);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "olacv-domains", version: "0.1.0" });
});

app.listen(config.port, () => {
  process.stdout.write(`OlaCV MCP server listening on :${config.port}\n`);
});
