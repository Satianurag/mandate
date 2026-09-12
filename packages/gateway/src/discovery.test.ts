import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverAgent0Deployments } from "./discovery.ts";
import { pickTool, type McpClient, type McpTool } from "./mcp.ts";

test("pickTool matches a needle case-insensitively", () => {
  const tools: McpTool[] = [
    { name: "GetSchemaBySubgraphId" },
    { name: "search_subgraphs_by_ipfs_hashes", inputSchema: { required: ["ipfs_hashes"] } },
    { name: "search_subgraphs_by_keyword" },
    { name: "execute_query" },
  ];
  assert.equal(pickTool(tools, "search")?.name, "search_subgraphs_by_keyword");
  assert.equal(pickTool(tools, "execute")?.name, "execute_query");
});

test("discoverAgent0Deployments uses MCP tools and refuses an empty result", async () => {
  const calls: string[] = [];
  const mcp: McpClient = {
    async listTools() {
      return [
        { name: "search_subgraphs_by_ipfs_hashes", inputSchema: { required: ["ipfs_hashes"] } },
        { name: "get_schema_by_deployment_id", inputSchema: { required: ["deployment_id"] } },
        { name: "search_subgraphs_by_keyword" },
        { name: "execute_query_by_subgraph_id" },
      ];
    },
    async callTool(name) {
      calls.push(name);
      if (name === "search_subgraphs_by_keyword") {
        return "Agent0 on base-sepolia id 4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u also bsc chapel BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z";
      }
      return "";
    },
    async close() {},
  };
  const out = await discoverAgent0Deployments(mcp);
  assert.equal(out.subgraphs["bsc-chapel"], "BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z");
  assert.ok(calls.includes("search_subgraphs_by_keyword"));
});
