import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_STATE = {
  users: {
    default: {
      website: null
    }
  }
};

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) {
      this.write(DEFAULT_STATE);
    }
  }

  read() {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (!parsed?.users) return structuredClone(DEFAULT_STATE);
      return parsed;
    } catch {
      return structuredClone(DEFAULT_STATE);
    }
  }

  write(data) {
    writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  getUser(userId = "default") {
    const state = this.read();
    if (!state.users[userId]) {
      state.users[userId] = { website: null };
      this.write(state);
    }
    return state.users[userId];
  }

  updateUser(userId = "default", updater) {
    const state = this.read();
    if (!state.users[userId]) {
      state.users[userId] = { website: null };
    }
    state.users[userId] = updater(structuredClone(state.users[userId]));
    this.write(state);
    return state.users[userId];
  }

  findWebsiteByDomain(domain) {
    const normalized = String(domain ?? "").toLowerCase();
    const state = this.read();
    for (const [userId, user] of Object.entries(state.users ?? {})) {
      const website = user?.website;
      if (website?.domain && String(website.domain).toLowerCase() === normalized) {
        return { userId, website };
      }
    }
    return null;
  }
}
