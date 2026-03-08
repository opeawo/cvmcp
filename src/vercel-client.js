function formatErrorPayload(payload) {
  if (!payload) return "No error payload";
  if (typeof payload === "string") return payload;
  if (payload.error?.message) return payload.error.message;
  if (payload.message) return payload.message;
  try {
    return JSON.stringify(payload);
  } catch {
    return "Unparseable error payload";
  }
}

export class VercelClient {
  constructor({ token, teamId = "" }) {
    this.token = token;
    this.teamId = teamId;
    this.baseUrl = "https://api.vercel.com";
  }

  query(extra = {}) {
    const params = new URLSearchParams();
    if (this.teamId) params.set("teamId", this.teamId);
    Object.entries(extra).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") {
        params.set(k, String(v));
      }
    });
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  }

  async request(path, { method = "GET", body, query } = {}) {
    const response = await fetch(`${this.baseUrl}${path}${this.query(query)}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json"
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
      throw new Error(`Vercel API ${method} ${path} failed (${response.status}): ${formatErrorPayload(json)}`);
    }

    return json;
  }

  async createProjectIfMissing(projectName, region = "iad1") {
    try {
      return await this.request("/v10/projects", {
        method: "POST",
        body: {
          name: projectName,
          serverlessFunctionRegion: region
        }
      });
    } catch (error) {
      if (!String(error.message).includes("already exists")) {
        throw error;
      }
      return this.request(`/v9/projects/${encodeURIComponent(projectName)}`, { method: "GET" });
    }
  }

  async deployStaticHtml({ projectName, html }) {
    return this.request("/v13/deployments", {
      method: "POST",
      query: { skipAutoDetectionConfirmation: 1 },
      body: {
        name: projectName,
        project: projectName,
        target: "production",
        projectSettings: { framework: null },
        files: [{ file: "index.html", data: html }]
      }
    });
  }

  async getDeployment(deploymentId) {
    return this.request(`/v13/deployments/${encodeURIComponent(deploymentId)}`, { method: "GET" });
  }

  async attachDomain(projectName, domain) {
    return this.request(`/v10/projects/${encodeURIComponent(projectName)}/domains`, {
      method: "POST",
      body: { name: domain }
    });
  }

  async listProjects() {
    const result = await this.request("/v9/projects", {
      method: "GET",
      query: { limit: 100 }
    });
    return Array.isArray(result?.projects) ? result.projects : [];
  }

  async listProjectDomains(projectName) {
    const result = await this.request(`/v10/projects/${encodeURIComponent(projectName)}/domains`, {
      method: "GET"
    });
    return Array.isArray(result?.domains) ? result.domains : [];
  }

  async removeDomain(projectName, domain) {
    return this.request(`/v10/projects/${encodeURIComponent(projectName)}/domains/${encodeURIComponent(domain)}`, {
      method: "DELETE"
    });
  }

  async getDomainStatus(projectName, domain) {
    return this.request(`/v10/projects/${encodeURIComponent(projectName)}/domains/${encodeURIComponent(domain)}`, {
      method: "GET"
    });
  }
}
