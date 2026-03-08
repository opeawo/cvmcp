import dotenv from "dotenv";

dotenv.config();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig() {
  return {
    port: Number.parseInt(process.env.PORT ?? "8787", 10),
    olaBaseUrl: process.env.OLA_API_BASE_URL ?? "https://developer.ola.cv",
    olaApiToken: requireEnv("OLA_API_TOKEN"),
    olaAuthPrefix: process.env.OLA_AUTH_PREFIX ?? "Bearer",
    defaultRegistrationYears: Number.parseInt(process.env.DEFAULT_REGISTRATION_YEARS ?? "1", 10),
    defaultRenewalYears: Number.parseInt(process.env.DEFAULT_RENEWAL_YEARS ?? "1", 10),
    vercelToken: process.env.VERCEL_TOKEN ?? "",
    vercelTeamId: process.env.VERCEL_TEAM_ID ?? "",
    vercelProjectPrefix: process.env.VERCEL_PROJECT_PREFIX ?? "cvmcp",
    vercelDefaultRegion: process.env.VERCEL_DEFAULT_REGION ?? "iad1",
    stateFilePath: process.env.STATE_FILE_PATH ?? "./data/state.json"
  };
}

export function normalizeCvDomain(input) {
  const value = String(input ?? "").trim().toLowerCase();
  const normalized = value.endsWith(".cv") ? value : `${value}.cv`;

  if (!/^[a-z0-9-]+\.cv$/.test(normalized)) {
    throw new Error("Invalid domain. Use letters, numbers, hyphens, ending in .cv");
  }

  if (normalized.startsWith("-") || normalized.endsWith("-.cv")) {
    throw new Error("Invalid domain label format.");
  }

  return normalized;
}
