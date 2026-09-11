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
        {
          name: "search_subgraphs_by_ipfs_hashes",
          inputSchema: { required: ["ipfs_hashes"] },
        },
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
  assert.deepEqual(out.toolsUsed, ["search_subgraphs_by_keyword"]);
  assert.equal(out.subgraphs["base-sepolia"], "4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u");
  assert.equal(out.subgraphs["bsc-chapel"], "BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z");
  assert.deepEqual(calls, ["search_subgraphs_by_keyword"]);

  const truncated: McpClient = {
    async listTools() {
      return [{ name: "search_subgraphs_by_keyword" }];
    },
    async callTool() {
      return "Agent0 on base-8 id 4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u";
    },
    async close() {},
  };
  const truncatedOut = await discoverAgent0Deployments(truncated);
  assert.equal(truncatedOut.subgraphs["base-sepolia"], "4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u");

  const jsonMcp: McpClient = {
    async listTools() {
      return [{ name: "search_subgraphs_by_keyword", inputSchema: { required: ["keyword"] } }];
    },
    async callTool() {
      return JSON.stringify({
        subgraphs: [
          {
            id: "GjQEDgEKqoh5Yc8MUgxoQoRATEJdEiH7HbocfR1aFiHa",
            metadata: { displayName: "Agent0-BaseSepolia" },
          },
        ],
      });
    },
    async close() {},
  };
  const jsonOut = await discoverAgent0Deployments(jsonMcp);
  assert.equal(jsonOut.subgraphs["base-sepolia"], "GjQEDgEKqoh5Yc8MUgxoQoRATEJdEiH7HbocfR1aFiHa");

  const collide: McpClient = {
    async listTools() {
      return [{ name: "search_subgraphs_by_keyword" }];
    },
    async callTool() {
      return JSON.stringify({
        subgraphs: [
          {
            id: "GjQEDgEKqoh5Yc8MUgxoQoRATEJdEiH7HbocfR1aFiHa",
            metadata: { displayName: "Agent0 BaseSepolia" },
          },
          {
            id: "4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u",
            metadata: { displayName: "Agent0 BaseSepolia two" },
          },
        ],
      });
    },
    async close() {},
  };
  const collideOut = await discoverAgent0Deployments(collide);
  assert.equal(collideOut.subgraphs["base-sepolia"], "GjQEDgEKqoh5Yc8MUgxoQoRATEJdEiH7HbocfR1aFiHa");
  assert.equal(collideOut.subgraphs["subgraph-1"], "4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u");
  assert.equal(collideOut.subgraphs["base-8"], undefined);

  const empty: McpClient = {
    async listTools() {
      return [{ name: "search_subgraphs_by_keyword" }];
    },
    async callTool() {
      return "no ids here";
    },
    async close() {},
  };
  await assert.rejects(() => discoverAgent0Deployments(empty), /no Agent0 subgraph IDs/);
});
