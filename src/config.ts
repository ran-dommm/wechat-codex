import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./constants.js";

export interface Config {
  workingDirectory: string;
  model?: string;
  mode?: "plan" | "workspace" | "danger";
}

const CONFIG_DIR = DATA_DIR;
const CONFIG_PATH = join(CONFIG_DIR, "config.env");
export const DEFAULT_WORKING_DIRECTORY = process.cwd();

const DEFAULT_CONFIG: Config = {
  workingDirectory: DEFAULT_WORKING_DIRECTORY,
  mode: "workspace",
};

function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

function parseConfigFile(content: string): Config {
  const config: Config = { ...DEFAULT_CONFIG };
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    switch (key) {
      case "workingDirectory":
        config.workingDirectory = value;
        break;
      case "model":
        config.model = value;
        break;
      case "mode":
        if (value === "plan" || value === "workspace" || value === "danger") {
          config.mode = value;
        }
        break;
    }
  }
  return config;
}

export function loadConfig(): Config {
  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    return parseConfigFile(content);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  const lines: string[] = [];
  lines.push(`workingDirectory=${config.workingDirectory}`);
  if (config.model) {
    lines.push(`model=${config.model}`);
  }
  if (config.mode) {
    lines.push(`mode=${config.mode}`);
  }
  writeFileSync(CONFIG_PATH, lines.join("\n") + "\n", "utf-8");
  if (process.platform !== 'win32') {
    chmodSync(CONFIG_PATH, 0o600);
  }
}
