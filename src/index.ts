#!/usr/bin/env node

// Comet Browser MCP Server
// Claude Code ↔ Perplexity Comet bidirectional interaction
// Simplified to 6 essential tools

// CLI dispatch: `comet-mcp discover|verify|list ...` runs the on-demand provider
// discovery workflow instead of starting the MCP server (ADR 0001: discovery is an
// opt-in operational workflow, not a hot-path dependency).
const CLI_SUBCOMMANDS = ['discover', 'verify', 'list'];
if (CLI_SUBCOMMANDS.includes(process.argv[2] ?? '')) {
  const { runCli } = await import('./cli.js');
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { cometClient } from "./cdp-client.js";
import { getDriver, listDrivers, normalizePrompt, askAndWait, renderPoll, renderInProgress, compactAskResult } from "./drivers/index.js";

const TOOLS: Tool[] = [
  {
    name: "comet_connect",
    description: "Connect to Comet browser (auto-starts if needed)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_ask",
    description: "Send a prompt to Comet/Perplexity and wait for the complete response (blocking). Ideal for tasks requiring real browser interaction (login walls, dynamic content, filling forms) or deep research with agentic browsing.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Question or task for Comet - focus on goals and context" },
        newChat: { type: "boolean", description: "Start a fresh conversation (default: false)" },
        timeout: { type: "number", description: "Max wait time in ms (default: 15000 = 15s)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "comet_poll",
    description: "Check agent status and progress. Call repeatedly to monitor agentic tasks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_stop",
    description: "Stop the current agent task if it's going off track",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_screenshot",
    description: "Capture a screenshot of current page",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_mode",
    description: "Switch Perplexity search mode. Modes: 'search' (basic), 'research' (deep research), 'labs' (analytics/visualization), 'learn' (educational). Call without mode to see current mode.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["search", "research", "labs", "learn"],
          description: "Mode to switch to (optional - omit to see current mode)",
        },
      },
    },
  },
  {
    name: "provider_discover",
    description: "Run the discovery workflow against a provider tab (inventory, one varied validation prompt, entry regeneration). Opt-in operational tool — requires the provider tab open in Comet. Use when provider_verify reports a missing hook or selectors drift.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider name: perplexity, grok, gemini, chatgpt, claude" },
        write: { type: "boolean", description: "Write the regenerated entry + fixtures (default: true)" },
        diff: { type: "boolean", description: "Show selector changes vs the committed entry (default: true)" },
      },
      required: ["provider"],
    },
  },
  {
    name: "provider_verify",
    description: "Cheap health check: resolve the provider entry's known selectors against the live tab. Sends NO prompt. Reports ok/missing per control so drift is detectable without polluting a conversation.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider name: perplexity, grok, gemini, chatgpt, claude" },
      },
      required: ["provider"],
    },
  },
  {
    name: "provider_ask",
    description: "Send a prompt to any provider (perplexity, grok, ...) and wait for the complete response. Provider-neutral: dispatches to the registered ChatDriver. Returns text + markdown.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider name: perplexity, grok" },
        prompt: { type: "string", description: "Question or task for the provider" },
        timeout: { type: "number", description: "Max wait time in ms (default: 15000)" },
      },
      required: ["provider", "prompt"],
    },
  },
  {
    name: "provider_poll",
    description: "Check a provider's current turn status (text + markdown). Provider-neutral dispatch.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider name: perplexity, grok" },
      },
      required: ["provider"],
    },
  },
  {
    name: "provider_stop",
    description: "Stop the current provider generation if supported (Grok Fast: no-op).",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider name: perplexity, grok" },
      },
      required: ["provider"],
    },
  },
];

const server = new Server(
  { name: "comet-bridge", version: "2.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "comet_connect": {
        // Auto-start Comet with debug port (will restart if running without it)
        const startResult = await cometClient.startComet(9222);

        // Get all tabs and clean up - close all except one
        const targets = await cometClient.listTargets();
        const pageTabs = targets.filter(t => t.type === 'page');

        // Close extra tabs, keep only one
        if (pageTabs.length > 1) {
          for (let i = 1; i < pageTabs.length; i++) {
            try {
              await cometClient.closeTab(pageTabs[i].id);
            } catch { /* ignore */ }
          }
        }

        // Get fresh tab list
        const freshTargets = await cometClient.listTargets();
        const anyPage = freshTargets.find(t => t.type === 'page');

        if (anyPage) {
          await cometClient.connect(anyPage.id);
          // Always navigate to Perplexity home for clean state
          await cometClient.navigate("https://www.perplexity.ai/", true);
          await new Promise(resolve => setTimeout(resolve, 1500));
          return { content: [{ type: "text", text: `${startResult}\nConnected to Perplexity (cleaned ${pageTabs.length - 1} old tabs)` }] };
        }

        // No tabs at all - create a new one
        const newTab = await cometClient.newTab("https://www.perplexity.ai/");
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for page load
        await cometClient.connect(newTab.id);
        return { content: [{ type: "text", text: `${startResult}\nCreated new tab and navigated to Perplexity` }] };
      }

      case "comet_ask": {
        let prompt = args?.prompt as string;
        const timeout = (args?.timeout as number) || 15000;
        if (!prompt || prompt.trim().length === 0) {
          return { content: [{ type: "text", text: "Error: prompt cannot be empty" }] };
        }
        prompt = normalizePrompt(prompt);
        // comet_* = Perplexity alias over the generic ask-and-wait (P1 migration path)
        const outcome = await askAndWait(getDriver('perplexity')!, prompt, timeout);
        if (outcome.completed) {
          return { content: [{ type: "text", text: compactAskResult('perplexity', outcome) }] };
        }
        return { content: [{ type: "text", text: renderInProgress(outcome, true) }] };
      }

      case "comet_poll": {
        const driver = getDriver('perplexity')!;
        const session = await driver.open();
        const poll = await driver.poll(session);
        return { content: [{ type: "text", text: renderPoll(poll, 'perplexity') }] };
      }

      case "comet_stop": {
        const driver = getDriver('perplexity')!;
        const session = await driver.open();
        const stopped = await driver.stop(session);
        return {
          content: [{
            type: "text",
            text: stopped ? "Agent stopped" : "No active agent to stop",
          }],
        };
      }

      case "provider_ask": {
        const provider = String(args?.provider ?? '');
        const driver = getDriver(provider);
        if (!driver) return { content: [{ type: "text", text: `Unknown provider: ${provider} (have: ${listDrivers().join(', ')})` }], isError: true };
        let prompt = args?.prompt as string;
        const timeout = (args?.timeout as number) || 15000;
        if (!prompt || prompt.trim().length === 0) {
          return { content: [{ type: "text", text: "Error: prompt cannot be empty" }], isError: true };
        }
        prompt = normalizePrompt(prompt);
        const outcome = await askAndWait(driver, prompt, timeout);
        if (outcome.completed) {
          return { content: [{ type: "text", text: compactAskResult(provider, outcome) }] };
        }
        return { content: [{ type: "text", text: renderInProgress(outcome) }] };
      }

      case "provider_poll": {
        const provider = String(args?.provider ?? '');
        const driver = getDriver(provider);
        if (!driver) return { content: [{ type: "text", text: `Unknown provider: ${provider} (have: ${listDrivers().join(', ')})` }], isError: true };
        const session = await driver.open();
        const poll = await driver.poll(session);
        return { content: [{ type: "text", text: renderPoll(poll, provider) }] };
      }

      case "provider_stop": {
        const provider = String(args?.provider ?? '');
        const driver = getDriver(provider);
        if (!driver) return { content: [{ type: "text", text: `Unknown provider: ${provider} (have: ${listDrivers().join(', ')})` }], isError: true };
        const session = await driver.open();
        const stopped = await driver.stop(session);
        return {
          content: [{
            type: "text",
            text: stopped ? `${provider} stopped` : `${provider}: no active generation to stop`,
          }],
        };
      }

      case "comet_screenshot": {
        const result = await cometClient.screenshot("png");
        return {
          content: [{ type: "image", data: result.data, mimeType: "image/png" }],
        };
      }

      case "comet_mode": {
        const mode = args?.mode as string | undefined;

        // If no mode provided, show current mode
        if (!mode) {
          const result = await cometClient.evaluate(`
            (() => {
              // Try button group first (wide screen)
              const modes = ['Search', 'Research', 'Labs', 'Learn'];
              for (const mode of modes) {
                const btn = document.querySelector('button[aria-label="' + mode + '"]');
                if (btn && btn.getAttribute('data-state') === 'checked') {
                  return mode.toLowerCase();
                }
              }
              // Try dropdown (narrow screen) - look for the mode selector button
              const dropdownBtn = document.querySelector('button[class*="gap"]');
              if (dropdownBtn) {
                const text = dropdownBtn.innerText.toLowerCase();
                if (text.includes('search')) return 'search';
                if (text.includes('research')) return 'research';
                if (text.includes('labs')) return 'labs';
                if (text.includes('learn')) return 'learn';
              }
              return 'search';
            })()
          `);

          const currentMode = result.result.value as string;
          const descriptions: Record<string, string> = {
            search: 'Basic web search',
            research: 'Deep research with comprehensive analysis',
            labs: 'Analytics, visualizations, and coding',
            learn: 'Educational content and explanations'
          };

          let output = `Current mode: ${currentMode}\n\nAvailable modes:\n`;
          for (const [m, desc] of Object.entries(descriptions)) {
            const marker = m === currentMode ? "→" : " ";
            output += `${marker} ${m}: ${desc}\n`;
          }

          return { content: [{ type: "text", text: output }] };
        }

        // Switch mode
        const modeMap: Record<string, string> = {
          search: "Search",
          research: "Research",
          labs: "Labs",
          learn: "Learn",
        };
        const ariaLabel = modeMap[mode];
        if (!ariaLabel) {
          return {
            content: [{ type: "text", text: `Invalid mode: ${mode}. Use: search, research, labs, learn` }],
            isError: true,
          };
        }

        // Navigate to Perplexity first if not there
        const state = cometClient.currentState;
        if (!state.currentUrl?.includes("perplexity.ai")) {
          await cometClient.navigate("https://www.perplexity.ai/", true);
        }

        // Try both UI patterns: button group (wide) and dropdown (narrow)
        const result = await cometClient.evaluate(`
          (() => {
            // Strategy 1: Direct button (wide screen)
            const btn = document.querySelector('button[aria-label="${ariaLabel}"]');
            if (btn) {
              btn.click();
              return { success: true, method: 'button' };
            }

            // Strategy 2: Dropdown menu (narrow screen)
            // Find and click the dropdown trigger (button with current mode text)
            const allButtons = document.querySelectorAll('button');
            for (const b of allButtons) {
              const text = b.innerText.toLowerCase();
              if ((text.includes('search') || text.includes('research') ||
                   text.includes('labs') || text.includes('learn')) &&
                  b.querySelector('svg')) {
                b.click();
                return { success: true, method: 'dropdown-open', needsSelect: true };
              }
            }

            return { success: false, error: "Mode selector not found" };
          })()
        `);

        const clickResult = result.result.value as { success: boolean; method?: string; needsSelect?: boolean; error?: string };

        if (clickResult.success && clickResult.needsSelect) {
          // Wait for dropdown to open, then select the mode
          await new Promise(resolve => setTimeout(resolve, 300));
          const selectResult = await cometClient.evaluate(`
            (() => {
              // Look for dropdown menu items
              const items = document.querySelectorAll('[role="menuitem"], [role="option"], button');
              for (const item of items) {
                if (item.innerText.toLowerCase().includes('${mode}')) {
                  item.click();
                  return { success: true };
                }
              }
              return { success: false, error: "Mode option not found in dropdown" };
            })()
          `);
          const selectRes = selectResult.result.value as { success: boolean; error?: string };
          if (selectRes.success) {
            return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
          } else {
            return { content: [{ type: "text", text: `Failed: ${selectRes.error}` }], isError: true };
          }
        }

        if (clickResult.success) {
          return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
        } else {
          return {
            content: [{ type: "text", text: `Failed to switch mode: ${clickResult.error}` }],
            isError: true,
          };
        }
      }

      case "provider_discover": {
        const providerArg = String(args?.provider ?? '');
        const { runDiscovery, diffEntry, listProviders } = await import("./core/discovery.js");
        const provider = listProviders().includes(providerArg as any) ? providerArg as any : null;
        if (!provider) {
          return { content: [{ type: "text", text: `Unknown provider: ${providerArg} (have: ${listProviders().join(', ')})` }], isError: true };
        }
        const write = (args?.write as boolean | undefined) ?? true;
        const diff = (args?.diff as boolean | undefined) ?? true;
        try {
          const result = await runDiscovery(provider, { write });
          let text = `provider_discover ${provider}: state=${result.endedState} confidence=${result.confidence}\n` +
            `prompt: "${result.validationPrompt}" → expected "${result.expectedToken}"\n` +
            `submit: ${result.submitMethod?.method ?? '?'}${result.submitMethod?.selector ? ' via ' + result.submitMethod.selector : ''}\n` +
            (result.wroteEntry ? `entry written: ${result.entryPath}\n` : 'entry NOT written\n') +
            `fixtures: ${Object.keys(result.fixtures).join(', ') || '(none)'}`;
          if (diff && result.wroteEntry) {
            const d = diffEntry(provider, result.entry);
            text += `\n\ndiff vs ${d.against ?? 'none'}:\n` + (d.changes.length ? d.changes.join('\n') : 'unchanged');
          }
          return { content: [{ type: "text", text }] };
        } catch (error) {
          return { content: [{ type: "text", text: `provider_discover failed: ${error instanceof Error ? error.message : error}` }], isError: true };
        }
      }

      case "provider_verify": {
        const providerArg = String(args?.provider ?? '');
        const { verifyProvider, listProviders } = await import("./core/discovery.js");
        const provider = listProviders().includes(providerArg as any) ? providerArg as any : null;
        if (!provider) {
          return { content: [{ type: "text", text: `Unknown provider: ${providerArg} (have: ${listProviders().join(', ')})` }], isError: true };
        }
        try {
          const result = await verifyProvider(provider);
          if (!result.tabFound) {
            return { content: [{ type: "text", text: `No ${provider} tab found — open the provider tab in Comet first` }], isError: true };
          }
          let text = `${provider} verify (no prompt sent):\n`;
          for (const c of result.checks) text += `  [${c.ok ? 'OK' : 'MISS'}] ${c.name}: ${c.selector}${c.conditional ? ' (conditional)' : ''}\n`;
          text += result.healthy ? 'HEALTHY' : 'UNHEALTHY — re-run: provider_discover ' + provider;
          return { content: [{ type: "text", text }] };
        } catch (error) {
          return { content: [{ type: "text", text: `provider_verify failed: ${error instanceof Error ? error.message : error}` }], isError: true };
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : error}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
server.connect(transport);
