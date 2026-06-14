export type JSONSchema = Record<string, unknown>;

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: true;
};

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResult = {
  content: ToolContent[];
  isError?: boolean;
};

export type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  annotations: ToolAnnotations;
  handler: ToolHandler;
};

export type ParameterDef = {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: JSONSchema;
  description?: string;
};

export type OperationDef = {
  operationId: string;
  toolName: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: ParameterDef[];
  requestBodySchema?: JSONSchema;
  requestBodyRequired?: boolean;
  responseSchema?: JSONSchema;
  returnsAction: boolean;
  isDestructive: boolean;
};
