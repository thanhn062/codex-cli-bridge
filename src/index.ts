import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";

type Dict = Record<string, unknown>;

type BridgeConfig = {
  host: string;
  port: number;
  modelId: string;
  codexBin: string;
  codexExtraArgs: string[];
  codexFormat: string;
  timeoutSeconds: number;
  maxBodyBytes: number;
  maxConcurrentRequests: number;
};

type CodexResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

class HttpError extends Error {
  readonly status: number;
  readonly payload: Dict;

  constructor(status: number, message: string, payload: Dict = {}) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

let activeRequests = 0;

function nowIso(): string {
  return new Date().toISOString();
}

function toInt(raw: string | undefined, fallback: number, min: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
}

function splitCsv(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function coerceBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function parseArgs(argv: string[]): Partial<BridgeConfig> {
  const parsed: Partial<BridgeConfig> = {};
  const extraArgs: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (!arg.startsWith("--")) {
      continue;
    }
    switch (arg) {
      case "--host":
        if (!next) {
          throw new Error("--host requires a value");
        }
        parsed.host = next;
        i += 1;
        break;
      case "--port":
        if (!next) {
          throw new Error("--port requires a value");
        }
        parsed.port = toInt(next, 11434, 1);
        i += 1;
        break;
      case "--model":
        if (!next) {
          throw new Error("--model requires a value");
        }
        parsed.modelId = next;
        i += 1;
        break;
      case "--codex-bin":
        if (!next) {
          throw new Error("--codex-bin requires a value");
        }
        parsed.codexBin = next;
        i += 1;
        break;
      case "--codex-format":
        if (!next) {
          throw new Error("--codex-format requires a value");
        }
        parsed.codexFormat = next;
        i += 1;
        break;
      case "--timeout-seconds":
        if (!next) {
          throw new Error("--timeout-seconds requires a value");
        }
        parsed.timeoutSeconds = toInt(next, 90, 1);
        i += 1;
        break;
      case "--max-body-bytes":
        if (!next) {
          throw new Error("--max-body-bytes requires a value");
        }
        parsed.maxBodyBytes = toInt(next, 32768, 1024);
        i += 1;
        break;
      case "--max-concurrent-requests":
        if (!next) {
          throw new Error("--max-concurrent-requests requires a value");
        }
        parsed.maxConcurrentRequests = toInt(next, 1, 1);
        i += 1;
        break;
      case "--codex-extra-arg":
        if (!next) {
          throw new Error("--codex-extra-arg requires a value");
        }
        extraArgs.push(next);
        i += 1;
        break;
      case "--help":
        console.log(
          [
            "Codex CLI Bridge (Ollama-compatible HTTP)",
            "",
            "Flags:",
            "  --host <host>                      Default: 127.0.0.1",
            "  --port <port>                      Default: 11434",
            "  --model <id>                       Default: codex",
            "  --codex-bin <path>                 Default: codex",
            "  --codex-format <text|json|jsonl>   Default: text",
            "  --codex-extra-arg <value>          Repeatable",
            "  --timeout-seconds <int>            Default: 90",
            "  --max-body-bytes <int>             Default: 32768",
            "  --max-concurrent-requests <int>    Default: 1",
            "",
            "Environment equivalents use CODEX_CLI_BRIDGE_*."
          ].join("\n")
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown_flag: ${arg}`);
    }
  }

  if (extraArgs.length > 0) {
    parsed.codexExtraArgs = extraArgs;
  }
  return parsed;
}

function loadConfig(): BridgeConfig {
  const cli = parseArgs(process.argv.slice(2));
  return {
    host: cli.host ?? process.env.CODEX_CLI_BRIDGE_HOST ?? "127.0.0.1",
    port: cli.port ?? toInt(process.env.CODEX_CLI_BRIDGE_PORT, 11434, 1),
    modelId: cli.modelId ?? process.env.CODEX_CLI_BRIDGE_MODEL ?? "codex",
    codexBin: cli.codexBin ?? process.env.CODEX_CLI_BRIDGE_CODEX_BIN ?? "codex",
    codexExtraArgs:
      cli.codexExtraArgs ??
      splitCsv(process.env.CODEX_CLI_BRIDGE_CODEX_EXTRA_ARGS),
    codexFormat:
      (cli.codexFormat ?? process.env.CODEX_CLI_BRIDGE_CODEX_FORMAT ?? "text").trim().toLowerCase(),
    timeoutSeconds:
      cli.timeoutSeconds ?? toInt(process.env.CODEX_CLI_BRIDGE_TIMEOUT_SECONDS, 90, 1),
    maxBodyBytes:
      cli.maxBodyBytes ?? toInt(process.env.CODEX_CLI_BRIDGE_MAX_BODY_BYTES, 32768, 1024),
    maxConcurrentRequests:
      cli.maxConcurrentRequests ??
      toInt(process.env.CODEX_CLI_BRIDGE_MAX_CONCURRENT_REQUESTS, 1, 1)
  };
}

function sendJson(res: ServerResponse, status: number, payload: Dict): void {
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", String(body.length));
  res.end(body);
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<Dict> {
  const contentLength = req.headers["content-length"];
  if (!contentLength) {
    throw new HttpError(400, "missing_body", { error: "missing_body" });
  }

  const expectedBytes = Number.parseInt(contentLength, 10);
  if (!Number.isFinite(expectedBytes) || expectedBytes <= 0) {
    throw new HttpError(400, "invalid_content_length", { error: "invalid_content_length" });
  }
  if (expectedBytes > maxBodyBytes) {
    throw new HttpError(413, "body_too_large", { error: "body_too_large" });
  }

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += chunkBuffer.length;
    if (received > maxBodyBytes) {
      throw new HttpError(413, "body_too_large", { error: "body_too_large" });
    }
    chunks.push(chunkBuffer);
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected object");
    }
    return parsed as Dict;
  } catch (error) {
    throw new HttpError(400, "invalid_json", {
      error: "invalid_json",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
}

function messagesToPrompt(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }

  const parts: string[] = [];
  for (const item of messages) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const role = typeof item.role === "string" ? item.role.trim() : "";
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!role || !content) {
      continue;
    }
    parts.push(`${role}:\n${content}\n`);
  }

  if (parts.length === 0) {
    return "";
  }
  return `${parts.join("\n").trim()}\n\nassistant:\n`;
}

function toolsToPrompt(tools: unknown): string {
  if (!Array.isArray(tools) || tools.length === 0) {
    return "";
  }

  return (
    "\n\nAvailable tools (JSON schema from caller):\n" +
    JSON.stringify(tools) +
    "\n\nWhen a tool call is needed, respond with ONLY JSON:\n" +
    '{"type":"tool_calls","tool_calls":[{"name":"<tool_name>","arguments":{"arg":"value"}}]}\n' +
    'Otherwise respond with ONLY JSON: {"type":"text","text":"..."}\n' +
    "No markdown. No extra prose outside JSON."
  );
}

function extractJsonObject(raw: string): Dict | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }

  try {
    const direct = JSON.parse(text);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return direct as Dict;
    }
  } catch {
    // Continue with fallback extraction.
  }

  if (text.includes("```")) {
    const blocks = text.split("```");
    for (const block of blocks) {
      const candidate = block.trim().replace(/^json\s*/i, "");
      if (!candidate) {
        continue;
      }
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Dict;
        }
      } catch {
        // Keep trying.
      }
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Dict;
    }
  } catch {
    return null;
  }
  return null;
}

function toolCallsFromObject(obj: Dict): Dict[] {
  const calls = obj.tool_calls;
  if (!Array.isArray(calls)) {
    return [];
  }
  const out: Dict[] = [];
  for (const call of calls) {
    if (!call || typeof call !== "object" || Array.isArray(call)) {
      continue;
    }
    const name = typeof call.name === "string" ? call.name.trim() : "";
    if (!name) {
      continue;
    }
    const rawArgs = call.arguments;
    const argumentsObject =
      rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Dict)
        : {};

    out.push({
      id: `call_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      type: "function",
      function: {
        name,
        arguments: argumentsObject
      }
    });
  }
  return out;
}

function runCodexExec(cfg: BridgeConfig, prompt: string): Promise<CodexResult> {
  const start = Date.now();
  const args: string[] = ["exec"];
  if (cfg.codexFormat === "json" || cfg.codexFormat === "jsonl") {
    args.push("--json");
  }
  args.push(...cfg.codexExtraArgs);
  args.push(prompt);

  return new Promise((resolve) => {
    const child = spawn(cfg.codexBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, cfg.timeoutSeconds * 1000);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: Error) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        timedOut,
        durationMs: Date.now() - start
      });
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timeout);
      resolve({
        ok: !timedOut && code === 0,
        code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - start
      });
    });
  });
}

async function withCapacity<T>(cfg: BridgeConfig, task: () => Promise<T>): Promise<T> {
  if (activeRequests >= cfg.maxConcurrentRequests) {
    throw new HttpError(429, "busy", { error: "busy", detail: "single_request_only" });
  }
  activeRequests += 1;
  try {
    return await task();
  } finally {
    activeRequests -= 1;
  }
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: "not_found" });
}

function modelDetails(modelId: string): Dict {
  return {
    name: modelId,
    model: modelId,
    modified_at: nowIso(),
    size: 0,
    digest: `sha256:${"0".repeat(64)}`,
    details: {
      format: "codex",
      family: "codex",
      families: ["codex"]
    }
  };
}

async function handleGenerate(
  reqBody: Dict,
  cfg: BridgeConfig,
  res: ServerResponse
): Promise<void> {
  const prompt = typeof reqBody.prompt === "string" ? reqBody.prompt.trim() : "";
  if (!prompt) {
    throw new HttpError(400, "missing_prompt", { error: "missing_prompt" });
  }
  if (coerceBool(reqBody.stream, false)) {
    throw new HttpError(400, "unsupported_stream", {
      error: "unsupported_stream",
      detail: "single_request_only"
    });
  }

  const model = typeof reqBody.model === "string" && reqBody.model.trim() ? reqBody.model.trim() : cfg.modelId;
  const result = await withCapacity(cfg, async () => runCodexExec(cfg, prompt));
  if (!result.ok) {
    throw new HttpError(500, "codex_exec_failed", {
      error: "codex_exec_failed",
      timed_out: result.timedOut,
      exit_code: result.code,
      stderr: result.stderr.slice(0, 4000)
    });
  }

  sendJson(res, 200, {
    model,
    created_at: nowIso(),
    response: result.stdout.trim(),
    done: true,
    done_reason: "stop",
    total_duration: result.durationMs * 1_000_000
  });
}

async function handleChat(
  reqBody: Dict,
  cfg: BridgeConfig,
  res: ServerResponse
): Promise<void> {
  if (coerceBool(reqBody.stream, false)) {
    throw new HttpError(400, "unsupported_stream", {
      error: "unsupported_stream",
      detail: "single_request_only"
    });
  }

  const model = typeof reqBody.model === "string" && reqBody.model.trim() ? reqBody.model.trim() : cfg.modelId;
  const prompt = `${messagesToPrompt(reqBody.messages)}${toolsToPrompt(reqBody.tools)}`.trim();
  if (!prompt) {
    throw new HttpError(400, "missing_messages", { error: "missing_messages" });
  }

  const result = await withCapacity(cfg, async () => runCodexExec(cfg, prompt));
  if (!result.ok) {
    throw new HttpError(500, "codex_exec_failed", {
      error: "codex_exec_failed",
      timed_out: result.timedOut,
      exit_code: result.code,
      stderr: result.stderr.slice(0, 4000)
    });
  }

  const stdout = result.stdout.trim();
  const parsed = extractJsonObject(stdout);
  let message: Dict;
  if (parsed && parsed.type === "tool_calls") {
    const toolCalls = toolCallsFromObject(parsed);
    if (toolCalls.length > 0) {
      message = { role: "assistant", content: "", tool_calls: toolCalls };
    } else {
      message = { role: "assistant", content: stdout };
    }
  } else if (parsed && typeof parsed.text === "string") {
    message = { role: "assistant", content: parsed.text.trim() };
  } else {
    message = { role: "assistant", content: stdout };
  }

  sendJson(res, 200, {
    model,
    created_at: nowIso(),
    message,
    done: true,
    done_reason: "stop",
    total_duration: result.durationMs * 1_000_000
  });
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: BridgeConfig
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (method === "GET" && (path === "/" || path === "/healthz")) {
    sendJson(res, 200, {
      ok: true,
      mode: "ollama-compatible-http",
      runtime_mode: "single_request_only",
      auth: "localhost_only_no_auth"
    });
    return;
  }

  if (method === "GET" && path === "/api/version") {
    sendJson(res, 200, { version: "0.1.0-codex-cli-bridge" });
    return;
  }

  if (method === "GET" && path === "/api/tags") {
    sendJson(res, 200, { models: [modelDetails(cfg.modelId)] });
    return;
  }

  if (method === "GET" && path === "/api/ps") {
    sendJson(res, 200, {
      models: [
        {
          ...modelDetails(cfg.modelId),
          expires_at: nowIso(),
          size_vram: 0
        }
      ]
    });
    return;
  }

  if (method !== "POST") {
    notFound(res);
    return;
  }

  const body = await readJsonBody(req, cfg.maxBodyBytes);

  if (path === "/api/show") {
    const model = typeof body.name === "string" && body.name.trim() ? body.name.trim() : cfg.modelId;
    sendJson(res, 200, {
      modelfile: "",
      parameters: "",
      template: "",
      details: { format: "codex", family: "codex" },
      model_info: {},
      license: "",
      name: model
    });
    return;
  }

  if (path === "/api/pull") {
    sendJson(res, 200, {
      status: "success",
      digest: `sha256:${"0".repeat(64)}`,
      total: 0,
      completed: 0,
      done: true
    });
    return;
  }

  if (path === "/api/generate") {
    await handleGenerate(body, cfg, res);
    return;
  }

  if (path === "/api/chat") {
    await handleChat(body, cfg, res);
    return;
  }

  notFound(res);
}

function main(): void {
  const cfg = loadConfig();
  const server = createServer(async (req, res) => {
    try {
      await routeRequest(req, res, cfg);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, error.payload);
        return;
      }
      sendJson(res, 500, {
        error: "internal_error",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  });

  server.listen(cfg.port, cfg.host, () => {
    console.log(
      JSON.stringify({
        event: "bridge_started",
        host: cfg.host,
        port: cfg.port,
        model: cfg.modelId,
        codex_bin: cfg.codexBin,
        codex_extra_args: cfg.codexExtraArgs,
        codex_format: cfg.codexFormat,
        timeout_seconds: cfg.timeoutSeconds,
        max_body_bytes: cfg.maxBodyBytes,
        max_concurrent_requests: cfg.maxConcurrentRequests,
        runtime_mode: "single_request_only",
        auth: "localhost_only_no_auth"
      })
    );
  });
}

main();
