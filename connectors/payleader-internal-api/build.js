#!/usr/bin/env node
// Builds the Claude Desktop Extension (.mcpb) into dist/

import { build } from "esbuild";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "dist", ".build");
const OUT_FILE = join(__dirname, "dist", "payleader-internal-api.mcpb");

// ─── Clean ────────────────────────────────────────────────────────────────────
if (existsSync(BUILD_DIR)) rmSync(BUILD_DIR, { recursive: true });
mkdirSync(join(BUILD_DIR, "server"), { recursive: true });
mkdirSync(join(__dirname, "dist"), { recursive: true });

// ─── Bundle TypeScript → single JS file ──────────────────────────────────────
console.log("Bundling...");
await build({
  entryPoints: [join(__dirname, "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node18"],
  outfile: join(BUILD_DIR, "server", "index.js"),
  // Mark only true Node built-ins as external; bundle the MCP SDK
  packages: "bundle",
  external: [
    "http", "https", "fs", "fs/promises", "path", "os",
    "child_process", "crypto", "stream", "events", "util",
    "net", "tls", "zlib", "url", "buffer", "querystring",
  ],
});

// ESM marker so Node treats the bundled file as an ES module
writeFileSync(
  join(BUILD_DIR, "server", "package.json"),
  JSON.stringify({ type: "module" }, null, 2)
);

// ─── Manifest ────────────────────────────────────────────────────────────────
const manifest = {
  manifest_version: "0.3",
  name: "payleader-internal-api",
  version: "1.1.0",
  display_name: "Payleadr Internal API",
  description:
    "Connect Claude to the Payleadr Internal API. Manage users, wallets, memberships, merchants, payments, and audit reports.",
  long_description: [
    "## Payleadr Internal API Connector",
    "",
    "Connects Claude to the Payleadr Internal API, enabling you to:",
    "",
    "- **Manage users** — search, create, and look up customer accounts",
    "- **Wallet operations** — send invitations and verify wallets",
    "- **Memberships** — create, update, and manage membership plans",
    "- **Merchants** — configure settings, staff, and integrations",
    "- **Payments** — process payments and retrieve payment methods",
    "- **Audit reports** — query transaction and activity logs",
    "",
    "### Getting started",
    "After installing, ask Claude: _\"Set up Payleadr\"_.",
    "A browser window will open where you can sign in with your Payleadr",
    "credentials. Your session is saved automatically and refreshed in the",
    "background — no need to sign in again.",
  ].join("\n"),
  author: {
    name: "Tanya Gray",
  },
  license: "MIT",
  repository: "https://github.com/tanyagray/aglow-claude",
  keywords: ["payleadr", "payments", "memberships", "api"],

  server: {
    type: "node",
    entry_point: "server/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/index.js"],
      env: {
        PAYLEADER_BASE_URL: "${user_config.base_url}",
      },
    },
  },

  user_config: {
    base_url: {
      type: "string",
      title: "API Base URL",
      description:
        "Payleadr API base URL. Leave as default unless you have a production environment.",
      required: false,
      default: "https://lab.mypayleadr.com/payleadr-internal-api",
    },
  },

  tools: [
    { name: "payleader_setup",     description: "Sign in to Payleadr via browser — run once to connect your account" },
    { name: "payleader_whoami",    description: "Show the currently connected account and session status" },
    { name: "payleader_logout",    description: "Sign out and clear the saved session" },
    { name: "payleader_get_current_user",   description: "Get the currently authenticated user profile" },
    { name: "payleader_search_users",       description: "Search users by name or email" },
    { name: "payleader_list_users",         description: "List all users with optional filters" },
    { name: "payleader_get_user_by_id",     description: "Fetch a user by their ID" },
    { name: "payleader_get_user_by_username", description: "Look up a user by username" },
    { name: "payleader_create_user",        description: "Create a new customer account" },
    { name: "payleader_list_memberships",   description: "List memberships for a merchant" },
    { name: "payleader_create_membership",  description: "Create a membership for a customer" },
    { name: "payleader_update_membership",  description: "Update an existing membership" },
    { name: "payleader_list_plan_templates", description: "List membership plan templates" },
    { name: "payleader_create_plan_invite", description: "Send a membership plan invitation" },
    { name: "payleader_get_possible_wallet_clients",     description: "List possible wallet clients for a merchant" },
    { name: "payleader_create_wallet_invite",            description: "Create a wallet invitation" },
    { name: "payleader_get_wallet_invite",               description: "Get wallet invitation details" },
    { name: "payleader_send_wallet_verification_code",   description: "Send a wallet verification code" },
    { name: "payleader_validate_wallet_verification_code", description: "Validate a wallet verification code" },
    { name: "payleader_create_merchant",            description: "Register a new merchant" },
    { name: "payleader_get_merchant_bank_account",  description: "Get a merchant's bank account details" },
    { name: "payleader_get_merchant_claims",        description: "Get claims for a merchant" },
    { name: "payleader_get_merchant_settings",      description: "Get merchant settings" },
    { name: "payleader_list_staff",                 description: "List staff for a merchant" },
    { name: "payleader_add_staff",                  description: "Add a staff member to a merchant" },
    { name: "payleader_get_merchant_integrations",  description: "List merchant external integrations" },
    { name: "payleader_process_payment",        description: "Process an immediate payment" },
    { name: "payleader_get_payment_method",     description: "Get a buyer's payment method" },
    { name: "payleader_get_zai_session_token",  description: "Get a Zai payment gateway session token" },
    { name: "payleader_list_audit",             description: "Query audit and transaction logs" },
  ],

  compatibility: {
    claude_desktop: ">=1.0.0",
    platforms: ["darwin", "win32"],
    runtimes: { node: ">=18.0.0" },
  },
};

writeFileSync(join(BUILD_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

// ─── Package into .mcpb (ZIP) ─────────────────────────────────────────────────
if (existsSync(OUT_FILE)) rmSync(OUT_FILE);
console.log("Packaging .mcpb...");
execSync(`cd "${BUILD_DIR}" && zip -r "${OUT_FILE}" .`, { stdio: "inherit" });

// Clean up temp files
rmSync(BUILD_DIR, { recursive: true });

console.log(`\n✓  dist/payleader-internal-api.mcpb`);
