import { useState } from "react";
import {
  useDiscoverServer,
  useMcpServers,
  useRegisterServer,
} from "../../../features/mcp-registry/index.js";
import type { DiscoveredTool } from "../../../features/mcp-registry/index.js";
import { cn } from "../../../shared/lib/cn.js";
import { Button } from "../../../shared/ui/button.js";

// ---------------------------------------------------------------------------
// Registered server card
// ---------------------------------------------------------------------------

function ServerCard({
  url,
  toolNames,
  registeredAt,
}: {
  url: string;
  toolNames: string[];
  registeredAt: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border bg-surface px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs font-semibold text-white">{url}</p>
          <p className="mt-0.5 text-[10px] text-[#52525b]">
            {toolNames.length} tool{toolNames.length !== 1 ? "s" : ""} · registered{" "}
            {new Date(registeredAt).toLocaleTimeString()}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 text-[10px] text-[#3f3f46] transition-colors hover:text-[#a1a1aa]"
        >
          {open ? "hide" : "tools"}
        </button>
      </div>
      {open && (
        <div className="mt-2 flex flex-wrap gap-1">
          {toolNames.map((name) => (
            <span
              key={name}
              className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-[#71717a]"
            >
              {name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Discovered tool preview
// ---------------------------------------------------------------------------

function ToolPreview({ tool }: { tool: DiscoveredTool }) {
  return (
    <div className="rounded border border-border px-3 py-2">
      <p className="font-mono text-xs font-semibold text-white">{tool.name}</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-[#71717a]">{tool.description}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function McpRegistryPage() {
  const { data: servers, isLoading: serversLoading } = useMcpServers();
  const {
    mutate: discover,
    data: discovered,
    isPending: discovering,
    error: discoverError,
    reset: resetDiscover,
  } = useDiscoverServer();
  const { mutate: register, isPending: registering, isSuccess: registered } = useRegisterServer();

  const [url, setUrl] = useState("");

  const handleDiscover = () => {
    if (!url.trim()) return;
    resetDiscover();
    discover(url.trim());
  };

  const handleRegister = () => {
    if (!url.trim()) return;
    register(url.trim(), {
      onSuccess: () => {
        setUrl("");
        resetDiscover();
      },
    });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-5">
        <h1 className="mb-1 text-sm font-semibold text-white">MCP Server Registry</h1>
        <p className="mb-5 text-xs text-[#52525b]">
          Connect external MCP servers to expose their tools inside Harness workflows.
        </p>

        {/* Discovery form */}
        <div className="mb-6 rounded-md border border-border bg-surface px-5 py-4">
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[#3f3f46]">
            Add Server
          </p>

          <div className="mb-3 flex gap-2">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleDiscover();
              }}
              placeholder="https://my-mcp-server.example.com"
              className={cn(
                "flex-1 rounded border bg-canvas px-3 py-1.5",
                "font-mono text-xs text-white placeholder-[#3f3f46]",
                "border-border-2 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent",
                "transition-colors",
              )}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDiscover}
              loading={discovering}
            >
              Discover
            </Button>
          </div>

          {discoverError && (
            <p className="mb-3 text-xs text-ev-error">
              {discoverError instanceof Error ? discoverError.message : "Discovery failed"}
            </p>
          )}

          {discovered && (
            <div className="mb-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ev-success">
                {discovered.count} tool{discovered.count !== 1 ? "s" : ""} found
              </p>
              <div className="mb-3 flex flex-col gap-1.5">
                {discovered.tools.map((t) => (
                  <ToolPreview key={t.name} tool={t} />
                ))}
              </div>
              <Button type="button" size="sm" onClick={handleRegister} loading={registering}>
                {registered ? "Registered" : "Register all tools"}
              </Button>
            </div>
          )}
        </div>

        {/* Registered servers */}
        <div>
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[#3f3f46]">
            Registered This Session
          </p>

          {serversLoading && <p className="text-xs text-[#3f3f46]">Loading…</p>}

          {!serversLoading && servers?.length === 0 && (
            <p className="text-xs text-[#3f3f46]">
              No servers registered yet. Discover one above to add its tools to all future
              workflows.
            </p>
          )}

          <div className="flex flex-col gap-2">
            {servers?.map((s) => (
              <ServerCard
                key={`${s.url}-${s.registeredAt}`}
                url={s.url}
                toolNames={s.toolNames}
                registeredAt={s.registeredAt}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
