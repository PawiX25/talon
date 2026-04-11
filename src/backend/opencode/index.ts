/**
 * OpenCode backend — uses the OpenCode SDK as an alternative to Claude Agent SDK.
 *
 * Implements the same QueryBackend interface so it's a drop-in replacement.
 * Manages an OpenCode server process and routes queries through it.
 */

import { setTimeout as sleep } from "node:timers/promises";
import {
  createOpencodeClient,
  createOpencodeServer,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import type { TalonConfig } from "../../util/config.js";
import type { QueryParams, QueryResult } from "../../core/types.js";
import {
  getSession,
  incrementTurns,
  recordUsage,
  setSessionId,
  setSessionName,
  resetSession,
} from "../../storage/sessions.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { classify } from "../../core/errors.js";
import { log, logError, logWarn } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";

// ── State ───────────────────────────────────────────────────────────────────

let config: TalonConfig;
let client: OpencodeClient | null = null;
let clientPromise: Promise<OpencodeClient> | null = null;
let serverHandle: { url: string; close(): void } | null = null;
let gatewayPortFn: () => number = () => 19876;
const modelProviderCache = new Map<string, string>();

const OPENCODE_HOSTNAME = "127.0.0.1";
const OPENCODE_PORT = 4096;
const OPENCODE_BASE_URL = `http://${OPENCODE_HOSTNAME}:${OPENCODE_PORT}`;
const TALON_MCP_SERVER_NAME = "talon-tools";
const OPENCODE_SYSTEM_PROMPT_SUFFIX = `

## OpenCode Delivery Override

- You are running through Talon's OpenCode backend.
- Return your normal user-facing reply as plain assistant text.
- Do not rely on the Telegram send tool for ordinary replies.
- Use tools only when they are genuinely needed for side effects or extra capabilities.
`;

function createStrictOpencodeClient(baseUrl: string): OpencodeClient {
  return createOpencodeClient({
    baseUrl,
    throwOnError: true,
  });
}

function guessProviderID(modelID: string): string {
  const lowerModelID = modelID.toLowerCase();
  if (
    lowerModelID.includes("gpt") ||
    lowerModelID.startsWith("o1") ||
    lowerModelID.startsWith("o3") ||
    lowerModelID.startsWith("o4")
  ) {
    return "openai";
  }
  if (lowerModelID.includes("gemini")) return "google";
  if (lowerModelID.includes("claude")) return "anthropic";
  return "opencode";
}

function getBucketPriority(bucketName: string): number {
  switch (bucketName) {
    case "connected":
      return 0;
    case "configured":
      return 1;
    case "available":
      return 2;
    case "all":
      return 3;
    default:
      return 4;
  }
}

function extractPartsSummary(
  parts: Array<Record<string, unknown>>,
): { text: string; toolCalls: number } {
  const textParts: string[] = [];
  let toolCalls = 0;

  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      textParts.push(part.text);
    } else if (part.type === "tool") {
      toolCalls++;
    }
  }

  return {
    text: textParts.join("\n\n").trim(),
    toolCalls,
  };
}

function getChatMcpServerName(chatId: string): string {
  const safeChatId = chatId.replace(/[^a-zA-Z0-9_-]+/g, "_") || "chat";
  return `${TALON_MCP_SERVER_NAME}-${safeChatId}`;
}

function isTalonToolID(toolID: string): boolean {
  return (
    toolID.startsWith(`${TALON_MCP_SERVER_NAME}_`) ||
    toolID.startsWith(`${TALON_MCP_SERVER_NAME}-`)
  );
}

function summarizeQuestionHeaders(
  questions: Array<Record<string, unknown>>,
): string {
  return questions
    .map((question) => {
      if (typeof question.header === "string" && question.header.trim()) {
        return question.header.trim();
      }

      if (typeof question.question === "string" && question.question.trim()) {
        return question.question.trim();
      }

      return null;
    })
    .filter((value): value is string => Boolean(value))
    .join(" | ");
}

async function rejectPendingQuestions(
  oc: OpencodeClient,
  sessionId: string,
  chatId: string,
  seenQuestionIds: Set<string>,
): Promise<void> {
  const questionsResp = await oc.question.list();
  const pendingQuestions = Array.isArray(questionsResp.data)
    ? questionsResp.data
    : [];

  for (const request of pendingQuestions) {
    if (!request || typeof request !== "object") continue;

    const data = request as {
      id?: string;
      sessionID?: string;
      questions?: Array<Record<string, unknown>>;
    };

    const requestId = data.id;
    if (!requestId || data.sessionID !== sessionId) continue;
    if (seenQuestionIds.has(requestId)) continue;

    seenQuestionIds.add(requestId);
    const questions = Array.isArray(data.questions) ? data.questions : [];
    const summary = summarizeQuestionHeaders(questions);

    logWarn(
      "agent",
      `[${chatId}] Rejecting OpenCode question ${requestId}${summary ? `: ${summary}` : ""}`,
    );

    try {
      await oc.question.reject({ requestID: requestId });
    } catch (err) {
      logWarn(
        "agent",
        `[${chatId}] Failed to reject OpenCode question ${requestId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

async function waitForPromptWithQuestionGuard(
  oc: OpencodeClient,
  parameters: Parameters<OpencodeClient["session"]["prompt"]>[0],
  chatId: string,
  seenQuestionIds: Set<string>,
) {
  let finished = false;

  const watchdog = (async () => {
    while (!finished) {
      try {
        await rejectPendingQuestions(
          oc,
          parameters.sessionID,
          chatId,
          seenQuestionIds,
        );
      } catch (err) {
        logWarn(
          "agent",
          `[${chatId}] Failed while polling OpenCode questions: ${err instanceof Error ? err.message : err}`,
        );
      }

      if (!finished) {
        await sleep(350);
      }
    }
  })();

  try {
    return await oc.session.prompt(parameters);
  } finally {
    finished = true;
    await watchdog;
    await rejectPendingQuestions(
      oc,
      parameters.sessionID,
      chatId,
      seenQuestionIds,
    );
  }
}

async function waitForAssistantReply(
  oc: OpencodeClient,
  sessionId: string,
  minCreatedAt: number,
  chatId: string,
  seenQuestionIds: Set<string>,
): Promise<{ text: string; toolCalls: number }> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    await rejectPendingQuestions(oc, sessionId, chatId, seenQuestionIds);

    const messagesResp = await oc.session.messages({
      sessionID: sessionId,
      limit: 20,
    });
    const messages = Array.isArray(messagesResp.data) ? messagesResp.data : [];

    const assistantMessages = messages
      .map((message) => {
        if (!message || typeof message !== "object") return null;

        const data = message as {
          info?: { role?: string; time?: { created?: number } };
          parts?: Array<Record<string, unknown>>;
        };

        return {
          createdAt: data.info?.time?.created ?? 0,
          role: data.info?.role,
          parts: Array.isArray(data.parts) ? data.parts : [],
        };
      })
      .filter(
        (
          message,
        ): message is {
          createdAt: number;
          role?: string;
          parts: Array<Record<string, unknown>>;
        } => Boolean(message && message.role === "assistant"),
      )
      .sort((left, right) => right.createdAt - left.createdAt);

    for (const message of assistantMessages) {
      if (message.createdAt < minCreatedAt) continue;

      const summary = extractPartsSummary(message.parts);
      if (summary.text || summary.toolCalls > 0) {
        return summary;
      }
    }

    await sleep(500);
  }

  return { text: "", toolCalls: 0 };
}

async function resolveProviderID(
  oc: OpencodeClient,
  modelID: string,
): Promise<string> {
  const cachedProviderID = modelProviderCache.get(modelID);
  if (cachedProviderID) return cachedProviderID;

  const providerResp = await oc.provider.list();
  const providerBuckets =
    (providerResp.data as Record<string, unknown> | undefined) ?? {};
  const guessedProviderID = guessProviderID(modelID);
  const matches: Array<{ providerID: string; bucketName: string }> = [];

  for (const [bucketName, bucket] of Object.entries(providerBuckets)) {
    if (!Array.isArray(bucket)) continue;

    for (const provider of bucket) {
      if (!provider || typeof provider !== "object") continue;

      const providerData = provider as {
        id?: string;
        models?: Record<string, { providerID?: string }>;
      };

      const modelEntry = providerData.models?.[modelID];
      if (!modelEntry) continue;

      const providerID = modelEntry.providerID ?? providerData.id;
      if (!providerID) continue;

      matches.push({ providerID, bucketName });
    }
  }

  if (matches.length > 0) {
    matches.sort((left, right) => {
      const leftGuessPenalty = left.providerID === guessedProviderID ? 0 : 1;
      const rightGuessPenalty = right.providerID === guessedProviderID ? 0 : 1;
      if (leftGuessPenalty !== rightGuessPenalty) {
        return leftGuessPenalty - rightGuessPenalty;
      }

      const leftOpencodePenalty = left.providerID === "opencode" ? 0 : 1;
      const rightOpencodePenalty = right.providerID === "opencode" ? 0 : 1;
      if (leftOpencodePenalty !== rightOpencodePenalty) {
        return leftOpencodePenalty - rightOpencodePenalty;
      }

      return (
        getBucketPriority(left.bucketName) - getBucketPriority(right.bucketName)
      );
    });

    const resolvedProviderID = matches[0].providerID;
    modelProviderCache.set(modelID, resolvedProviderID);
    return resolvedProviderID;
  }

  const fallbackProviderID = guessProviderID(modelID);
  modelProviderCache.set(modelID, fallbackProviderID);
  logWarn(
    "agent",
    `Could not resolve provider for model ${modelID}; falling back to ${fallbackProviderID}`,
  );
  return fallbackProviderID;
}

export function initOpenCodeAgent(
  cfg: TalonConfig,
  getGatewayPort?: () => number,
): void {
  config = cfg;
  if (getGatewayPort) gatewayPortFn = getGatewayPort;
}

// ── Server lifecycle ────────────────────────────────────────────────────────

async function ensureServer(): Promise<OpencodeClient> {
  if (client) return client;
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const existingClient = await reuseExistingServer();
    if (existingClient) {
      client = existingClient;
      return existingClient;
    }

    log("agent", "Starting OpenCode server...");

    try {
      const server = await createOpencodeServer({
        hostname: OPENCODE_HOSTNAME,
        port: OPENCODE_PORT,
        timeout: 10_000,
      });
      client = createStrictOpencodeClient(server.url);
      serverHandle = server;
      log("agent", `OpenCode server running at ${server.url}`);
    } catch (err) {
      const reusedClient = await reuseExistingServer();
      if (!reusedClient) throw err;

      client = reusedClient;
      logWarn(
        "agent",
        `OpenCode server already became available at ${OPENCODE_BASE_URL}; reusing it`,
      );
    }

    return client;
  })();

  try {
    return await clientPromise;
  } finally {
    clientPromise = null;
  }
}

async function reuseExistingServer(): Promise<OpencodeClient | null> {
  try {
    const response = await fetch(`${OPENCODE_BASE_URL}/global/health`);
    if (!response.ok) return null;

    const existingClient = createStrictOpencodeClient(OPENCODE_BASE_URL);
    log("agent", `Reusing OpenCode server at ${OPENCODE_BASE_URL}`);
    return existingClient;
  } catch {
    return null;
  }
}

async function registerMcpServer(oc: OpencodeClient): Promise<void> {
  await ensureChatMcpServer(oc, "default");
}

async function ensureChatMcpServer(
  oc: OpencodeClient,
  chatId: string,
): Promise<string> {
  const serverName = getChatMcpServerName(chatId);

  try {
    const statusResp = await oc.mcp.status();
    const mcpServers =
      (statusResp.data as Record<string, { status?: string }> | undefined) ?? {};
    const talonTools = mcpServers[serverName];

    if (talonTools?.status === "connected") {
      return serverName;
    }

    const toolsPath = new URL("../../core/tools/mcp-server.ts", import.meta.url)
      .pathname;
    await oc.mcp.add({
      name: serverName,
      config: {
        type: "local" as const,
        command: ["node", "--import", "tsx", toolsPath],
        environment: {
          TALON_BRIDGE_URL: `http://127.0.0.1:${gatewayPortFn()}`,
          TALON_CHAT_ID: chatId,
          TALON_FRONTEND: "telegram",
        },
      },
    });
    log("agent", `Registered ${serverName} MCP server with OpenCode`);
  } catch (err) {
    logWarn(
      "agent",
      `MCP registration failed for ${serverName} (tools may not be available): ${err instanceof Error ? err.message : err}`,
    );
  }

  return serverName;
}

async function buildToolOverrides(
  oc: OpencodeClient,
  chatServerName: string,
): Promise<Record<string, boolean> | undefined> {
  try {
    const toolIdsResp = await oc.tool.ids();
    const toolIds = Array.isArray(toolIdsResp.data) ? toolIdsResp.data : [];
    const overrides: Record<string, boolean> = {};
    const chatToolPrefix = `${chatServerName}_`;
    let matchedChatTool = false;

    for (const toolId of toolIds) {
      if (typeof toolId !== "string" || !isTalonToolID(toolId)) continue;

      const enabled = toolId.startsWith(chatToolPrefix);
      overrides[toolId] = enabled;
      matchedChatTool ||= enabled;
    }

    return matchedChatTool ? overrides : undefined;
  } catch (err) {
    logWarn(
      "agent",
      `Failed to build OpenCode tool overrides for ${chatServerName}: ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
}

async function disconnectChatMcpServer(
  oc: OpencodeClient,
  serverName: string,
): Promise<void> {
  try {
    await oc.mcp.disconnect({ name: serverName });
  } catch (err) {
    logWarn(
      "agent",
      `Failed to disconnect ${serverName}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export function stopOpenCodeServer(): void {
  clientPromise = null;
  modelProviderCache.clear();
  if (serverHandle) {
    serverHandle.close();
    serverHandle = null;
    client = null;
    log("agent", "OpenCode server stopped");
  }
}

// ── Session management ──────────────────────────────────────────────────────

async function ensureSession(
  oc: OpencodeClient,
  chatId: string,
): Promise<string> {
  const session = getSession(chatId);

  if (session.sessionId) {
    // Verify session still exists
    try {
      await oc.session.get({ sessionID: session.sessionId });
      return session.sessionId;
    } catch {
      logWarn(
        "agent",
        `[${chatId}] Session ${session.sessionId} expired, creating new`,
      );
      resetSession(chatId);
    }
  }

  // Create new session
  const resp = await oc.session.create({ title: `Chat ${chatId}` });

  // Extract session ID from response
  const data = resp.data as Record<string, unknown> | undefined;
  const newId = (data?.id as string) ?? String(Date.now());
  setSessionId(chatId, newId);
  log("agent", `[${chatId}] Created OpenCode session: ${newId}`);
  return newId;
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function handleMessage(
  params: QueryParams,
  _retried = false,
): Promise<QueryResult> {
  if (!config) throw new Error("OpenCode agent not initialized");

  const { chatId, text, senderName, isGroup, onTextBlock } = params;
  const t0 = Date.now();

  const chatSettings = getChatSettings(chatId);
  const activeModel = chatSettings.model ?? config.model;
  const modelID = activeModel;

  const oc = await ensureServer();
  const providerID = await resolveProviderID(oc, modelID);
  const sessionId = await ensureSession(oc, chatId);
  const chatMcpServerName = await ensureChatMcpServer(oc, chatId);
  const toolOverrides = await buildToolOverrides(oc, chatMcpServerName);
  const seenQuestionIds = new Set<string>();

  // Build prompt with group context
  const msgIdHint = params.messageId ? ` [msg_id:${params.messageId}]` : "";
  const prompt = isGroup
    ? `[${senderName}]${msgIdHint}: ${text}`
    : `${text}${msgIdHint}`;

  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  try {
    const promptStartedAt = Date.now();
    const resp = await waitForPromptWithQuestionGuard(
      oc,
      {
      sessionID: sessionId,
      parts: [{ type: "text" as const, text: prompt }],
      model: { providerID, modelID },
      system: config.systemPrompt + OPENCODE_SYSTEM_PROMPT_SUFFIX,
      ...(toolOverrides ? { tools: toolOverrides } : {}),
      },
      chatId,
      seenQuestionIds,
    );

    const data = resp.data as Record<string, unknown> | undefined;
    const parts = Array.isArray(data?.parts)
      ? (data.parts as Array<Record<string, unknown>>)
      : [];

    let { text: responseText, toolCalls } = extractPartsSummary(parts);

    if (!responseText) {
      const fallbackReply = await waitForAssistantReply(
        oc,
        sessionId,
        promptStartedAt,
        chatId,
        seenQuestionIds,
      );
      responseText = fallbackReply.text;
      toolCalls = Math.max(toolCalls, fallbackReply.toolCalls);
    }

    if (!responseText) {
      logWarn(
        "agent",
        `[${chatId}] OpenCode returned no assistant text for ${providerID}/${modelID}`,
      );
      responseText =
        "Sorry — I got an empty response from OpenCode. Please try again.";
    }

    if (responseText && onTextBlock) {
      await onTextBlock(responseText);
    }

    const durationMs = Date.now() - t0;

    // Persist session state
    incrementTurns(chatId);
    recordUsage(chatId, {
      inputTokens: 0, // OpenCode doesn't expose token counts in the same way
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      durationMs,
      model: activeModel,
    });

    if (getSession(chatId).turns === 0 && text) {
      const cleanText = text
        .replace(/^\[.*?\]\s*/g, "")
        .replace(/\[msg_id:\d+\]\s*/g, "")
        .trim();
      if (cleanText) {
        setSessionName(
          chatId,
          cleanText.length > 30 ? cleanText.slice(0, 30) + "..." : cleanText,
        );
      }
    }

    log(
      "agent",
      `[${chatId}] -> (${durationMs}ms${toolCalls > 0 ? ` tools=${toolCalls}` : ""})`,
    );
    traceMessage(chatId, "out", responseText, { durationMs, toolCalls });

    return {
      text: responseText.trim(),
      durationMs,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
  } catch (err) {
    const classified = classify(err);
    // Session expired — reset and retry once
    if (classified.reason === "session_expired" && !_retried) {
      logWarn("agent", `[${chatId}] OpenCode session expired, retrying`);
      resetSession(chatId);
      return handleMessage(params, true);
    }
    logError("agent", `[${chatId}] OpenCode error: ${classified.message}`);
    throw classified;
  } finally {
    await disconnectChatMcpServer(oc, chatMcpServerName);
  }
}
