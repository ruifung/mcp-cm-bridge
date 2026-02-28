/**
 * JSON Schema to Zod conversion utilities, plus local replacements for the
 * @cloudflare/codemode helpers that leaked `cloudflare:workers` into Node.js.
 *
 * Extracted to a shared module to avoid circular imports between server.ts
 * and tool-search.ts.
 */

import { z } from "zod";
import * as acorn from "acorn";
import { createAuxiliaryTypeStore, createTypeAlias, printNode, zodToTs } from "zod-to-ts";

// ── normalizeCode ─────────────────────────────────────────────────────────────
// Inlined verbatim from @cloudflare/codemode/dist/ai.js
// Wraps bare code into an async arrow function if it isn't already one.

export function normalizeCode(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) return "async () => {}";
  try {
    const ast = acorn.parse(trimmed, { ecmaVersion: "latest", sourceType: "module" });
    if (ast.body.length === 1 && ast.body[0].type === "ExpressionStatement") {
      if ((ast.body[0] as any).expression.type === "ArrowFunctionExpression") return trimmed;
    }
    const last = ast.body[ast.body.length - 1] as any;
    if (last?.type === "ExpressionStatement") {
      return `async () => {\n${trimmed.slice(0, last.start)}return (${trimmed.slice(last.expression.start, last.expression.end)})\n}`;
    }
    return `async () => {\n${trimmed}\n}`;
  } catch {
    return `async () => {\n${trimmed}\n}`;
  }
}

// ── sanitizeToolName ──────────────────────────────────────────────────────────
// Inlined verbatim from @cloudflare/codemode/dist/types-B9g5T2nd.js
// (the clean internal module that does NOT import cloudflare:workers).

const JS_RESERVED = new Set([
  "abstract", "arguments", "await", "boolean", "break", "byte", "case",
  "catch", "char", "class", "const", "continue", "debugger", "default",
  "delete", "do", "double", "else", "enum", "eval", "export", "extends",
  "false", "final", "finally", "float", "for", "function", "goto", "if",
  "implements", "import", "in", "instanceof", "int", "interface", "let",
  "long", "native", "new", "null", "package", "private", "protected",
  "public", "return", "short", "static", "super", "switch", "synchronized",
  "this", "throw", "throws", "transient", "true", "try", "typeof",
  "undefined", "var", "void", "volatile", "while", "with", "yield",
]);

/**
 * Sanitize a tool name into a valid JavaScript identifier.
 * Replaces hyphens, dots, and spaces with `_`, strips other invalid chars,
 * prefixes digit-leading names with `_`, and appends `_` to JS reserved words.
 *
 * Inlined from @cloudflare/codemode to avoid the cloudflare:workers import
 * that lives in that package's main entry point.
 */
export function sanitizeToolName(name: string): string {
  if (!name) return "_";
  let sanitized = name.replace(/[-.\s]/g, "_");
  sanitized = sanitized.replace(/[^a-zA-Z0-9_$]/g, "");
  if (!sanitized) return "_";
  if (/^[0-9]/.test(sanitized)) sanitized = "_" + sanitized;
  if (JS_RESERVED.has(sanitized)) sanitized = sanitized + "_";
  return sanitized;
}

// ── generateTypes ─────────────────────────────────────────────────────────────
// Local reimplementation of @cloudflare/codemode's generateTypes(), which also
// lives in the clean types-B9g5T2nd.js module but is re-exported through the
// polluted main index. We use zod-to-ts directly (already a transitive dep).

function toCamelCase(str: string): string {
  return str
    .replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
    .replace(/^[a-z]/, (letter: string) => letter.toUpperCase());
}

function extractParamDescriptions(schema: z.ZodType): string[] {
  const descriptions: string[] = [];
  const shape = (schema as any).shape;
  if (!shape || typeof shape !== "object") return descriptions;
  for (const [fieldName, fieldSchema] of Object.entries(shape)) {
    const desc = (fieldSchema as any).description;
    if (desc) descriptions.push(`@param input.${fieldName} - ${desc}`);
  }
  return descriptions;
}

/**
 * Descriptor shape accepted by generateTypes — mirrors the upstream type.
 */
export interface ToolDescriptorForTypes {
  description?: string;
  inputSchema: z.ZodType;
  outputSchema?: z.ZodType;
}

/**
 * Generate TypeScript type definitions from tool descriptors.
 *
 * Output format is identical to @cloudflare/codemode's generateTypes() so
 * that the LLM-facing schema snippets are unchanged.  Reimplemented here to
 * avoid importing the main @cloudflare/codemode entry point, which contains a
 * top-level `import { RpcTarget } from "cloudflare:workers"` that fails in
 * Node.js.
 */
export function generateTypes(tools: Record<string, ToolDescriptorForTypes>): string {
  let availableTools = "";
  let availableTypes = "";
  const auxiliaryTypeStore = createAuxiliaryTypeStore();

  for (const [toolName, tool] of Object.entries(tools)) {
    const inputSchema = tool.inputSchema;
    const outputSchema = tool.outputSchema;
    const description = tool.description;
    const safeName = sanitizeToolName(toolName);
    const inputType = printNode(
      createTypeAlias(
        zodToTs(inputSchema, { auxiliaryTypeStore }).node,
        `${toCamelCase(safeName)}Input`
      )
    );
    const outputType = outputSchema
      ? printNode(
          createTypeAlias(
            zodToTs(outputSchema, { auxiliaryTypeStore }).node,
            `${toCamelCase(safeName)}Output`
          )
        )
      : `type ${toCamelCase(safeName)}Output = unknown`;

    availableTypes += `\n${inputType.trim()}`;
    availableTypes += `\n${outputType.trim()}`;

    const paramDescs = extractParamDescriptions(inputSchema);
    const jsdocLines: string[] = [];
    if (description?.trim()) jsdocLines.push(description.trim());
    else jsdocLines.push(toolName);
    for (const pd of paramDescs) jsdocLines.push(pd);
    const jsdocBody = jsdocLines.map((l) => `\t * ${l}`).join("\n");

    availableTools += `\n\t/**\n${jsdocBody}\n\t */`;
    availableTools += `\n\t${safeName}: (input: ${toCamelCase(safeName)}Input) => Promise<${toCamelCase(safeName)}Output>;`;
    availableTools += "\n";
  }

  availableTools = `\ndeclare const codemode: {${availableTools}}`;
  return `
${availableTypes}
${availableTools}
  `.trim();
}

/**
 * Convert JSON Schema to Zod schema.
 * MCP tools use JSON Schema, but createCodeTool expects Zod schemas.
 */
export function jsonSchemaToZod(schema: any): z.ZodType<any> {
  // Handle null/undefined
  if (!schema) {
    return z.object({}).strict();
  }

  // Handle object type
  if (schema.type === "object" || !schema.type) {
    const props: Record<string, z.ZodType<any>> = {};

    if (schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        props[key] = jsonSchemaToZod(prop as any);
      }
    }

    if (schema.required && Array.isArray(schema.required)) {
      const required = new Set(schema.required);
      const finalProps: Record<string, z.ZodType<any>> = {};

      for (const [key, zodSchema] of Object.entries(props)) {
        if (required.has(key)) {
          finalProps[key] = zodSchema;
        } else {
          finalProps[key] = (zodSchema as any).optional();
        }
      }
      return z.object(finalProps).strict();
    }

    // Make all fields optional if no required list
    const optionalProps: Record<string, z.ZodType<any>> = {};
    for (const [key, zodSchema] of Object.entries(props)) {
      optionalProps[key] = (zodSchema as any).optional();
    }
    return z.object(optionalProps).strict();
  }

  // Handle array type
  if (schema.type === "array") {
    const itemSchema = schema.items ? jsonSchemaToZod(schema.items) : z.any();
    let arraySchema = z.array(itemSchema);

    // Apply array constraints
    if (typeof schema.minItems === "number") {
      arraySchema = arraySchema.min(schema.minItems);
    }
    if (typeof schema.maxItems === "number") {
      arraySchema = arraySchema.max(schema.maxItems);
    }

    return arraySchema;
  }

  // Handle string type
  if (schema.type === "string") {
    let stringSchema = z.string();

    // Handle enum
    if (schema.enum && Array.isArray(schema.enum)) {
      return z.enum(schema.enum as [string, ...string[]]);
    }

    // Apply string format constraints
    if (schema.format) {
      switch (schema.format) {
        case "email":
          stringSchema = stringSchema.email();
          break;
        case "uuid":
          stringSchema = stringSchema.uuid();
          break;
        case "url":
          stringSchema = stringSchema.url();
          break;
        case "date-time":
          stringSchema = stringSchema.datetime();
          break;
      }
    }

    // Apply string length constraints
    if (typeof schema.minLength === "number") {
      stringSchema = stringSchema.min(schema.minLength);
    }
    if (typeof schema.maxLength === "number") {
      stringSchema = stringSchema.max(schema.maxLength);
    }
    if (schema.pattern) {
      stringSchema = stringSchema.regex(new RegExp(schema.pattern));
    }

    return stringSchema;
  }

  // Handle number type
  if (schema.type === "number") {
    let numberSchema = z.number();

    // Apply number constraints
    if (typeof schema.minimum === "number") {
      numberSchema = numberSchema.min(schema.minimum);
    }
    if (typeof schema.maximum === "number") {
      numberSchema = numberSchema.max(schema.maximum);
    }
    if (typeof schema.multipleOf === "number") {
      numberSchema = numberSchema.multipleOf(schema.multipleOf);
    }

    return numberSchema;
  }

  // Handle integer type
  if (schema.type === "integer") {
    let intSchema = z.number().int();

    // Apply number constraints
    if (typeof schema.minimum === "number") {
      intSchema = intSchema.min(schema.minimum);
    }
    if (typeof schema.maximum === "number") {
      intSchema = intSchema.max(schema.maximum);
    }
    if (typeof schema.multipleOf === "number") {
      intSchema = intSchema.multipleOf(schema.multipleOf);
    }

    return intSchema;
  }

  // Handle boolean type
  if (schema.type === "boolean") {
    return z.boolean();
  }

  // Handle null type
  if (schema.type === "null") {
    return z.null();
  }

  // Handle anyOf (union types)
  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    const schemas = schema.anyOf.map((s: any) => jsonSchemaToZod(s));
    return z.union(schemas as [z.ZodType<any>, z.ZodType<any>, ...z.ZodType<any>[]]);
  }

  // Handle oneOf (discriminated union)
  if (schema.oneOf && Array.isArray(schema.oneOf)) {
    const schemas = schema.oneOf.map((s: any) => jsonSchemaToZod(s));
    return z.union(schemas as [z.ZodType<any>, z.ZodType<any>, ...z.ZodType<any>[]]);
  }

  // Handle allOf (intersection types)
  if (schema.allOf && Array.isArray(schema.allOf)) {
    // Zod doesn't have native intersection for objects, so merge them
    let merged: z.ZodType<any> = z.object({});
    for (const subSchema of schema.allOf) {
      const zodSchema = jsonSchemaToZod(subSchema);
      merged = (merged as any).and(zodSchema);
    }
    return merged;
  }

  // Handle enum for non-string types
  if (schema.enum && Array.isArray(schema.enum)) {
    if (schema.enum.length === 1) {
      return z.literal(schema.enum[0]);
    }
    // Create union of literals
    const literals = schema.enum.map((val: any) => z.literal(val));
    return z.union(literals as [z.ZodType<any>, z.ZodType<any>, ...z.ZodType<any>[]]);
  }

  // Default to any
  return z.any();
}
