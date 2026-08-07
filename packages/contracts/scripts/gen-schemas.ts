/**
 * gen-schemas.ts — outputs JSON Schema for every tool definition.
 * Run with: pnpm gen:schemas (from packages/contracts or root)
 *
 * Output: packages/contracts/dist/schemas/<toolName>.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_REGISTRY } from "../src/tools/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = join(__dirname, "..", "dist", "schemas");

await mkdir(outputDir, { recursive: true });

for (const tool of TOOL_REGISTRY) {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: tool.name,
    description: tool.description,
    dangerous: tool.dangerous,
    idempotent: tool.idempotent,
    costHint: tool.costHint,
    input: tool.inputSchema,
    output: tool.outputSchema,
  };

  const filePath = join(outputDir, `${tool.name}.json`);
  await writeFile(filePath, `${JSON.stringify(schema, null, 2)}\n`, "utf-8");
  console.log(`  wrote ${filePath}`);
}

console.log(`\ngen:schemas — ${TOOL_REGISTRY.length} schemas written to ${outputDir}`);
