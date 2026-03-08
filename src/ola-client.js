function formatErrorPayload(payload) {
  if (!payload) return "No error payload";
  if (typeof payload === "string") return payload;
  if (payload.message) return payload.message;
  if (payload.error) return payload.error;
  try {
    return JSON.stringify(payload);
  } catch {
    return "Unparseable error payload";
  }
}

export class OlaClient {
  constructor({ baseUrl, apiToken, authPrefix = "Bearer" }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiToken = apiToken;
    this.authPrefix = authPrefix;
  }

  async request(path, { method = "GET", body } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `${this.authPrefix} ${this.apiToken}`
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const raw = await response.text();
    let json;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = { raw };
    }

    if (!response.ok) {
      throw new Error(`Ola API ${method} ${path} failed (${response.status}): ${formatErrorPayload(json)}`);
    }

    return json;
  }

  async checkDomain(domain) {
    return this.request("/api/v1/domains/check", {
      method: "POST",
      body: { domains: [domain] }
    });
  }

  async registerDomain({ domain, years, registrantContactId, autoRenew }) {
    return this.request("/api/v1/domains/register", {
      method: "POST",
      body: {
        domain,
        period: years,
        owner_contact_ref: registrantContactId,
        auto_renewal: autoRenew
      }
    });
  }

  async listDomains() {
    return this.request("/api/v1/domains", { method: "GET" });
  }

  async renewDomain({ domain, years }) {
    return this.request(`/api/v1/domains/${encodeURIComponent(domain)}/renew`, {
      method: "POST",
      body: { period: years }
    });
  }

  async updateDns({ domain, nameservers }) {
    return this.request(`/api/v1/domains/${encodeURIComponent(domain)}`, {
      method: "POST",
      body: {
        nameservers
      }
    });
  }
}
