// Helper functions extracted from streamChatResponse.ts to reduce file size
/* eslint-disable max-lines */

import type { ModelConfig } from "@continuedev/config-yaml";
import type { BaseLlmApi } from "@continuedev/openai-adapters";
import type { ToolStatus, Usage } from "core/index.js";
import { calculateRequestCost } from "core/llm/utils/calculateRequestCost.js";
import { ContinueError, ContinueErrorReason } from "core/util/errors.js";
import { ChatCompletionToolMessageParam } from "openai/resources/chat/completions.mjs";

import { ToolPermissionServiceState } from "src/services/ToolPermissionService.js";

import { checkToolPermission } from "../permissions/permissionChecker.js";
import { toolPermissionManager } from "../permissions/permissionManager.js";
import { ToolCallRequest, ToolPermissions } from "../permissions/types.js";
import {
  SERVICE_NAMES,
  serviceContainer,
  services,
} from "../services/index.js";
import { trackSessionUsage } from "../session.js";
import { telemetryService } from "../telemetry/telemetryService.js";
import {
  executeToolCall,
  getAllAvailableTools,
  Tool,
  validateToolCallArgsPresent,
} from "../tools/index.js";
import { PreprocessedToolCall, ToolCall } from "../tools/types.js";
import { chatCompletionStreamWithBackoff } from "../util/exponentialBackoff.js";
import { logger } from "../util/logger.js";

import { StreamCallbacks } from "./streamChatResponse.types.js";

export interface ToolResultWithStatus extends ChatCompletionToolMessageParam {
  status: ToolStatus;
}

// Helper function to handle permission denied
export function handlePermissionDenied(
  toolCall: PreprocessedToolCall,
  chatHistoryEntries: ChatCompletionToolMessageParam[],
  callbacks?: StreamCallbacks,
  reason: "user" | "policy" = "user",
): void {
  const deniedMessage =
    reason === "policy"
      ? `Command blocked by security policy`
      : `Permission denied by user`;

  logger.info("Tool call denied", {
    name: toolCall.name,
    arguments: toolCall.arguments,
    reason,
  });

  chatHistoryEntries.push({
    role: "tool",
    tool_call_id: toolCall.id,
    content: deniedMessage,
  });

  callbacks?.onToolResult?.(deniedMessage, toolCall.name, "canceled");
  logger.debug(`Tool call rejected (${reason}) - stopping stream`);
}

// Helper function to request user permission
export async function requestUserPermission(
  toolCall: PreprocessedToolCall,
  callbacks?: StreamCallbacks,
): Promise<boolean> {
  if (!callbacks?.onToolPermissionRequest) {
    return false;
  }

  const toolCallRequest: ToolCallRequest = {
    name: toolCall.name,
    arguments: toolCall.preprocessResult?.args ?? toolCall.arguments,
    preview: toolCall.preprocessResult?.preview,
  };

  // Set up listener for permissionRequested event
  const handlePermissionRequested = (event: {
    requestId: string;
    toolCall: ToolCallRequest;
  }) => {
    if (event.toolCall.name === toolCall.name) {
      toolPermissionManager.off(
        "permissionRequested",
        handlePermissionRequested,
      );
      // Notify UI about permission request
      callbacks.onToolPermissionRequest!(
        event.toolCall.name,
        event.toolCall.arguments,
        event.requestId,
        event.toolCall.preview,
      );
    }
  };

  toolPermissionManager.on("permissionRequested", handlePermissionRequested);

  // Request permission using the proper API
  const permissionResult =
    await toolPermissionManager.requestPermission(toolCallRequest);

  // Clean up listener in case the condition above was never met
  // This is a safety net to ensure no listeners are left behind
  toolPermissionManager.off("permissionRequested", handlePermissionRequested);

  return permissionResult.approved;
}

function buildAiReviewPrompt(toolCall: PreprocessedToolCall): string {
  const args = toolCall.preprocessResult?.args ?? toolCall.arguments;
  const preview = toolCall.preprocessResult?.preview;

  return `Review this tool call in isolation. You do not have the previous conversation context.

Question: is it safe to run this, or is there a problem?

Rules:
- If there is any problem, meaningful risk, ambiguity, destructive action, credential exposure, data loss risk, privilege escalation, network exfiltration risk, or command-injection concern, deny it.
- Allow only when the tool call is clearly safe.
- Respond with exactly one line in this format:
DECISION: ALLOW | REASON: short reason
or
DECISION: DENY | REASON: short reason

Tool: ${toolCall.name}
Arguments:
${JSON.stringify(args, null, 2)}${
    preview ? `\nPreview:\n${JSON.stringify(preview, null, 2)}` : ""
  }`;
}

function parseAiReviewDecision(response: string): {
  approved: boolean;
  reason: string;
} {
  const normalized = response.trim();
  const decisionMatch = normalized.match(/\bDECISION:\s*(ALLOW|DENY)\b/i);
  const reasonMatch = normalized.match(/\bREASON:\s*(.+)$/is);
  const reason = reasonMatch?.[1]?.trim() || "No reason provided";

  if (!decisionMatch) {
    return {
      approved: false,
      reason: `AI review returned an invalid decision: ${normalized.slice(0, 200)}`,
    };
  }

  return {
    approved: decisionMatch[1].toUpperCase() === "ALLOW",
    reason,
  };
}

export async function requestAiReviewPermission(
  toolCall: PreprocessedToolCall,
  model?: ModelConfig,
  llmApi?: BaseLlmApi,
): Promise<{ approved: boolean; reason: string }> {
  if (!model || !llmApi) {
    return {
      approved: false,
      reason: "AI review unavailable because no active model/API was provided",
    };
  }

  try {
    const abortController = new AbortController();
    const stream = await chatCompletionStreamWithBackoff(
      llmApi,
      {
        model: model.model,
        messages: [
          {
            role: "system",
            content:
              "You are a strict tool-call safety reviewer. Review only the provided tool call. If you see any problem or risk, deny it. Return only the requested decision line.",
          },
          {
            role: "user",
            content: buildAiReviewPrompt(toolCall),
          },
        ],
        stream: true,
        ...getDefaultCompletionOptions(model.defaultCompletionOptions),
      },
      abortController.signal,
    );

    let response = "";
    for await (const chunk of stream) {
      response += chunk.choices?.[0]?.delta?.content ?? "";
    }

    return parseAiReviewDecision(response);
  } catch (error) {
    logger.error("AI permission review failed", {
      name: toolCall.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      approved: false,
      reason: `AI review failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

// Helper function to check if tool permission is needed
export async function checkToolPermissionApproval(
  permissions: ToolPermissions,
  toolCall: PreprocessedToolCall,
  callbacks?: StreamCallbacks,
  isHeadless?: boolean,
  model?: ModelConfig,
  llmApi?: BaseLlmApi,
): Promise<{
  approved: boolean;
  denialReason?: "user" | "policy";
  denialMessage?: string;
  denialSource?: "user" | "policy" | "aiReview";
}> {
  const permissionCheck = checkToolPermission(toolCall, permissions);

  if (permissionCheck.permission === "allow") {
    return { approved: true };
  } else if (permissionCheck.permission === "ask") {
    if (isHeadless) {
      // "ask" tools are excluded in headless so can only get here by policy evaluation
      return { approved: false, denialReason: "policy" };
    }
    const userApproved = await requestUserPermission(toolCall, callbacks);
    return userApproved
      ? { approved: true }
      : { approved: false, denialReason: "user" };
  } else if (permissionCheck.permission === "review") {
    const review = await requestAiReviewPermission(toolCall, model, llmApi);
    return review.approved
      ? { approved: true }
      : {
          approved: false,
          denialReason: "policy",
          denialSource: "aiReview",
          denialMessage: `The AI reviewer denied this tool call before execution. Reason: ${review.reason}. Do not retry the same tool call unless you change it to address this reason.`,
        };
  } else if (permissionCheck.permission === "reviewAsk") {
    const review = await requestAiReviewPermission(toolCall, model, llmApi);
    if (!review.approved) {
      return {
        approved: false,
        denialReason: "policy",
        denialSource: "aiReview",
        denialMessage: `The AI reviewer denied this tool call before execution. Reason: ${review.reason}. Do not retry the same tool call unless you change it to address this reason.`,
      };
    }

    if (isHeadless) {
      return {
        approved: false,
        denialReason: "policy",
        denialMessage:
          "AI review allowed tool call, but user confirmation is unavailable in headless mode",
      };
    }

    const userApproved = await requestUserPermission(toolCall, callbacks);
    return userApproved
      ? { approved: true }
      : { approved: false, denialReason: "user" };
  } else if (permissionCheck.permission === "exclude") {
    // Tool blocked by security policy
    return { approved: false, denialReason: "policy" };
  }

  return { approved: false, denialReason: "policy" };
}

// Helper function to track first token time
export function trackFirstTokenTime(
  firstTokenTime: number | null,
  chunk: any,
  requestStartTime: number,
  model: any,
  tools?: any[],
): number | null {
  if (
    firstTokenTime === null &&
    chunk.choices?.[0]?.delta &&
    (chunk.choices[0].delta.content || chunk.choices[0].delta.tool_calls)
  ) {
    const tokenTime = Date.now();
    telemetryService.recordResponseTime(
      tokenTime - requestStartTime,
      model.model,
      "time_to_first_token",
      (tools?.length || 0) > 0,
    );
    return tokenTime;
  }
  return firstTokenTime;
}

// Helper function to process content from a chunk
export function processChunkContent(
  content: string,
  aiResponse: string,
  callbacks?: StreamCallbacks,
  isHeadless?: boolean,
): string {
  const updatedResponse = aiResponse + content;

  if (callbacks?.onContent) {
    callbacks.onContent(content);
  } else if (!isHeadless) {
    process.stdout.write(content);
  }

  return updatedResponse;
}

// Helper function to handle tool call delta
export function processToolCallDelta(
  toolCallDelta: any,
  toolCallsMap: Map<string, ToolCall>,
  indexToIdMap: Map<number, string>,
): void {
  let toolCallId: string | undefined;

  // If we have an ID, use it and map the index
  if (toolCallDelta.id) {
    toolCallId = toolCallDelta.id;
    if (toolCallDelta.index !== undefined && toolCallId) {
      indexToIdMap.set(toolCallDelta.index, toolCallId);
    }
  } else if (toolCallDelta.index !== undefined) {
    // No ID, but we have an index - look up the ID from our map
    toolCallId = indexToIdMap.get(toolCallDelta.index);
  }

  if (!toolCallId) {
    logger.warn("Tool call delta without ID or valid index mapping", {
      toolCallDelta,
    });
    return;
  }

  // Create tool call entry if it doesn't exist
  if (!toolCallsMap.has(toolCallId)) {
    toolCallsMap.set(toolCallId, {
      id: toolCallId,
      name: "",
      arguments: {},
      argumentsStr: "",
      startNotified: false,
    });
  }

  const toolCall = toolCallsMap.get(toolCallId);
  if (!toolCall) {
    logger.warn("Tool call not found in map", { toolCallId });
    return;
  }

  // Update name
  if (toolCallDelta.function?.name) {
    toolCall.name = toolCallDelta.function.name;
  }

  // Accumulate arguments
  if (toolCallDelta.function?.arguments) {
    toolCall.argumentsStr += toolCallDelta.function.arguments;

    // Try to parse when we might have complete JSON
    try {
      toolCall.arguments = JSON.parse(toolCall.argumentsStr);
      toolCall.startNotified = true;
    } catch {
      // JSON not complete yet, continue
    }
  }

  // Capture extra_content
  if (toolCallDelta.extra_content) {
    toolCall.extra_content = toolCallDelta.extra_content;
  }
}

// Helper function to detect provider from model name
function detectProvider(modelName: string): string {
  const normalized = modelName.toLowerCase();
  if (normalized.includes("gpt") || normalized.includes("openai")) {
    return "openai";
  }
  if (normalized.includes("claude") || normalized.includes("anthropic")) {
    return "anthropic";
  }
  // Default to anthropic for backward compatibility
  return "anthropic";
}

// Simple fallback cost calculation for unknown models
function calculateFallbackCost(
  inputTokens: number,
  outputTokens: number,
): number {
  // Default pricing: $1/MTok input, $2/MTok output
  return (inputTokens * 1 + outputTokens * 2) / 1_000_000;
}

// Helper function to record telemetry
export function recordStreamTelemetry(options: {
  requestStartTime: number;
  responseEndTime: number;
  inputTokens: number;
  outputTokens: number;
  model: any;
  tools?: any[];
  fullUsage?: any;
}): number {
  const {
    requestStartTime,
    responseEndTime,
    inputTokens,
    outputTokens,
    model,
    tools,
    fullUsage,
  } = options;
  const totalDuration = responseEndTime - requestStartTime;

  // Calculate cost using comprehensive pricing that includes caching
  let cost: number;
  let usage: Usage;

  if (fullUsage) {
    // Transform API usage format to Usage interface
    usage = {
      promptTokens: fullUsage.prompt_tokens,
      completionTokens: fullUsage.completion_tokens,
      promptTokensDetails: fullUsage.prompt_tokens_details
        ? {
            cachedTokens: fullUsage.prompt_tokens_details.cache_read_tokens,
            cacheWriteTokens:
              fullUsage.prompt_tokens_details.cache_write_tokens,
          }
        : undefined,
    };

    // Detect provider and calculate cost
    const provider = detectProvider(model.model);
    const costBreakdown = calculateRequestCost(provider, model.model, usage);

    // Use fallback for unknown models
    cost =
      costBreakdown?.cost ??
      calculateFallbackCost(
        fullUsage.prompt_tokens,
        fullUsage.completion_tokens,
      );
  } else {
    // Fallback when fullUsage not available
    usage = {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
    };
    cost = calculateFallbackCost(inputTokens, outputTokens);
  }

  // Use tokens from fullUsage if available, otherwise use the passed params
  const actualInputTokens = fullUsage?.prompt_tokens ?? inputTokens;
  const actualOutputTokens = fullUsage?.completion_tokens ?? outputTokens;

  telemetryService.recordTokenUsage(actualInputTokens, "input", model.model);
  telemetryService.recordTokenUsage(actualOutputTokens, "output", model.model);

  // Record cache tokens if available
  if (fullUsage?.prompt_tokens_details?.cache_read_tokens) {
    telemetryService.recordTokenUsage(
      fullUsage.prompt_tokens_details.cache_read_tokens,
      "cacheRead",
      model.model,
    );
  }
  if (fullUsage?.prompt_tokens_details?.cache_write_tokens) {
    telemetryService.recordTokenUsage(
      fullUsage.prompt_tokens_details.cache_write_tokens,
      "cacheCreation",
      model.model,
    );
  }

  telemetryService.recordCost(cost, model.model);
  trackSessionUsage(cost, usage);

  telemetryService.recordResponseTime(
    totalDuration,
    model.model,
    "total_response_time",
    (tools?.length || 0) > 0,
  );

  telemetryService.logApiRequest({
    model: model.model,
    durationMs: totalDuration,
    success: true,
    inputTokens: actualInputTokens,
    outputTokens: actualOutputTokens,
    costUsd: cost,
  });

  return cost;
}

/**
 * Processes tool calls by validating and preprocessing them
 * @param toolCalls - The raw tool calls from the LLM
 * @param callbacks - Optional callbacks for notifying of events
 * @returns - Preprocessed tool calls that are ready for execution
 */
export async function preprocessStreamedToolCalls(
  isHeadless: boolean,
  toolCalls: ToolCall[],
  callbacks?: StreamCallbacks,
): Promise<{
  preprocessedCalls: PreprocessedToolCall[];
  errorChatEntries: ChatCompletionToolMessageParam[];
}> {
  const preprocessedCalls: PreprocessedToolCall[] = [];
  const errorChatEntries: ChatCompletionToolMessageParam[] = [];

  // Get all available tools

  // Process each tool call
  for (const toolCall of toolCalls) {
    const startTime = Date.now();
    try {
      const availableTools: Tool[] = await getAllAvailableTools(isHeadless);
      const tool = availableTools.find((t) => t.name === toolCall.name);
      if (!tool) {
        throw new Error(`Tool ${toolCall.name} not found`);
      }

      validateToolCallArgsPresent(toolCall, tool);

      const preprocessedCall: PreprocessedToolCall = {
        ...toolCall,
        tool,
      };

      if (tool.preprocess) {
        logger.debug("Preprocessing tool call args", {
          name: toolCall.name,
          arguments: toolCall.arguments,
        });
        const preprocessed = await tool.preprocess(toolCall.arguments);
        preprocessedCall.preprocessResult = preprocessed;
      }

      preprocessedCalls.push(preprocessedCall);
    } catch (error) {
      // Notify the UI about the tool start, even though it failed
      callbacks?.onToolStart?.(toolCall.name, toolCall.arguments);

      const errorReason =
        error instanceof ContinueError
          ? error.reason
          : ContinueErrorReason.Unknown;

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      logger.error("Invalid tool call", {
        name: toolCall.name,
        error: errorMessage,
      });

      const duration = Date.now() - startTime;
      telemetryService.logToolResult({
        toolName: toolCall.name,
        success: false,
        durationMs: duration,
        error: errorMessage,
        errorReason,
        // modelName, TODO
      });
      // Add error to chat history
      errorChatEntries.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: errorMessage,
      });

      // Notify about the error
      callbacks?.onToolError?.(errorMessage, toolCall.name);
    }
  }

  return { preprocessedCalls, errorChatEntries };
}

/**
 * Executes preprocessed tool calls, handling permissions and results
 * @param preprocessedCalls - The preprocessed tool calls ready for execution
 * @param callbacks - Optional callbacks for notifying of events
 * @returns - Chat history entries with tool results and status information
 */
export async function executeStreamedToolCalls(
  preprocessedCalls: PreprocessedToolCall[],
  callbacks?: StreamCallbacks,
  isHeadless?: boolean,
  model?: ModelConfig,
  llmApi?: BaseLlmApi,
): Promise<{
  hasRejection: boolean;
  hasHeadlessBlockingRejection: boolean;
  chatHistoryEntries: ToolResultWithStatus[];
}> {
  // Strategy: queue permissions (preserve order), then run approved tools in parallel.
  // If any permission is rejected, cancel the remaining tools in this batch.
  //
  // NOTE: parallelToolCallCount is passed to each tool so they can divide their
  // output limits accordingly to avoid context overflow. Bash/Read do this for now
  const parallelToolCallCount = preprocessedCalls.length;

  type IndexedCall = { index: number; call: PreprocessedToolCall };
  const indexedCalls: IndexedCall[] = preprocessedCalls.map((call, index) => ({
    index,
    call,
  }));

  const entriesByIndex = new Map<number, ToolResultWithStatus>();
  const execPromises: Promise<void>[] = [];

  let hasRejection = false;
  let hasHeadlessBlockingRejection = false;

  // Permission phase (sequential)
  for (const { index, call } of indexedCalls) {
    // Do not cancel subsequent tools after a rejection; handle each independently

    try {
      logger.debug("Checking tool permissions", {
        name: call.name,
        arguments: call.arguments,
      });

      // Notify tool start before permission check to display in UI fallbacks
      callbacks?.onToolStart?.(call.name, call.arguments);

      // Check tool permissions using helper
      const permissionState =
        await serviceContainer.get<ToolPermissionServiceState>(
          SERVICE_NAMES.TOOL_PERMISSIONS,
        );
      const permissionResult = await checkToolPermissionApproval(
        permissionState.permissions,
        call,
        callbacks,
        isHeadless,
        model,
        llmApi,
      );

      if (!permissionResult.approved) {
        // Permission denied: create entry with canceled status
        const denialReason = permissionResult.denialReason || "user";
        const deniedMessage =
          permissionResult.denialMessage ??
          (denialReason === "policy"
            ? `Command blocked by security policy`
            : `Permission denied by user`);

        const deniedEntry: ToolResultWithStatus = {
          role: "tool",
          tool_call_id: call.id,
          content: deniedMessage,
          status: "canceled",
        };
        entriesByIndex.set(index, deniedEntry);
        callbacks?.onToolResult?.(
          String(deniedEntry.content),
          call.name,
          "canceled",
        );
        // Immediate service update for UI feedback
        try {
          services.chatHistory.addToolResult(
            call.id,
            String(deniedEntry.content),
            "canceled",
          );
        } catch {}
        hasRejection = true;
        if (permissionResult.denialSource !== "aiReview") {
          hasHeadlessBlockingRejection = true;
        }
        // Remaining items will be auto-cancelled in subsequent iterations
        continue;
      }

      // Immediately mark as calling for instant UI feedback
      try {
        services.chatHistory.updateToolStatus(call.id, "calling");
      } catch {}

      // Start execution immediately for approved calls
      execPromises.push(
        (async () => {
          try {
            logger.debug("Executing tool", {
              name: call.name,
              arguments: call.arguments,
            });

            const toolResult = await executeToolCall(call, {
              parallelToolCallCount,
            });
            const entry: ToolResultWithStatus = {
              role: "tool",
              tool_call_id: call.id,
              content: toolResult,
              status: "done",
            };
            entriesByIndex.set(index, entry);
            callbacks?.onToolResult?.(toolResult, call.name, "done");
            // Immediate service update for UI feedback
            try {
              services.chatHistory.addToolResult(
                call.id,
                String(toolResult),
                "done",
              );
            } catch {}
          } catch (error) {
            const errorMessage = `Error executing tool ${call.name}: ${
              error instanceof Error ? error.message : String(error)
            }`;
            logger.error("Tool execution failed", {
              name: call.name,
              error: errorMessage,
            });
            entriesByIndex.set(index, {
              role: "tool",
              tool_call_id: call.id,
              content: errorMessage,
              status: "errored",
            });
            callbacks?.onToolError?.(errorMessage, call.name);
            // Immediate service update for UI feedback
            try {
              services.chatHistory.addToolResult(
                call.id,
                errorMessage as string,
                "errored",
              );
            } catch {}
          }
        })(),
      );
    } catch (error) {
      const errorMessage = `Error checking permissions for ${call.name}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      logger.error("Permission check failed", {
        name: call.name,
        error: errorMessage,
      });
      entriesByIndex.set(index, {
        role: "tool",
        tool_call_id: call.id,
        content: errorMessage,
        status: "errored",
      });
      callbacks?.onToolError?.(errorMessage, call.name);
      // Treat permission errors like execution errors but do not stop the batch
      try {
        services.chatHistory.addToolResult(
          call.id,
          errorMessage as string,
          "errored",
        );
      } catch {}
    }
  }

  await Promise.all(execPromises);

  // Assemble final entries in original order
  const chatHistoryEntries: ToolResultWithStatus[] = preprocessedCalls
    .map((_, index) => entriesByIndex.get(index))
    .filter((e): e is ToolResultWithStatus => !!e);

  return {
    hasRejection,
    hasHeadlessBlockingRejection,
    chatHistoryEntries,
  };
}
