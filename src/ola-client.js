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

  async registerDomain({ domain, years, registrantContactId, autoRenew, nameservers }) {
    const body = {
      name: domain,
      registrant: registrantContactId,
      admin: registrantContactId,
      tech: registrantContactId,
      billing: registrantContactId
    };

    if (typeof years === "number") {
      body.period = years;
    }

    if (typeof autoRenew === "boolean") {
      body.auto_renew = autoRenew;
    }

    if (Array.isArray(nameservers) && nameservers.length > 0) {
      body.nameservers = nameservers;
    }

    return this.request("/api/v1/domains", {
      method: "POST",
      body
    });
  }

  async listDomains({ perPage, page } = {}) {
    const query = new URLSearchParams();
    if (perPage) query.set("per_page", String(perPage));
    if (page) query.set("page", String(page));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return this.request(`/api/v1/domains${suffix}`, { method: "GET" });
  }

  async renewDomain({ domainId, years }) {
    return this.request(`/api/v1/domains/${encodeURIComponent(domainId)}/renew`, {
      method: "POST",
      body: { period: years }
    });
  }

  async updateDns({ domainId, nameservers }) {
    return this.request(`/api/v1/domains/${encodeURIComponent(domainId)}`, {
      method: "POST",
      body: {
        nameservers
      }
    });
  }

  async createContact(contact) {
    return this.request("/api/v1/contacts", {
      method: "POST",
      body: contact
    });
  }

  async listContacts({ perPage, page } = {}) {
    const query = new URLSearchParams();
    if (perPage) query.set("per_page", String(perPage));
    if (page) query.set("page", String(page));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return this.request(`/api/v1/contacts${suffix}`, { method: "GET" });
  }

  async fetchContact(contactId) {
    return this.request(`/api/v1/contacts/${encodeURIComponent(contactId)}`, { method: "GET" });
  }

  async deleteContact(contactId) {
    return this.request(`/api/v1/contacts/${encodeURIComponent(contactId)}`, { method: "DELETE" });
  }
}
