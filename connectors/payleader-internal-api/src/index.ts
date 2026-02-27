#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ─── Configuration ────────────────────────────────────────────────────────────

const BASE_URL =
  (process.env.PAYLEADER_BASE_URL || "https://lab.mypayleadr.com/payleadr-internal-api").replace(/\/$/, "");

let envUsername = process.env.PAYLEADER_USERNAME;
let envPassword = process.env.PAYLEADER_PASSWORD;

// ─── Token State ──────────────────────────────────────────────────────────────

let accessToken: string | null = null;
let refreshTokenValue: string | null = null;
let tokenExpiry = 0;

// ─── Auth Helpers ─────────────────────────────────────────────────────────────

async function login(username?: string, password?: string): Promise<void> {
  const user = username || envUsername;
  const pass = password || envPassword;

  if (!user || !pass) {
    throw new Error(
      "Credentials required. Set PAYLEADER_USERNAME and PAYLEADER_PASSWORD " +
        "environment variables, or call payleader_authenticate with username/password."
    );
  }

  const res = await fetch(`${BASE_URL}/v2/users/authenticated-user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userName: user, password: pass }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Login failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  accessToken = (data.accessToken ?? data.token ?? data.access_token) as string;
  refreshTokenValue = (data.refreshToken ?? data.refresh_token ?? null) as string | null;
  tokenExpiry = Date.now() + 50 * 60 * 1000; // refresh 10 min before 1 hr expiry
}

async function tryRefresh(): Promise<void> {
  if (!refreshTokenValue) {
    await login();
    return;
  }

  const res = await fetch(`${BASE_URL}/v2/users/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: refreshTokenValue }),
  });

  if (!res.ok) {
    // Refresh failed — fall back to full login
    await login();
    return;
  }

  const data = (await res.json()) as Record<string, unknown>;
  accessToken = (data.accessToken ?? data.token ?? data.access_token) as string;
  refreshTokenValue = (data.refreshToken ?? data.refresh_token ?? null) as string | null;
  tokenExpiry = Date.now() + 50 * 60 * 1000;
}

async function ensureAuth(): Promise<void> {
  if (!accessToken) {
    await login();
  } else if (Date.now() >= tokenExpiry) {
    await tryRefresh();
  }
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

  const makeRequest = async (): Promise<Response> =>
    fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await makeRequest();

  // Single retry on 401
  if (res.status === 401) {
    await login();
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
  // Auth
  {
    name: "payleader_authenticate",
    description:
      "Explicitly authenticate with the Payleadr API. This is called automatically on first use if PAYLEADER_USERNAME and PAYLEADER_PASSWORD are set. Use this to provide credentials at runtime or to switch accounts.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Payleadr username (overrides env var)" },
        password: { type: "string", description: "Payleadr password (overrides env var)" },
      },
    },
  },
  {
    name: "payleader_logout",
    description: "Log out and revoke the current access token.",
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
        username: { type: "string", description: "Username to look up" },
      },
    },
  },
  {
    name: "payleader_search_users",
    description: "Search users with optional pagination and sorting.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Search term" },
        page: { type: "number", description: "Page number (1-based)" },
        limit: { type: "number", description: "Results per page" },
        sortBy: { type: "string", description: "Field to sort by" },
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
        dateOfBirth: { type: "string", description: "ISO date string, e.g. 1990-01-15" },
        countryCode: { type: "string", description: "Aus or Nzl" },
        address: { type: "string" },
      },
    },
  },

  // Wallets
  {
    name: "payleader_get_possible_wallet_clients",
    description: "List potential wallet clients for a given merchant/user.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: {
        legacyUserId: { type: "string", description: "Merchant legacy user ID" },
      },
    },
  },
  {
    name: "payleader_create_wallet_invite",
    description: "Create a wallet invitation for a customer.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: {
        legacyUserId: { type: "string", description: "Merchant legacy user ID" },
        email: { type: "string" },
        mobile: { type: "string" },
        firstName: { type: "string" },
        lastName: { type: "string" },
      },
    },
  },
  {
    name: "payleader_get_wallet_invite",
    description: "Retrieve details of a wallet invitation by UUID.",
    inputSchema: {
      type: "object",
      required: ["inviteUuid"],
      properties: {
        inviteUuid: { type: "string", description: "Wallet invitation UUID" },
      },
    },
  },
  {
    name: "payleader_send_wallet_verification_code",
    description: "Send a verification code for a wallet invitation.",
    inputSchema: {
      type: "object",
      required: ["walletInvitationId"],
      properties: {
        walletInvitationId: { type: "string" },
      },
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
        code: { type: "string", description: "Verification code" },
      },
    },
  },

  // Memberships
  {
    name: "payleader_list_memberships",
    description: "List memberships for a merchant user, with optional status filter.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: {
        legacyUserId: { type: "string", description: "Merchant legacy user ID" },
        status: { type: "string", description: "Filter by membership status" },
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
        legacyUserId: { type: "string", description: "Merchant legacy user ID" },
        legacyCustomerUserId: { type: "string", description: "Customer legacy user ID" },
        treatments: {
          type: "array",
          description: "Array of treatment objects",
          items: { type: "object" },
        },
        perks: {
          type: "array",
          description: "Array of perk objects",
          items: { type: "object" },
        },
        paymentOption: {
          type: "string",
          description: "Payment option enum value",
        },
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
      properties: {
        legacyUserId: { type: "string" },
      },
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
      properties: {
        legacyUserId: { type: "string" },
      },
    },
  },
  {
    name: "payleader_get_merchant_claims",
    description: "Get claims for a merchant.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: {
        legacyUserId: { type: "string" },
      },
    },
  },
  {
    name: "payleader_get_merchant_settings",
    description: "Retrieve settings for a merchant.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: {
        legacyUserId: { type: "string" },
      },
    },
  },
  {
    name: "payleader_list_staff",
    description: "List staff users for a merchant.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: {
        legacyUserId: { type: "string" },
      },
    },
  },
  {
    name: "payleader_add_staff",
    description: "Add a staff member to a merchant.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId", "userId"],
      properties: {
        legacyUserId: { type: "string", description: "Merchant legacy user ID" },
        userId: { type: "string", description: "Staff user ID to add" },
        role: { type: "string", description: "Staff role or permissions" },
      },
    },
  },
  {
    name: "payleader_get_merchant_integrations",
    description: "List external app integrations configured for a merchant.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: {
        legacyUserId: { type: "string" },
      },
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
        legacyUserId: { type: "string", description: "Merchant legacy user ID" },
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
        legacyUserId: { type: "string", description: "Merchant legacy user ID" },
        legacyBuyerId: { type: "string", description: "Buyer legacy user ID" },
      },
    },
  },
  {
    name: "payleader_get_zai_session_token",
    description: "Obtain a Zai payment gateway session token for a merchant.",
    inputSchema: {
      type: "object",
      required: ["legacyUserId"],
      properties: {
        legacyUserId: { type: "string" },
      },
    },
  },

  // Reports
  {
    name: "payleader_list_audit",
    description:
      "Query audit logs. Supports filtering by date range, user, and action type (Purchase, Refund, PartialRefund, Void, PayNow, SecondaryAttempt).",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number" },
        limit: { type: "number" },
        search: { type: "string" },
        startDate: { type: "string", description: "ISO date string" },
        endDate: { type: "string", description: "ISO date string" },
        userId: { type: "string" },
        actionType: {
          type: "string",
          description:
            "One of: Purchase, Refund, PartialRefund, Void, PayNow, SecondaryAttempt",
        },
      },
    },
  },
];

// ─── Tool Handlers ────────────────────────────────────────────────────────────

type Input = Record<string, unknown>;

async function handleTool(name: string, input: Input): Promise<unknown> {
  switch (name) {
    // ── Auth ──────────────────────────────────────────────────────────────────
    case "payleader_authenticate": {
      if (input.username) envUsername = input.username as string;
      if (input.password) envPassword = input.password as string;
      await login(input.username as string | undefined, input.password as string | undefined);
      return { success: true, message: "Authenticated successfully" };
    }

    case "payleader_logout": {
      if (accessToken) {
        await api("POST", "/v2/users/logout", { token: accessToken }).catch(() => null);
        accessToken = null;
        refreshTokenValue = null;
        tokenExpiry = 0;
      }
      return { success: true, message: "Logged out" };
    }

    // ── Users ─────────────────────────────────────────────────────────────────
    case "payleader_get_current_user":
      return api("GET", "/v2/users/current");

    case "payleader_get_user_by_id":
      return api("GET", `/v2/users/user/${input.userId}`);

    case "payleader_get_user_by_username":
      return api(
        "GET",
        `/v2/users/username/${encodeURIComponent(input.username as string)}`
      );

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
      return api(
        "POST",
        `/v2/wallets/${input.walletInvitationId}/send-verification-code`
      );

    case "payleader_validate_wallet_verification_code":
      return api(
        "GET",
        `/v2/wallets/${input.walletInvitationId}/validate-verification-code`,
        undefined,
        { code: input.code }
      );

    // ── Memberships ───────────────────────────────────────────────────────────
    case "payleader_list_memberships":
      return api(
        "GET",
        `/v2/memberships/${input.legacyUserId}/memberships`,
        undefined,
        { status: input.status, Page: input.page, Limit: input.limit }
      );

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
        {
          status: input.status,
          treatments: input.treatments,
          perks: input.perks,
        }
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

// ─── Server Setup ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "payleader-internal-api", version: "1.0.0" },
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
