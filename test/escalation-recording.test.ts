import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RunLedgerEscalationEvent } from "../src/connectors/run-ledger.ts";
import { createOpenWikiConnectorTools } from "../src/connectors/tools.ts";
import {
  buildRunLedgerFromResult,
  writeRunLedger,
} from "../src/run-ledger-io.ts";

const originalHome = process.env.OPENWIKI_HOME;
const originalToken = process.env.OPENWIKI_GLEAN_ACCESS_TOKEN;
let openWikiHome: string;

beforeEach(async () => {
  openWikiHome = await mkdtemp(path.join(tmpdir(), "openwiki-escalation-"));
  process.env.OPENWIKI_HOME = openWikiHome;
  process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = "secret-access-token";
  const connectorDir = path.join(openWikiHome, "connectors", "glean");
  await mkdir(connectorDir, { recursive: true });
  await writeFile(
    path.join(connectorDir, "config.json"),
    `${JSON.stringify({ enabled: true, instance: "acme" })}\n`,
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalHome === undefined) {
    delete process.env.OPENWIKI_HOME;
  } else {
    process.env.OPENWIKI_HOME = originalHome;
  }
  if (originalToken === undefined) {
    delete process.env.OPENWIKI_GLEAN_ACCESS_TOKEN;
  } else {
    process.env.OPENWIKI_GLEAN_ACCESS_TOKEN = originalToken;
  }
  await rm(openWikiHome, { force: true, recursive: true });
});

function createCatalog() {
  return {
    skill_order: ["jira"],
    skills: {
      jira: {
        "tools/JIRA_ADD_COMMENT.json": JSON.stringify({
          description: "Add a comment to a Jira issue",
          name: "JIRA_ADD_COMMENT",
          server_id: "jira-primary",
        }),
        "tools/JIRA_GET_ISSUE.json": JSON.stringify({
          annotations: { readOnlyHint: true },
          description: "Retrieve a Jira issue",
          name: "JIRA_GET_ISSUE",
          server_id: "jira-primary",
        }),
      },
    },
  };
}

function stubMcpGateway(): { method: string; toolName?: string }[] {
  const calls: { method: string; toolName?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(bodyText) as {
        id?: number;
        method?: string;
        params?: { name?: string };
      };
      calls.push({
        method: body.method ?? "unknown",
        toolName: body.params?.name,
      });

      if (body.id === undefined) {
        return Promise.resolve(new Response(null, { status: 202 }));
      }

      const result =
        body.method === "tools/call" && body.params?.name === "find_skills"
          ? {
              content: [
                { text: JSON.stringify(createCatalog()), type: "text" },
              ],
            }
          : body.method === "tools/call" && body.params?.name === "run_tool"
            ? {
                content: [
                  {
                    text: JSON.stringify({
                      key: "OW-38",
                      summary: "Escalation evidence",
                    }),
                    type: "text",
                  },
                ],
              }
            : {};

      return Promise.resolve(
        Response.json({ id: body.id, jsonrpc: "2.0", result }),
      );
    }),
  );

  return calls;
}

describe("connector-tool escalation recording", () => {
  test("records successful and refused attempts and renders redacted targets", async () => {
    const calls = stubMcpGateway();
    const events: RunLedgerEscalationEvent[] = [];
    const tools = createOpenWikiConnectorTools({
      onEscalation: (event) => events.push(event),
    });
    const discovery = tools.find(
      (tool) => tool.name === "openwiki_find_gateway_datasource_tools",
    );
    const read = tools.find(
      (tool) => tool.name === "openwiki_gateway_datasource_read",
    );
    if (!discovery || !read) {
      throw new Error("Expected gateway datasource tools.");
    }

    await discovery.invoke({
      connectorId: "glean",
      queries: ["Jira issue OW-38"],
    });
    await read.invoke({
      args: {
        apiKey: "do-not-record",
        issueKey: "OW-38",
        note: "🔥".repeat(200),
      },
      connectorId: "glean",
      serverId: "jira-primary",
      toolName: "JIRA_GET_ISSUE",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "ok",
      serverId: "jira-primary",
      toolName: "JIRA_GET_ISSUE",
      type: "escalation",
    });
    expect(events[0]?.target).toContain("OW-38");
    expect(events[0]?.target).toContain("<redacted>");
    expect(events[0]?.target).not.toContain("do-not-record");
    const target = events[0]?.target ?? "";
    expect([...target]).toHaveLength(120);
    expect(target).toMatch(/…$/u);
    expect([...target].join("")).toBe(target);
    expect(target.slice(0, -1)).not.toMatch(/[\uD800-\uDBFF]$/u);

    const passthroughCallsBefore = calls.filter(
      (call) => call.method === "tools/call" && call.toolName === "run_tool",
    ).length;
    await expect(
      read.invoke({
        args: { body: "Do not send this", issueKey: "OW-38" },
        connectorId: "glean",
        serverId: "jira-primary",
        toolName: "JIRA_ADD_COMMENT",
      }),
    ).rejects.toThrow(/write-shaped.*never callable/isu);

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      outcome: "failed",
      serverId: "jira-primary",
      toolName: "JIRA_ADD_COMMENT",
      type: "escalation",
    });
    expect(events[1]?.reason).toMatch(/write-shaped.*never callable/isu);
    expect(
      calls.filter(
        (call) => call.method === "tools/call" && call.toolName === "run_tool",
      ),
    ).toHaveLength(passthroughCallsBefore);

    const ledgerPath = await writeRunLedger(
      buildRunLedgerFromResult({
        connectorId: "glean",
        escalationEvents: events,
        fallbackMessage: "Recorded escalation attempts.",
        fallbackRunId: "escalation-run",
        mode: "explore",
        startedAt: "2026-07-14T10:00:00.000Z",
      }),
    );
    const page = await readFile(ledgerPath, "utf8");

    expect(page).toMatch(/JIRA_GET_ISSUE on jira-primary .* — ok/iu);
    expect(page).toMatch(
      /JIRA_ADD_COMMENT on jira-primary .* — FAILED \(.*write-shaped.*never callable.*\)/isu,
    );
    expect(page).toContain("<redacted>");
    expect(page).not.toContain("do-not-record");
  });
});
