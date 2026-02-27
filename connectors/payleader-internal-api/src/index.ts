#!/usr/bin/env node

import { createServer } from "http";
import { exec } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { mkdir, writeFile, readFile, rm } from "fs/promises";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ─── Configuration ────────────────────────────────────────────────────────────

const BASE_URL = (
  process.env.PAYLEADER_BASE_URL || "https://lab.mypayleadr.com/payleadr-internal-api"
).replace(/\/$/, "");

const CONFIG_DIR = join(homedir(), ".config", "aglow");
const CREDENTIALS_FILE = join(CONFIG_DIR, "payleader.json");

// ─── Credential Storage ───────────────────────────────────────────────────────

interface StoredCredentials {
  accessToken: string;
  refreshToken: string | null;
  tokenExpiry: number;
  username: string;
  savedAt: string;
}

async function loadCredentials(): Promise<StoredCredentials | null> {
  try {
    const content = await readFile(CREDENTIALS_FILE, "utf-8");
    return JSON.parse(content) as StoredCredentials;
  } catch {
    return null;
  }
}

async function saveCredentials(creds: StoredCredentials): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), {
    encoding: "utf-8",
    mode: 0o600, // owner read/write only
  });
}

async function clearCredentials(): Promise<void> {
  try {
    await rm(CREDENTIALS_FILE);
  } catch {
    // already gone
  }
}

// ─── Token State ──────────────────────────────────────────────────────────────

let accessToken: string | null = null;
let refreshTokenValue: string | null = null;
let tokenExpiry = 0;
let loggedInAs: string | null = null;

// ─── Auth Helpers ─────────────────────────────────────────────────────────────

/**
 * Robustly extract an access token from an API response object.
 * Checks known field names first, then scans all string values (including one
 * level of nesting) for anything that looks like a JWT (starts with "eyJ").
 */
function extractAccessToken(data: Record<string, unknown>): string {
  // Check well-known field names
  const knownKeys = ["accessToken", "token", "access_token", "jwt", "jwtToken", "bearerToken", "authToken", "id_token"];
  for (const key of knownKeys) {
    const val = data[key];
    if (typeof val === "string" && val.length > 0) return val;
  }

  // Scan top-level string values for JWT pattern (base64url header "eyJ...")
  for (const val of Object.values(data)) {
    if (typeof val === "string" && val.startsWith("eyJ") && val.includes(".")) return val;
  }

  // One level deep — handle wrapped responses like { data: { token: "..." } }
  for (const val of Object.values(data)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = val as Record<string, unknown>;
      for (const key of knownKeys) {
        const nval = nested[key];
        if (typeof nval === "string" && nval.length > 0) return nval;
      }
      for (const nval of Object.values(nested)) {
        if (typeof nval === "string" && nval.startsWith("eyJ") && nval.includes(".")) return nval;
      }
    }
  }

  throw new Error(
    `Login succeeded but no access token found in API response. ` +
    `Response keys: ${Object.keys(data).join(", ")}`
  );
}

/**
 * Extract a refresh token from an API response, or return null if absent.
 */
function extractRefreshToken(data: Record<string, unknown>): string | null {
  const knownKeys = ["refreshToken", "refresh_token", "RefreshToken"];
  for (const key of knownKeys) {
    const val = data[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  // One level deep
  for (const val of Object.values(data)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = val as Record<string, unknown>;
      for (const key of knownKeys) {
        const nval = nested[key];
        if (typeof nval === "string" && nval.length > 0) return nval;
      }
    }
  }
  return null;
}

async function login(username: string, password: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/v2/users/authenticated-user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userName: username, password }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Login failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  accessToken = extractAccessToken(data);  // throws if not found
  refreshTokenValue = extractRefreshToken(data);
  tokenExpiry = Date.now() + 50 * 60 * 1000; // refresh 10 min before 1 hr expiry
  loggedInAs = username;

  await saveCredentials({
    accessToken,
    refreshToken: refreshTokenValue,
    tokenExpiry,
    username,
    savedAt: new Date().toISOString(),
  });
}

async function tryRefresh(): Promise<void> {
  if (!refreshTokenValue) {
    throw new Error("No refresh token. Please run payleader_setup to log in.");
  }

  const res = await fetch(`${BASE_URL}/v2/users/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: refreshTokenValue }),
  });

  if (!res.ok) {
    // Refresh expired — clear saved creds so user knows they need to re-authenticate
    await clearCredentials();
    accessToken = null;
    refreshTokenValue = null;
    tokenExpiry = 0;
    throw new Error(
      "Session expired. Please run payleader_setup to log in again."
    );
  }

  const data = (await res.json()) as Record<string, unknown>;
  accessToken = extractAccessToken(data);
  // Only rotate the refresh token if the endpoint actually returns a new one;
  // otherwise preserve the existing one so subsequent refreshes still work.
  const newRefresh = extractRefreshToken(data);
  if (newRefresh) refreshTokenValue = newRefresh;
  tokenExpiry = Date.now() + 50 * 60 * 1000;

  // loggedInAs may be null if the server restarted and loaded creds from disk —
  // fall back to the username stored in the file so we always persist the update.
  const saveUsername = loggedInAs ?? (await loadCredentials())?.username;
  if (saveUsername) {
    await saveCredentials({
      accessToken,
      refreshToken: refreshTokenValue,
      tokenExpiry,
      username: saveUsername,
      savedAt: new Date().toISOString(),
    });
  }
}

async function ensureAuth(): Promise<void> {
  // Already have a valid token in memory
  if (accessToken && Date.now() < tokenExpiry) return;

  // Try loading from disk
  const stored = await loadCredentials();
  if (stored) {
    loggedInAs = stored.username;

    if (stored.tokenExpiry > Date.now()) {
      // Stored token still valid
      accessToken = stored.accessToken;
      refreshTokenValue = stored.refreshToken;
      tokenExpiry = stored.tokenExpiry;
      return;
    }

    if (stored.refreshToken) {
      // Try refreshing with stored refresh token
      refreshTokenValue = stored.refreshToken;
      await tryRefresh();
      return;
    }
  }

  // Fall back to env vars (for technical / CI usage)
  const envUser = process.env.PAYLEADER_USERNAME;
  const envPass = process.env.PAYLEADER_PASSWORD;
  if (envUser && envPass) {
    await login(envUser, envPass);
    return;
  }

  throw new Error(
    "Not authenticated. Ask the user to run the payleader_setup tool to log in."
  );
}

// ─── Setup Flow (browser-based login) ────────────────────────────────────────

const SETUP_PORT = 47832;

const SETUP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Connect Payleadr to Claude</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f5f7;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .card {
      background: white;
      border-radius: 16px;
      padding: 40px;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 28px;
    }

    .logo-icon {
      width: 40px;
      height: 40px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 20px;
    }

    .logo-text { font-size: 18px; font-weight: 600; color: #111; }
    .logo-sub  { font-size: 13px; color: #666; }

    h1 { font-size: 22px; font-weight: 700; color: #111; margin-bottom: 8px; }
    p  { font-size: 14px; color: #555; margin-bottom: 24px; line-height: 1.5; }

    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: #333;
      margin-bottom: 6px;
    }

    input {
      width: 100%;
      padding: 10px 14px;
      border: 1.5px solid #e0e0e0;
      border-radius: 8px;
      font-size: 15px;
      outline: none;
      transition: border-color 0.15s;
      margin-bottom: 16px;
    }

    input:focus { border-color: #6366f1; }

    button {
      width: 100%;
      padding: 12px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
    }

    button:hover   { opacity: 0.9; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }

    .alert {
      margin-top: 16px;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 14px;
      display: none;
    }

    .alert-error   { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
    .alert-success { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }

    .success-icon { font-size: 32px; text-align: center; margin-bottom: 12px; }

    .secure-note {
      margin-top: 20px;
      font-size: 12px;
      color: #999;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-icon">⚡</div>
      <div>
        <div class="logo-text">Payleadr</div>
        <div class="logo-sub">Connect to Claude</div>
      </div>
    </div>

    <div id="form-view">
      <h1>Sign in to Payleadr</h1>
      <p>Enter your Payleadr credentials to connect your account to Claude. Your credentials are used once to obtain a secure token.</p>

      <form id="login-form">
        <label for="username">Username</label>
        <input type="text" id="username" name="username"
               placeholder="your@email.com" required autocomplete="username" />

        <label for="password">Password</label>
        <input type="password" id="password" name="password"
               placeholder="••••••••" required autocomplete="current-password" />

        <button type="submit" id="submit-btn">Connect to Claude</button>
      </form>

      <div id="error-alert" class="alert alert-error"></div>
    </div>

    <div id="success-view" style="display:none; text-align:center;">
      <div class="success-icon">✅</div>
      <h1>Connected!</h1>
      <p style="margin-top:8px;">Your Payleadr account is now linked to Claude. You can close this window and return to Claude.</p>
    </div>

    <p class="secure-note">🔒 Your password is never stored. Only a secure token is saved locally.</p>
  </div>

  <script>
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();

      const btn = document.getElementById('submit-btn');
      const err = document.getElementById('error-alert');
      btn.disabled = true;
      btn.textContent = 'Connecting…';
      err.style.display = 'none';

      try {
        const res = await fetch('/authenticate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value,
          }),
        });

        const data = await res.json();

        if (res.ok) {
          document.getElementById('form-view').style.display = 'none';
          document.getElementById('success-view').style.display = 'block';
        } else {
          err.textContent = data.error || 'Login failed. Please check your credentials.';
          err.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Connect to Claude';
        }
      } catch {
        err.textContent = 'Connection error. Please try again.';
        err.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Connect to Claude';
      }
    });
  </script>
</body>
</html>`;

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? `open "${url}"` :
    process.platform === "win32"  ? `start "" "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd);
}

async function runSetupFlow(): Promise<{ success: boolean; username?: string; message: string }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(SETUP_HTML);
        return;
      }

      if (req.method === "POST" && req.url === "/authenticate") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          try {
            const { username, password } = JSON.parse(body) as {
              username: string;
              password: string;
            };

            await login(username, password);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));

            // Give the browser a moment to show the success state, then shut down
            setTimeout(() => {
              server.close();
              resolve({ success: true, username, message: `Successfully connected as ${username}.` });
            }, 1500);
          } catch (error) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
            );
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(SETUP_PORT, "127.0.0.1", () => {
      const url = `http://localhost:${SETUP_PORT}`;
      openBrowser(url);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve({
          success: false,
          message: `Port ${SETUP_PORT} is already in use. Another setup may be running — check your browser for a Payleadr login page.`,
        });
      } else {
        resolve({ success: false, message: `Server error: ${err.message}` });
      }
    });

    // 5-minute timeout
    setTimeout(() => {
      server.close();
      resolve({ success: false, message: "Setup timed out after 5 minutes. Please try again." });
    }, 5 * 60 * 1000);
  });
}

// ─── Request Helpers ──────────────────────────────────────────────────────────

function buildQuery(params: Record<string, unknown>): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return qs ? `?${qs}` : "";
}

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, unknown>
): Promise<T> {
  await ensureAuth();

  const url = `${BASE_URL}${path}${query ? buildQuery(query) : ""}`;

  const makeRequest = (): Promise<Response> =>
    fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await makeRequest();

  // Single retry on 401 — attempt a refresh first
  if (res.status === 401) {
    await tryRefresh();
    res = await makeRequest();
  }

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`API error (${res.status}): ${errBody}`);
  }

  if (res.status === 204) return null as T;
  return res.json() as Promise<T>;
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  // Setup & Auth
  {
    name: "payleader_setup",
    description:
      "Opens a browser-based login page to connect your Payleadr account to Claude. " +
      "Run this once — your session is saved and reused automatically. " +
      "Use this to log in for the first time, switch accounts, or reconnect after your session expires.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "payleader_whoami",
    description: "Show the currently logged-in Payleadr account and session status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "payleader_logout",
    description: "Log out of Payleadr and remove the saved session.",
    inputSchema: { type: "object", properties: {} },
  },

  // Users
  {
    name: "payleader_get_current_user",
    description: "Get the currently authenticated user profile.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "payleader_get_user_by_id",
    description: "Fetch a specific user by their ID.",
    inputSchema: {
      type: "object",
      required: ["userId"],
      properties: {
        userId: { type: "string", description: "User ID" },
      },
    },
  },
  {
    name: "payleader_get_user_by_username",
    description: "Look up a user by their username.",
    inputSchema: {
      type: "object",
      required: ["username"],
      properties: {
        username: { type: "string" },
      },
    },
  },
  {
    name: "payleader_search_users",
    description: "Search users with optional pagination and sorting.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string" },
        page: { type: "number" },
        limit: { type: "number" },
        sortBy: { type: "string" },
      },
    },
  },
  {
    name: "payleader_list_users",
    description: "List all users with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string" },
        page: { type: "number" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "payleader_create_user",
    description: "Create a new user/customer account.",
    inputSchema: {
      type: "object",
      required: ["firstName", "lastName", "email", "mobile"],
      properties: {
        firstName: { type: "string" },
        lastName: { type: "string" },
        email: { type: "string" },
        mobile: { type: "string" },
        dateOfBirth: { type: "string", description: "ISO date, e.g. 1990-01-15" },
        countryCode: { type: "string", description: "Aus or Nzl" },
        address: { type: "string" },
      },
    },
  },

  // Wallets
  {
    name: "payleader_get_possible_wallet_clients",
    description: "List potential wallet clients for a merchant.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: { legacyUserId: { type: "string" } },
    },
  },
  {
    name: "payleader_create_wallet_invite",
    description: "Create a wallet invitation for a customer.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: {
        legacyUserId: { type: "string" },
        email: { type: "string" },
        mobile: { type: "string" },
        firstName: { type: "string" },
        lastName: { type: "string" },
      },
    },
  },
  {
    name: "payleader_get_wallet_invite",
    description: "Retrieve wallet invitation details by UUID.",
    inputSchema: {
      type: "object",
      required: ["inviteUuid"],
      properties: { inviteUuid: { type: "string" } },
    },
  },
  {
    name: "payleader_send_wallet_verification_code",
    description: "Send a verification code for a wallet invitation.",
    inputSchema: {
      type: "object",
      required: ["walletInvitationId"],
      properties: { walletInvitationId: { type: "string" } },
    },
  },
  {
    name: "payleader_validate_wallet_verification_code",
    description: "Validate a wallet invitation verification code.",
    inputSchema: {
      type: "object",
      required: ["walletInvitationId", "code"],
      properties: {
        walletInvitationId: { type: "string" },
        code: { type: "string" },
      },
    },
  },

  // Memberships
  {
    name: "payleader_list_memberships",
    description: "List memberships for a merchant, with optional status filter.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: {
        legacyUserId: { type: "string" },
        status: { type: "string" },
        page: { type: "number" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "payleader_create_membership",
    description: "Create a membership for a customer under a merchant.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId", "legacyCustomerUserId"],
      properties: {
        legacyUserId: { type: "string" },
        legacyCustomerUserId: { type: "string" },
        treatments: { type: "array", items: { type: "object" } },
        perks: { type: "array", items: { type: "object" } },
        paymentOption: { type: "string" },
        discount: { type: "number" },
        surcharge: { type: "number" },
      },
    },
  },
  {
    name: "payleader_update_membership",
    description: "Update an existing membership.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId", "membershipId"],
      properties: {
        legacyUserId: { type: "string" },
        membershipId: { type: "string" },
        status: { type: "string" },
        treatments: { type: "array", items: { type: "object" } },
        perks: { type: "array", items: { type: "object" } },
      },
    },
  },
  {
    name: "payleader_list_plan_templates",
    description: "List membership plan templates for a merchant.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: { legacyUserId: { type: "string" } },
    },
  },
  {
    name: "payleader_create_plan_invite",
    description: "Create a membership plan invitation for a customer.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: {
        legacyUserId: { type: "string" },
        email: { type: "string" },
        mobile: { type: "string" },
        planTemplateId: { type: "string" },
      },
    },
  },

  // Merchants
  {
    name: "payleader_create_merchant",
    description: "Register a new merchant.",
    inputSchema: {
      type: "object",
      required: ["companyName"],
      properties: {
        companyName: { type: "string" },
        contactEmail: { type: "string" },
        contactPhone: { type: "string" },
        webhookUrl: { type: "string" },
        countryCode: { type: "string", description: "Aus or Nzl" },
      },
    },
  },
  {
    name: "payleader_get_merchant_bank_account",
    description: "Retrieve bank account details for a merchant.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: { legacyUserId: { type: "string" } },
    },
  },
  {
    name: "payleader_get_merchant_claims",
    description: "Get claims for a merchant.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: { legacyUserId: { type: "string" } },
    },
  },
  {
    name: "payleader_get_merchant_settings",
    description: "Retrieve settings for a merchant.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: { legacyUserId: { type: "string" } },
    },
  },
  {
    name: "payleader_list_staff",
    description: "List staff users for a merchant.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: { legacyUserId: { type: "string" } },
    },
  },
  {
    name: "payleader_add_staff",
    description: "Add a staff member to a merchant.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId", "userId"],
      properties: {
        legacyUserId: { type: "string" },
        userId: { type: "string" },
        role: { type: "string" },
      },
    },
  },
  {
    name: "payleader_get_merchant_integrations",
    description: "List external app integrations for a merchant.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: { legacyUserId: { type: "string" } },
    },
  },

  // Payments
  {
    name: "payleader_process_payment",
    description: "Process an immediate payment (pay-now) for a buyer.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId", "amount"],
      properties: {
        legacyUserId: { type: "string" },
        amount: { type: "number", description: "Amount in cents" },
        description: { type: "string" },
        buyerId: { type: "string" },
        referenceId: { type: "string" },
      },
    },
  },
  {
    name: "payleader_get_payment_method",
    description: "Retrieve the payment method for a merchant/buyer combination.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId", "legacyBuyerId"],
      properties: {
        legacyUserId: { type: "string" },
        legacyBuyerId: { type: "string" },
      },
    },
  },
  {
    name: "payleader_get_zai_session_token",
    description: "Obtain a Zai payment gateway session token.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: { legacyUserId: { type: "string" } },
    },
  },

  // Reports
  {
    name: "payleader_list_audit",
    description:
      "Query audit logs. Supports filtering by date range, user, and action type " +
      "(Purchase, Refund, PartialRefund, Void, PayNow, SecondaryAttempt).",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number" },
        limit: { type: "number" },
        search: { type: "string" },
        startDate: { type: "string", description: "ISO date string" },
        endDate: { type: "string", description: "ISO date string" },
        userId: { type: "string" },
        actionType: { type: "string" },
      },
    },
  },
];

// ─── Tool Handlers ────────────────────────────────────────────────────────────

type Input = Record<string, unknown>;

async function handleTool(name: string, input: Input): Promise<unknown> {
  switch (name) {
    // ── Setup & Auth ──────────────────────────────────────────────────────────
    case "payleader_setup": {
      const result = await runSetupFlow();
      if (result.success) {
        return {
          success: true,
          message: `${result.message} Your session is saved and will be refreshed automatically.`,
        };
      }
      return { success: false, message: result.message };
    }

    case "payleader_whoami": {
      const stored = await loadCredentials();
      if (!stored) {
        return { loggedIn: false, message: "Not logged in. Run payleader_setup to connect." };
      }
      const isExpired = stored.tokenExpiry < Date.now();
      return {
        loggedIn: true,
        username: stored.username,
        savedAt: stored.savedAt,
        sessionStatus: isExpired ? "expired (will auto-refresh)" : "active",
        expiresAt: new Date(stored.tokenExpiry).toISOString(),
      };
    }

    case "payleader_logout": {
      if (accessToken) {
        await api("POST", "/v2/users/logout", { token: accessToken }).catch(() => null);
      }
      await clearCredentials();
      accessToken = null;
      refreshTokenValue = null;
      tokenExpiry = 0;
      loggedInAs = null;
      return { success: true, message: "Logged out and session cleared." };
    }

    // ── Users ─────────────────────────────────────────────────────────────────
    case "payleader_get_current_user":
      return api("GET", "/v2/users/current");

    case "payleader_get_user_by_id":
      return api("GET", `/v2/users/user/${input.userId}`);

    case "payleader_get_user_by_username":
      return api("GET", `/v2/users/username/${encodeURIComponent(input.username as string)}`);

    case "payleader_search_users":
      return api("GET", "/v2/users/search", undefined, {
        search: input.search,
        Page: input.page,
        Limit: input.limit,
        SortBy: input.sortBy,
      });

    case "payleader_list_users":
      return api("GET", "/v2/users/all", undefined, {
        search: input.search,
        Page: input.page,
        Limit: input.limit,
      });

    case "payleader_create_user":
      return api("POST", "/v2/users", {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        mobile: input.mobile,
        dateOfBirth: input.dateOfBirth,
        countryCode: input.countryCode,
        address: input.address,
      });

    // ── Wallets ───────────────────────────────────────────────────────────────
    case "payleader_get_possible_wallet_clients":
      return api("GET", `/v2/wallets/${input.legacyUserId}/possible-clients`);

    case "payleader_create_wallet_invite":
      return api("POST", `/v2/wallets/${input.legacyUserId}/wallet-invites`, {
        email: input.email,
        mobile: input.mobile,
        firstName: input.firstName,
        lastName: input.lastName,
      });

    case "payleader_get_wallet_invite":
      return api("GET", `/v2/wallets/wallet-invites/${input.inviteUuid}`);

    case "payleader_send_wallet_verification_code":
      return api("POST", `/v2/wallets/${input.walletInvitationId}/send-verification-code`);

    case "payleader_validate_wallet_verification_code":
      return api(
        "GET",
        `/v2/wallets/${input.walletInvitationId}/validate-verification-code`,
        undefined,
        { code: input.code }
      );

    // ── Memberships ───────────────────────────────────────────────────────────
    case "payleader_list_memberships":
      return api("GET", `/v2/memberships/${input.legacyUserId}/memberships`, undefined, {
        status: input.status,
        Page: input.page,
        Limit: input.limit,
      });

    case "payleader_create_membership":
      return api(
        "POST",
        `/v2/memberships/${input.legacyUserId}/memberships/${input.legacyCustomerUserId}`,
        {
          treatments: input.treatments,
          perks: input.perks,
          paymentOption: input.paymentOption,
          discount: input.discount,
          surcharge: input.surcharge,
        }
      );

    case "payleader_update_membership":
      return api(
        "PUT",
        `/v2/memberships/${input.legacyUserId}/memberships/${input.membershipId}`,
        { status: input.status, treatments: input.treatments, perks: input.perks }
      );

    case "payleader_list_plan_templates":
      return api("GET", `/v2/memberships/${input.legacyUserId}/plan-templates`);

    case "payleader_create_plan_invite":
      return api("POST", `/v2/memberships/${input.legacyUserId}/plan-invites`, {
        email: input.email,
        mobile: input.mobile,
        planTemplateId: input.planTemplateId,
      });

    // ── Merchants ─────────────────────────────────────────────────────────────
    case "payleader_create_merchant":
      return api("POST", "/v2/merchants/create-merchant", {
        companyName: input.companyName,
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone,
        webhookUrl: input.webhookUrl,
        countryCode: input.countryCode,
      });

    case "payleader_get_merchant_bank_account":
      return api("GET", `/v2/merchants/${input.legacyUserId}/bank-account`);

    case "payleader_get_merchant_claims":
      return api("GET", `/v2/merchants/${input.legacyUserId}/claims`);

    case "payleader_get_merchant_settings":
      return api("GET", `/v2/merchants/${input.legacyUserId}/settings`);

    case "payleader_list_staff":
      return api("GET", `/v2/merchants/${input.legacyUserId}/staff-users`);

    case "payleader_add_staff":
      return api("POST", `/v2/merchants/${input.legacyUserId}/staff-users`, {
        userId: input.userId,
        role: input.role,
      });

    case "payleader_get_merchant_integrations":
      return api("GET", `/v2/merchants/${input.legacyUserId}/integration-settings`);

    // ── Payments ──────────────────────────────────────────────────────────────
    case "payleader_process_payment":
      return api("POST", `/v2/payments/${input.legacyUserId}/pay-now`, {
        amount: input.amount,
        description: input.description,
        buyerId: input.buyerId,
        referenceId: input.referenceId,
      });

    case "payleader_get_payment_method":
      return api(
        "GET",
        `/v2/payments/${input.legacyUserId}/biller-payment-method/${input.legacyBuyerId}`
      );

    case "payleader_get_zai_session_token":
      return api("GET", `/v2/payments/${input.legacyUserId}/get-zai-session-token`);

    // ── Reports ───────────────────────────────────────────────────────────────
    case "payleader_list_audit":
      return api("POST", "/v2/reports/list-audit", {
        page: input.page,
        limit: input.limit,
        search: input.search,
        startDate: input.startDate,
        endDate: input.endDate,
        userId: input.userId,
        actionType: input.actionType,
      });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "payleader-internal-api", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: input = {} } = request.params;

  try {
    const result = await handleTool(name, input as Input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
