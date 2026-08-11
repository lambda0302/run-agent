import { z } from "zod";
import type { Decision } from "./permissions/types.js";
import type { LLMClient, ToolSpec } from "./providers/types.js";
import { readTool } from "./tools/read.js";
import { writeTool } from "./tools/write.js";
import { editTool } from "./tools/edit.js";
import { globTool } from "./tools/glob.js";
import { grepTool } from "./tools/grep.js";
import { bashTool } from "./tools/bash/index.js";
import { makeRememberTool } from "./tools/remember.js";
import { makeExploreTool } from "./tools/explore.js";
import { repoMapTool } from "./tools/repo_map.js";
import { verifyTool } from "./tools/verify.js";

/** 一次工具调用的返回：result 会回填进对话；artifacts 是落盘副产物路径（如被截断的完整输出）。 */
export interface ToolCallResult {
  result: string;
  artifacts?: string[];
}

/** V1 定版的工具接口。isConcurrencySafe 为 V2 并发调度预留。 */
export interface Tool {
  name: string;
  description: string;
  /** 用 zod 描述入参，注册时转成 JSON Schema 给模型。 */
  inputSchema: z.ZodType;
  call(input: unknown): Promise<ToolCallResult>;
  /** V2 预留：是否可与其他工具并发执行。默认 true。 */
  isConcurrencySafe?: boolean;
}

/**
 * 转换器参数用 unknown，配合 instanceof 窄化：
 * zod v4 同时存在 classic（z.ZodString…）与 lazy（$ZodType…）两套类型，
 * 访问器（.element/.options/.shape）返回新风格类型，结构上不兼容旧风格。
 * 运行时两者都是同一批 class，instanceof 判型一致，这里只做类型桥接。
 */
function unwrap(schema: unknown): unknown {
  let s: unknown = schema;
  while (s instanceof z.ZodOptional || s instanceof z.ZodNullable || s instanceof z.ZodDefault) {
    s = (s as z.ZodOptional<z.ZodType>).unwrap();
  }
  return s;
}

/**
 * zod → JSON Schema（手写，覆盖 V1 用到的常见类型）。
 * 刻意不引 zod-to-json-schema，避免多一个依赖（Plan V1 §6.4）。
 */
export function zodToJsonSchema(schema: unknown): Record<string, unknown> {
  const s = unwrap(schema);
  let out: Record<string, unknown> = {};

  if (s instanceof z.ZodString) {
    out = { type: "string" };
    if (s.minLength !== null) out.minLength = s.minLength;
    if (s.maxLength !== null) out.maxLength = s.maxLength;
  } else if (s instanceof z.ZodNumber) {
    out = { type: "number" };
    // 无界时 minValue/maxValue 是 ±Infinity，不算入 schema
    if (Number.isFinite(s.minValue)) out.minimum = s.minValue;
    if (Number.isFinite(s.maxValue)) out.maximum = s.maxValue;
  } else if (s instanceof z.ZodBoolean) {
    out = { type: "boolean" };
  } else if (s instanceof z.ZodLiteral) {
    const v = s.value;
    const t = typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string";
    out = { type: t, const: v };
  } else if (s instanceof z.ZodEnum) {
    out = { type: "string", enum: [...s.options] };
  } else if (s instanceof z.ZodArray) {
    out = { type: "array", items: zodToJsonSchema(s.element) };
  } else if (s instanceof z.ZodRecord) {
    const valueType = (s._def as unknown as { valueType: unknown }).valueType;
    out = { type: "object", additionalProperties: zodToJsonSchema(valueType) };
  } else if (s instanceof z.ZodUnion) {
    out = { anyOf: s.options.map((o) => zodToJsonSchema(o)) };
  } else if (s instanceof z.ZodObject) {
    const shape = s.shape as Record<string, unknown>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, sub] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(sub);
      // optional 字段不进 required
      if (!(sub instanceof z.ZodOptional)) required.push(key);
    }
    out = { type: "object", properties, ...(required.length ? { required } : {}) };
  }

  // description 挂在原 schema 上（unwrap 前），统一补上
  const desc = (schema as { description?: string }).description;
  if (desc) out.description = desc;
  return out;
}

/** 工具 → 给模型的 ToolSpec（JSON Schema 化） */
export function toToolSpecs(tools: Tool[]): ToolSpec[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema),
  }));
}

/** V1 内置工具注册表（静态部分；remember/explore 需运行时依赖，由 buildTools 装配）。 */
export const TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  bashTool,
  repoMapTool,
  verifyTool,
];

export interface BuildToolsOptions {
  cwd: string;
  isTrusted: boolean;
  homeDir?: string;
  /** explore 工厂依赖：注入 client 才装配 explore（0.4.1；V7 泛化为 Agent 工具）。 */
  client?: LLMClient;
  /** 子 agent 复用的主 system（含 MEMORY.md 索引）；CLI 装配时快照。 */
  system?: string;
  contextWindow?: number;
  /** 权限继承父级（子查询只读工具 default 免确认，用户 deny 规则仍生效）。 */
  checkPermission?: (tool: Tool, input: unknown) => Promise<Decision>;
}

/** 运行时装配完整工具集：静态工具 + remember/explore 工厂实例（注入运行时依赖）。 */
export function buildTools(opts: BuildToolsOptions): Tool[] {
  const tools: Tool[] = [...TOOLS, makeRememberTool(opts)];
  if (opts.client) {
    tools.push(
      makeExploreTool({
        client: opts.client,
        ...(opts.system !== undefined ? { system: opts.system } : {}),
        ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
        ...(opts.checkPermission !== undefined ? { checkPermission: opts.checkPermission } : {}),
      }),
    );
  }
  return tools;
}

export function getTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}
