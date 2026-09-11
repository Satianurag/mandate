/** A bounded read-only GraphQL surface. No mutations, variables or hidden fragments. */
import { Kind, parse, visit } from "graphql";
export function validateAnalyticsQuery(query: string): string {
  if (typeof query !== "string" || Buffer.byteLength(query) > 12000) throw new Error("Query must fit within 12 KB");
  const doc = parse(query, { maxTokens: 800 });
  if (doc.definitions.length !== 1) throw new Error("Exactly one query operation is permitted");
  const op = doc.definitions[0];
  if (!op || op.kind !== Kind.OPERATION_DEFINITION || op.operation !== "query" || op.variableDefinitions?.length) throw new Error("Only read-only queries without variables are permitted");
  let count = 0, depth = 0;
  visit(doc, {
    Directive() { throw new Error("Directives are not permitted"); },
    FragmentSpread() { throw new Error("Fragments are not permitted"); },
    InlineFragment() { throw new Error("Fragments are not permitted"); },
    Field: {
      enter(node) {
        count++; depth++;
        if (node.alias) throw new Error("Aliases are outside the bounded analytics surface");
        if (count > 100 || depth > 6) throw new Error("Query exceeds field/depth bounds");
        if (node.name.value.startsWith("__")) throw new Error("Introspection is not a paid analytics task");
        if (depth === 1 && !["agents", "_meta"].includes(node.name.value)) throw new Error("Only Agent0 agents and source metadata may be queried");
        if (["agents", "feedback", "validations"].includes(node.name.value)) {
          const first = node.arguments?.find(a => a.name.value === "first")?.value;
          if (!first || first.kind !== Kind.INT || Number(first.value) < 1 || Number(first.value) > 100) throw new Error(`${node.name.value} requires first between 1 and 100`);
        }
        const skip = node.arguments?.find(a => a.name.value === "skip")?.value;
        if (skip && (skip.kind !== Kind.INT || Number(skip.value) < 0 || Number(skip.value) > 1000)) throw new Error("skip must be between 0 and 1000");
      },
      leave() { depth--; },
    },
  });
  return query;
}
