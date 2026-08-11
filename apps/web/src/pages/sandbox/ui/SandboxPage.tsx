import { useState } from "react";
import { useInvokeTool, useSandboxTools } from "../../../features/tool-sandbox/index.js";
import type { SandboxTool } from "../../../features/tool-sandbox/index.js";
import { cn } from "../../../shared/lib/cn.js";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COST_VARIANT: Record<string, "success" | "warn" | "error" | "neutral"> = {
  free: "success",
  cheap: "success",
  moderate: "warn",
  expensive: "error",
};

interface PropDef {
  type?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  minItems?: number;
  items?: Record<string, unknown>;
}

function numericDefault(def: PropDef): number {
  // Resolve exclusive bounds (JSON Schema draft-04 uses boolean; draft-07+ uses number).
  const exMin = typeof def.exclusiveMinimum === "number" ? def.exclusiveMinimum : undefined;
  const exMax = typeof def.exclusiveMaximum === "number" ? def.exclusiveMaximum : undefined;
  const lo = exMin !== undefined ? exMin : def.minimum;
  const hi = exMax !== undefined ? exMax : def.maximum;
  const strictLo =
    exMin !== undefined || (typeof def.exclusiveMinimum === "boolean" && def.exclusiveMinimum);
  const strictHi =
    exMax !== undefined || (typeof def.exclusiveMaximum === "boolean" && def.exclusiveMaximum);

  if (lo !== undefined && hi !== undefined) {
    const mid = (lo + hi) / 2;
    return mid;
  }
  if (lo !== undefined) {
    return strictLo ? lo + 1 : lo;
  }
  if (hi !== undefined) {
    return strictHi ? hi - 1 : hi;
  }
  return 0;
}

function buildItemTemplate(itemSchema: Record<string, unknown>): unknown {
  const type = itemSchema.type as string | undefined;
  if (type === "object") return buildTemplateObject(itemSchema);
  if (type === "string") return "";
  if (type === "number" || type === "integer") return numericDefault(itemSchema as PropDef);
  if (type === "boolean") return false;
  return null;
}

function buildTemplateObject(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, PropDef>;
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    if (def.default !== undefined) {
      out[key] = def.default;
    } else if (def.enum) {
      out[key] = def.enum[0];
    } else if (def.type === "string") {
      out[key] = "";
    } else if (def.type === "number" || def.type === "integer") {
      out[key] = numericDefault(def);
    } else if (def.type === "boolean") {
      out[key] = false;
    } else if (def.type === "array") {
      const count = def.minItems ?? 1;
      out[key] = Array.from({ length: count }, () =>
        def.items ? buildItemTemplate(def.items) : null,
      );
    } else {
      out[key] = null;
    }
  }
  return out;
}

function buildTemplate(schema: Record<string, unknown>): string {
  return JSON.stringify(buildTemplateObject(schema), null, 2);
}

// ---------------------------------------------------------------------------
// Tool list item
// ---------------------------------------------------------------------------

function ToolListItem({
  tool,
  selected,
  onClick,
}: {
  tool: SandboxTool;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full rounded px-3 py-2 text-left text-xs transition-colors",
        selected
          ? "bg-accent/10 text-accent"
          : "text-[#71717a] hover:bg-surface-2 hover:text-white",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono font-medium">{tool.name}</span>
        {tool.dangerous && (
          <span className="shrink-0 rounded bg-ev-error/20 px-1 py-0.5 text-[9px] text-ev-error">
            danger
          </span>
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function SandboxPage() {
  const { data: tools, isLoading, error: fetchError } = useSandboxTools();
  const { mutate: invoke, isPending, data: invokeData, reset } = useInvokeTool();

  const [selected, setSelected] = useState<SandboxTool | null>(null);
  const [argsJson, setArgsJson] = useState("{}");
  const [parseError, setParseError] = useState<string | null>(null);
  const [schemaOpen, setSchemaOpen] = useState(false);

  const handleSelect = (tool: SandboxTool) => {
    setSelected(tool);
    setArgsJson(
      tool.exampleInput
        ? JSON.stringify(tool.exampleInput, null, 2)
        : buildTemplate(tool.inputSchema),
    );
    setParseError(null);
    reset();
  };

  const handleInvoke = () => {
    if (!selected) return;
    let args: unknown;
    try {
      args = JSON.parse(argsJson);
      setParseError(null);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Invalid JSON");
      return;
    }
    invoke({ toolName: selected.name, args });
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* Tool list — left sidebar */}
      <div className="flex w-52 shrink-0 flex-col border-r border-border bg-surface">
        <div className="border-b border-border px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#3f3f46]">
            Registered Tools
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5">
          {isLoading && <p className="px-2 py-2 text-xs text-[#3f3f46]">Loading…</p>}
          {fetchError && <p className="px-2 py-2 text-xs text-ev-error">Server unavailable</p>}
          {tools?.map((t) => (
            <ToolListItem
              key={t.name}
              tool={t}
              selected={selected?.name === t.name}
              onClick={() => handleSelect(t)}
            />
          ))}
        </div>
      </div>

      {/* Editor + output — right panel */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!selected ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <span className="text-4xl opacity-20">⚗️</span>
            <p className="text-xs text-[#3f3f46]">Select a tool to invoke it directly</p>
          </div>
        ) : (
          <div className="flex h-full flex-col overflow-hidden">
            {/* Tool header */}
            <div className="shrink-0 border-b border-border px-5 py-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-semibold text-white">{selected.name}</span>
                <Badge variant={COST_VARIANT[selected.costHint] ?? "neutral"}>
                  {selected.costHint}
                </Badge>
                {selected.idempotent && <Badge variant="neutral">idempotent</Badge>}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-[#71717a]">{selected.description}</p>
            </div>

            {/* Editor area */}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
              {/* Input schema toggle */}
              <div className="mb-3">
                <button
                  type="button"
                  onClick={() => setSchemaOpen((v) => !v)}
                  className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[#3f3f46] transition-colors hover:text-[#71717a]"
                >
                  <span>{schemaOpen ? "▴" : "▾"}</span> Input Schema
                </button>
                {schemaOpen && (
                  <pre className="overflow-x-auto rounded bg-canvas p-3 text-[11px] font-mono text-[#a1a1aa]">
                    {JSON.stringify(selected.inputSchema, null, 2)}
                  </pre>
                )}
              </div>

              {/* JSON args editor */}
              <label
                className="mb-1.5 block text-xs font-medium text-[#a1a1aa]"
                htmlFor="args-editor"
              >
                Arguments (JSON)
              </label>
              <textarea
                id="args-editor"
                value={argsJson}
                onChange={(e) => {
                  setArgsJson(e.target.value);
                  setParseError(null);
                }}
                rows={12}
                spellCheck={false}
                className={cn(
                  "mb-2 w-full resize-none rounded border bg-canvas px-3 py-2.5",
                  "font-mono text-xs leading-relaxed text-[#c4c4d4] placeholder-[#3f3f46]",
                  "transition-colors focus:outline-none focus:ring-1",
                  parseError
                    ? "border-ev-error/50 focus:ring-ev-error/50"
                    : "border-border-2 focus:border-accent focus:ring-accent",
                )}
              />
              {parseError && (
                <p className="mb-2 text-xs text-ev-error">Parse error: {parseError}</p>
              )}

              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  onClick={handleInvoke}
                  loading={isPending}
                  disabled={selected.dangerous}
                  size="sm"
                >
                  {selected.dangerous ? "Blocked (dangerous)" : "Invoke"}
                </Button>
                {invokeData && (
                  <button
                    type="button"
                    onClick={reset}
                    className="text-xs text-[#3f3f46] transition-colors hover:text-[#71717a]"
                  >
                    Clear result
                  </button>
                )}
              </div>

              {/* Output */}
              {invokeData && (
                <div className="mt-4">
                  <p
                    className={cn(
                      "mb-1.5 text-[10px] font-semibold uppercase tracking-wider",
                      invokeData.ok ? "text-ev-success" : "text-ev-error",
                    )}
                  >
                    {invokeData.ok ? "Result" : "Error"}
                  </p>
                  <pre
                    className={cn(
                      "overflow-x-auto rounded p-3 text-[11px] font-mono leading-relaxed",
                      invokeData.ok
                        ? "bg-ev-success/5 text-[#c4c4d4]"
                        : "bg-ev-error/5 text-ev-error",
                    )}
                  >
                    {JSON.stringify(invokeData.ok ? invokeData.result : invokeData.error, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
