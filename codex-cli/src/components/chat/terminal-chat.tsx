import type { ApplyPatchCommand, ApprovalPolicy } from "../../approvals.js";
import type { CommandConfirmation } from "../../utils/agent/agent-loop.js";
import type { AppConfig } from "../../utils/config.js";
import type { CoreMessage } from "ai";
import type { ColorName } from "chalk";
import type { Model } from "src/utils/providers.js";

import TerminalChatInput from "./terminal-chat-input.js";
import { TerminalChatToolCallCommand } from "./terminal-chat-tool-call-command.js";
import TerminalMessageHistory from "./terminal-message-history.js";
import { formatCommandForDisplay } from "../../format-command.js";
import { useConfirmation } from "../../hooks/use-confirmation.js";
import { useTerminalSize } from "../../hooks/use-terminal-size.js";
import { AgentLoop } from "../../utils/agent/agent-loop.js";
import { ReviewDecision } from "../../utils/agent/review.js";
import {
  calculateContextPercentRemaining,
  getTextContent,
} from "../../utils/ai.js";
import { generateCompactSummary } from "../../utils/compact-summary.js";
import { saveConfig } from "../../utils/config.js";
import { extractAppliedPatches as _extractAppliedPatches } from "../../utils/extract-applied-patches.js";
import { getGitDiff } from "../../utils/get-diff.js";
import { createInputItem } from "../../utils/input-utils.js";
import { log } from "../../utils/logger/log.js";
import { MCPClientManager } from "../../utils/mcp/client-manager.js";
import { getLanguageModel } from "../../utils/providers.js";
import { CLI_VERSION } from "../../utils/session.js";
import { shortCwd } from "../../utils/short-path.js";
import { saveRollout } from "../../utils/storage/save-rollout.js";
import ApprovalModeOverlay from "../approval-mode-overlay.js";
import DiffOverlay from "../diff-overlay.js";
import HelpOverlay from "../help-overlay.js";
import HistoryOverlay from "../history-overlay.js";
import MCPOverlay from "../mcp-overlay.js";
import ModelOverlay from "../model-overlay.js";
import { generateText } from "ai";
import { Box, Text } from "ink";
import { spawn } from "node:child_process";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { inspect } from "util";

export type OverlayModeType =
  | "none"
  | "history"
  | "model"
  | "approval"
  | "help"
  | "diff"
  | "mcp";

type Props = {
  config: AppConfig;
  prompt?: string;
  imagePaths?: Array<string>;
  approvalPolicy: ApprovalPolicy;
  additionalWritableRoots: ReadonlyArray<string>;
  fullStdout: boolean;
};

const colorsByPolicy: Record<ApprovalPolicy, ColorName | undefined> = {
  "suggest": undefined,
  "auto-edit": "greenBright",
  "full-auto": "green",
};

/**
 * Generates an explanation for a shell command using the OpenAI API.
 *
 * @param command The command to explain
 * @param model The model to use for generating the explanation
 * @param config The configuration object
 * @returns A human-readable explanation of what the command does
 */
async function generateCommandExplanation(
  command: Array<string>,
  model: Model,
): Promise<string> {
  try {
    // Format the command for display
    const commandForDisplay = formatCommandForDisplay(command);

    // Use the Vercel AI SDK's generateText function
    const result = await generateText({
      model: getLanguageModel(model),
      messages: [
        {
          role: "system",
          content:
            "You are an expert in shell commands and terminal operations. Your task is to provide detailed, accurate explanations of shell commands that users are considering executing. Break down each part of the command, explain what it does, identify any potential risks or side effects, and explain why someone might want to run it. Be specific about what files or systems will be affected. If the command could potentially be harmful, make sure to clearly highlight those risks.",
        },
        {
          role: "user",
          content: `Please explain this shell command in detail: \`${commandForDisplay}\`\n\nProvide a structured explanation that includes:\n1. A brief overview of what the command does\n2. A breakdown of each part of the command (flags, arguments, etc.)\n3. What files, directories, or systems will be affected\n4. Any potential risks or side effects\n5. Why someone might want to run this command\n\nBe specific and technical - this explanation will help the user decide whether to approve or reject the command.`,
        },
      ],
    });

    // Extract the explanation from the response
    return result.text || "Unable to generate explanation.";
  } catch (error) {
    log(`Error generating command explanation: ${error}`);

    let errorMessage = "Unable to generate explanation due to an error.";
    if (error instanceof Error) {
      errorMessage = `Unable to generate explanation: ${error.message}`;

      // If it's an API error, check for more specific information
      if ("status" in error && typeof error.status === "number") {
        // Handle API-specific errors
        if (error.status === 401) {
          errorMessage =
            "Unable to generate explanation: API key is invalid or expired.";
        } else if (error.status === 429) {
          errorMessage =
            "Unable to generate explanation: Rate limit exceeded. Please try again later.";
        } else if (error.status >= 500) {
          errorMessage =
            "Unable to generate explanation: Service is currently unavailable. Please try again later.";
        }
      }
    }

    return errorMessage;
  }
}

export default function TerminalChat({
  config,
  prompt: _initialPrompt,
  imagePaths: _initialImagePaths,
  approvalPolicy: initialApprovalPolicy,
  additionalWritableRoots,
  fullStdout,
}: Props): React.ReactElement {
  const notify = Boolean(config.notify);
  const [model, setModel] = useState<Model>(config.model);
  const [loading, setLoading] = useState<boolean>(false);
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(
    initialApprovalPolicy,
  );
  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  const [items, setItems] = useState<Array<CoreMessage>>([]);
  const [mcpServerStatus, setMcpServerStatus] = useState<
    Array<{ name: string; connected: boolean }>
  >([]);
  const mcpClientManager = useMemo(
    () => new MCPClientManager(config),
    [config],
  );

  const handleCompact = async () => {
    setLoading(true);
    try {
      const summary = await generateCompactSummary(items, model);
      setItems([
        {
          role: "assistant",
          content: summary,
        },
      ]);
    } catch (err) {
      setItems((prev) => [
        ...prev,
        {
          id: `compact-error-${Date.now()}`,
          role: "system",
          content: `Failed to compact context: ${err}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const {
    requestConfirmation,
    confirmationPrompt,
    explanation,
    submitConfirmation,
  } = useConfirmation();
  const [overlayMode, setOverlayMode] = useState<OverlayModeType>("none");

  // Store the diff text when opening the diff overlay so the view isn’t
  // recomputed on every re‑render while it is open.
  // diffText is passed down to the DiffOverlay component. The setter is
  // currently unused but retained for potential future updates. Prefix with
  // an underscore so eslint ignores the unused variable.
  const [diffText, _setDiffText] = useState<string>("");

  const [initialPrompt, setInitialPrompt] = useState(_initialPrompt);
  const [initialImagePaths, setInitialImagePaths] =
    useState(_initialImagePaths);

  const PWD = React.useMemo(() => shortCwd(), []);

  // Keep a single AgentLoop instance alive across renders;
  // recreate only when model/instructions/approvalPolicy change.
  const agentRef = React.useRef<AgentLoop>();
  const [, forceUpdate] = React.useReducer((c) => c + 1, 0); // trigger re‑render

  // ────────────────────────────────────────────────────────────────
  // DEBUG: log every render w/ key bits of state
  // ────────────────────────────────────────────────────────────────
  log(
    `render - agent? ${Boolean(agentRef.current)} loading=${loading} items=${
      items.length
    }`,
  );

  // Initialize MCP client manager on mount
  useEffect(() => {
    mcpClientManager.initialize().catch((error) => {
      log(`Error initializing MCP clients: ${error}`);
    });

    return () => {
      mcpClientManager.closeAll().catch((error) => {
        log(`Error closing MCP clients: ${error}`);
      });
    };
  }, [mcpClientManager]);

  // Handle MCP command
  const handleMCPCommand = () => {
    // Get current MCP server status
    setMcpServerStatus(mcpClientManager.getStatus());

    // Show the overlay
    setOverlayMode("mcp");
  };

  useEffect(() => {
    // Skip recreating the agent if awaiting a decision on a pending confirmation.
    if (confirmationPrompt != null) {
      log("skip AgentLoop recreation due to pending confirmationPrompt");
      return;
    }

    log("creating NEW AgentLoop");
    log(
      `model=${model} instructions=${Boolean(
        config.instructions,
      )} approvalPolicy=${approvalPolicy}`,
    );

    // Tear down any existing loop before creating a new one.
    agentRef.current?.terminate();

    const sessionId = crypto.randomUUID();
    agentRef.current = new AgentLoop({
      model,
      config,
      instructions: config.instructions,
      approvalPolicy,
      additionalWritableRoots,
      onItem: (item) => {
        log(`onItem: ${JSON.stringify(item)}`);
        setItems((prev) => {
          const updated = [...prev, item];
          saveRollout(sessionId, updated);
          return updated;
        });
      },
      onLoading: setLoading,
      getCommandConfirmation: async (
        command: Array<string>,
        applyPatch: ApplyPatchCommand | undefined,
      ): Promise<CommandConfirmation> => {
        log(`getCommandConfirmation: ${command}`);
        const commandForDisplay = formatCommandForDisplay(command);

        // First request for confirmation
        let { decision: review, customDenyMessage } = await requestConfirmation(
          <TerminalChatToolCallCommand commandForDisplay={commandForDisplay} />,
        );

        // If the user wants an explanation, generate one and ask again.
        if (review === ReviewDecision.EXPLAIN) {
          log(`Generating explanation for command: ${commandForDisplay}`);
          const explanation = await generateCommandExplanation(command, model);
          log(`Generated explanation: ${explanation}`);

          // Ask for confirmation again, but with the explanation.
          const confirmResult = await requestConfirmation(
            <TerminalChatToolCallCommand
              commandForDisplay={commandForDisplay}
              explanation={explanation}
            />,
          );

          // Update the decision based on the second confirmation.
          review = confirmResult.decision;
          customDenyMessage = confirmResult.customDenyMessage;

          // Return the final decision with the explanation.
          return { review, customDenyMessage, applyPatch, explanation };
        }

        return { review, customDenyMessage, applyPatch };
      },
    });

    // Force a render so JSX below can "see" the freshly created agent.
    forceUpdate();

    log(`AgentLoop created: ${inspect(agentRef.current, { depth: 1 })}`);

    return () => {
      log("terminating AgentLoop");
      agentRef.current?.terminate();
      agentRef.current = undefined;
      forceUpdate(); // re‑render after teardown too
    };
    // We intentionally omit 'approvalPolicy' and 'confirmationPrompt' from the deps
    // so switching modes or showing confirmation dialogs doesn’t tear down the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, config, requestConfirmation, additionalWritableRoots]);

  // Whenever loading starts/stops, reset or start a timer — but pause the
  // timer while a confirmation overlay is displayed so we don't trigger a
  // re‑render every second during apply_patch reviews.
  useEffect(() => {
    let handle: ReturnType<typeof setInterval> | null = null;
    // Only tick the "thinking…" timer when the agent is actually processing
    // a request *and* the user is not being asked to review a command.
    if (loading && confirmationPrompt == null) {
      setThinkingSeconds(0);
      handle = setInterval(() => {
        setThinkingSeconds((s) => s + 1);
      }, 1000);
    } else {
      if (handle) {
        clearInterval(handle);
      }
      setThinkingSeconds(0);
    }
    return () => {
      if (handle) {
        clearInterval(handle);
      }
    };
  }, [loading, confirmationPrompt]);

  // Notify desktop with a preview when an assistant response arrives.
  const prevLoadingRef = useRef<boolean>(false);
  useEffect(() => {
    // Only notify when notifications are enabled.
    if (!notify) {
      prevLoadingRef.current = loading;
      return;
    }

    if (
      prevLoadingRef.current &&
      !loading &&
      confirmationPrompt == null &&
      items.length > 0
    ) {
      if (process.platform === "darwin") {
        // find the last assistant message
        const assistantMessages = items.filter((i) => i.role === "assistant");
        const last = assistantMessages[assistantMessages.length - 1];
        if (last) {
          const text = getTextContent(last);
          const preview = text.replace(/\n/g, " ").slice(0, 100);
          const safePreview = preview.replace(/"/g, '\\"');
          const title = "Codex CLI";
          const cwd = PWD;
          spawn("osascript", [
            "-e",
            `display notification "${safePreview}" with title "${title}" subtitle "${cwd}" sound name "Ping"`,
          ]);
        }
      }
    }
    prevLoadingRef.current = loading;
  }, [notify, loading, confirmationPrompt, items, PWD]);

  // Let's also track whenever the ref becomes available.
  const agent = agentRef.current;
  useEffect(() => {
    log(`agentRef.current is now ${Boolean(agent)}`);
  }, [agent]);

  // ---------------------------------------------------------------------
  // Dynamic layout constraints – keep total rendered rows <= terminal rows
  // ---------------------------------------------------------------------

  const { rows: terminalRows } = useTerminalSize();

  useEffect(() => {
    const processInitialInputItems = async () => {
      if (
        (!initialPrompt || initialPrompt.trim() === "") &&
        (!initialImagePaths || initialImagePaths.length === 0)
      ) {
        return;
      }
      const inputItems = [
        await createInputItem(initialPrompt || "", initialImagePaths || []),
      ];
      // Clear them to prevent subsequent runs.
      setInitialPrompt("");
      setInitialImagePaths([]);
      agent?.run(inputItems);
    };
    processInitialInputItems();
  }, [agent, initialPrompt, initialImagePaths]);

  // Just render every item in order, no grouping/collapse.
  const lastMessageBatch = items.map((item) => ({ item }));
  const groupCounts: Record<string, number> = {};
  const userMsgCount = items.filter((i) => i.role === "user").length;

  const contextLeftPercent = useMemo(
    () => calculateContextPercentRemaining(items, model),
    [items, model],
  );

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {agent ? (
          <TerminalMessageHistory
            setOverlayMode={setOverlayMode}
            batch={lastMessageBatch}
            groupCounts={groupCounts}
            items={items}
            userMsgCount={userMsgCount}
            confirmationPrompt={confirmationPrompt}
            loading={loading}
            thinkingSeconds={thinkingSeconds}
            fullStdout={fullStdout}
            headerProps={{
              terminalRows,
              version: CLI_VERSION,
              PWD,
              model,
              approvalPolicy,
              colorsByPolicy,
              agent,
              initialImagePaths,
            }}
          />
        ) : (
          <Box>
            <Text color="gray">Initializing agent…</Text>
          </Box>
        )}
        {overlayMode === "none" && agent && (
          <TerminalChatInput
            loading={loading}
            setItems={setItems}
            isNew={Boolean(items.length === 0)}
            confirmationPrompt={confirmationPrompt}
            explanation={explanation}
            submitConfirmation={(
              decision: ReviewDecision,
              customDenyMessage?: string,
            ) =>
              submitConfirmation({
                decision,
                customDenyMessage,
              })
            }
            contextLeftPercent={contextLeftPercent}
            openOverlay={() => setOverlayMode("history")}
            openModelOverlay={() => setOverlayMode("model")}
            openApprovalOverlay={() => setOverlayMode("approval")}
            openHelpOverlay={() => setOverlayMode("help")}
            openDiffOverlay={() => {
              const { isGitRepo, diff } = getGitDiff();
              let text: string;
              if (isGitRepo) {
                text = diff;
              } else {
                text = "`/diff` — _not inside a git repository_";
              }
              setItems((prev) => [
                ...prev,
                {
                  id: `diff-${Date.now()}`,
                  type: "message",
                  role: "system",
                  content: text,
                },
              ]);
              // Ensure no overlay is shown.
              setOverlayMode("none");
            }}
            openMCPOverlay={handleMCPCommand}
            onCompact={handleCompact}
            active={overlayMode === "none"}
            interruptAgent={() => {
              if (!agent) {
                return;
              }
              log(
                "TerminalChat: interruptAgent invoked – calling agent.cancel()",
              );
              agent.cancel();
              setLoading(false);

              // Add a system message to indicate the interruption
              setItems((prev) => [
                ...prev,
                {
                  id: `interrupt-${Date.now()}`,
                  role: "system",
                  content:
                    "⏹️  Execution interrupted by user. You can continue typing.",
                },
              ]);
            }}
            submitInput={(inputs) => {
              setItems((prev) => [...prev, ...inputs]);
              agent.run(inputs);
              return {};
            }}
            items={items}
            thinkingSeconds={thinkingSeconds}
          />
        )}
        {overlayMode === "history" && (
          <HistoryOverlay items={items} onExit={() => setOverlayMode("none")} />
        )}
        {overlayMode === "model" && (
          <ModelOverlay
            currentModel={model}
            onSelect={(newModel) => {
              log(
                "TerminalChat: interruptAgent invoked – calling agent.cancel()",
              );
              if (!agent) {
                log("TerminalChat: agent is not ready yet");
              }
              agent?.cancel();
              setLoading(false);

              setModel(newModel);

              // Save model to config
              saveConfig({
                ...config,
                model: newModel,
              });

              setItems((prev) => [
                ...prev,
                {
                  id: `switch-model-${Date.now()}`,
                  role: "system",
                  content: `Switched model to ${newModel}`,
                },
              ]);

              setOverlayMode("none");
            }}
            onExit={() => setOverlayMode("none")}
          />
        )}

        {overlayMode === "approval" && (
          <ApprovalModeOverlay
            currentMode={approvalPolicy}
            onSelect={(newMode) => {
              // Update approval policy without cancelling an in-progress session.
              if (newMode === approvalPolicy) {
                return;
              }

              setApprovalPolicy(newMode as ApprovalPolicy);
              if (agentRef.current) {
                (
                  agentRef.current as unknown as {
                    approvalPolicy: ApprovalPolicy;
                  }
                ).approvalPolicy = newMode as ApprovalPolicy;
              }
              setItems((prev) => [
                ...prev,
                {
                  id: `switch-approval-${Date.now()}`,
                  role: "system",
                  content: `Switched approval mode to ${newMode}`,
                },
              ]);

              setOverlayMode("none");
            }}
            onExit={() => setOverlayMode("none")}
          />
        )}

        {overlayMode === "help" && (
          <HelpOverlay onExit={() => setOverlayMode("none")} />
        )}

        {overlayMode === "diff" && (
          <DiffOverlay
            diffText={diffText}
            onExit={() => setOverlayMode("none")}
          />
        )}

        {overlayMode === "mcp" && (
          <MCPOverlay
            serversStatus={mcpServerStatus}
            onExit={() => setOverlayMode("none")}
          />
        )}
      </Box>
    </Box>
  );
}
