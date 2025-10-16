/* eslint-disable */
/// <reference types="@types/dom-chromium-ai" />

/**
 * Polyfill for the Prompt API tool calling functionality.
 *
 * This polyfill enables tool use with the Prompt API by intercepting the `tools` option
 * and instructing the model to return tool calls in a structured format. This is necessary
 * because native browser implementations don't yet support the `tools` parameter defined in the spec.
 *
 * Spec: https://webmachinelearning.github.io/prompt-api/
 *
 * NOTE: This polyfill only handles formatting the tool call requests. It does NOT execute
 * the tools - that responsibility is left to the OpenAI Agents framework, which parses
 * the tool call JSON and handles execution and the tool-calling loop.
 */

// A weak map to associate language model sessions with their registered tools.
// Using a WeakMap ensures that once a session is garbage-collected, the associated tools are as well.
const sessionTools = new WeakMap<LanguageModel, LanguageModelTool[]>();

// Store the original static `create` method from the LanguageModel interface.
const originalCreate = LanguageModel.create;

/**
 * JSON Schema interface for tool input schemas
 */
interface JSONSchema {
  type?: string;
  properties?: Record<string, any>;
  required?: string[];
  description?: string;
  [key: string]: any;
}

/**
 * Helper function to build the system prompt that instructs the model how to use tools.
 * Updated to match OpenAI Agents.js SDK format with FunctionCallItem structure.
 */
function buildToolSystemPrompt(tools: LanguageModelTool[]): string {
  // Format each tool with its name, description, and parameters
  const toolDefinitions = tools
    .map(tool => {
      const schema = tool.inputSchema as JSONSchema;
      const properties = schema?.properties || {};
      const required = schema?.required || [];

      // Format each parameter
      const paramsList = Object.entries(properties)
        .map(([name, schema]: [string, any]) => {
          const isRequired = required.includes(name);
          const typeInfo = schema.type || 'any';
          const desc = schema.description || '';
          return `    - ${name} (${typeInfo}${isRequired ? ', required' : ''}): ${desc}`;
        })
        .join('\n');

      return `## ${tool.name}\n${tool.description || ''}\nParameters:\n${paramsList || '    (no parameters)'}`;
    })
    .join('\n\n');

  // Create a concrete example using the first tool if available
  let exampleSection = '';
  if (tools.length > 0) {
    const firstTool = tools[0];
    const exampleArgs: Record<string, any> = {};

    // Build example arguments from the schema
    const schema = firstTool.inputSchema as JSONSchema;
    if (schema?.properties) {
      Object.entries(schema.properties).forEach(
        ([name, schema]: [string, any]) => {
          if (schema.type === 'string') {
            exampleArgs[name] = schema.description
              ? `"example ${name}"`
              : '"example value"';
          } else if (schema.type === 'number') {
            exampleArgs[name] = 42;
          } else if (schema.type === 'boolean') {
            exampleArgs[name] = true;
          } else {
            exampleArgs[name] = 'example';
          }
        }
      );
    }

    const exampleArgsStr = JSON.stringify(exampleArgs);

    exampleSection = `

# EXAMPLE
If you need to call ${firstTool.name}, respond with exactly this JSON format:
\`\`\`json
{
  "output": [
    {
      "type": "function_call",
      "callId": "call_1",
      "name": "${firstTool.name}",
      "arguments": ${JSON.stringify(exampleArgsStr)}
    }
  ]
}
\`\`\`

IMPORTANT: The "arguments" field must be a JSON STRING (not an object). It's a string containing JSON.`;
  }

  return `# SYSTEM INSTRUCTIONS

You are an AI assistant with access to tools. When you need to use a tool to answer the user's question, you must respond with ONLY a JSON object in the following format (no other text):

{
  "output": [
    {
      "type": "function_call",
      "callId": "call_1",
      "name": "tool_name",
      "arguments": "{\\"param1\\": \\"value1\\", \\"param2\\": \\"value2\\"}"
    }
  ]
}

# RULES
1. The "arguments" field MUST be a JSON string, not an object
2. Generate a unique callId for each function call (e.g., "call_1", "call_2")
3. You can call multiple tools by adding more objects to the "output" array
4. When calling a tool, respond with ONLY the JSON (no explanatory text before or after)
5. After receiving tool results, provide your final answer to the user in natural language

# AVAILABLE TOOLS

${toolDefinitions}${exampleSection}

Remember: When you use a tool, your response must be ONLY the JSON object, nothing else.`;
}

/**
 * Helper function to prepend system prompt to the first user message.
 * This is necessary because the prompt() and promptStreaming() methods don't support system roles.
 */
function prependSystemPromptToMessages(
  messages: LanguageModelMessage[],
  systemPrompt: string
): LanguageModelMessage[] {
  const allPrompts = Array.isArray(messages) ? [...messages] : [messages];

  const firstUserMessageIndex = allPrompts.findIndex(p => p.role === 'user');

  if (firstUserMessageIndex !== -1) {
    const firstUserMessage = allPrompts[firstUserMessageIndex];
    const originalContent =
      typeof firstUserMessage.content === 'string'
        ? firstUserMessage.content
        : JSON.stringify(firstUserMessage.content);

    allPrompts[firstUserMessageIndex] = {
      ...firstUserMessage,
      content: `${systemPrompt}\n\n${originalContent}`
    };
  } else {
    // If there's no user message, create one with the system prompt.
    allPrompts.unshift({
      role: 'user',
      content: systemPrompt
    });
  }

  return allPrompts;
}

/**
 * Wraps LanguageModel.create to intercept the `tools` parameter.
 * This allows us to store the tools and later apply the tool-calling logic
 * to the session's prompt methods.
 */
LanguageModel.create = async function (
  options?: LanguageModelCreateOptions
): Promise<LanguageModel> {
  const tools = options?.tools ?? [];

  // If no tools are provided, just call the original create method.
  if (tools.length === 0) {
    return originalCreate(options);
  }

  // Create a copy of options and remove tools, as the native implementation
  // does not yet support their execution.
  const newOptions: LanguageModelCreateOptions = { ...options };
  delete newOptions.tools;

  // Call the original create method.
  const session = await originalCreate(newOptions);

  // Store the tools associated with the newly created session.
  sessionTools.set(session, tools);

  const systemPrompt = buildToolSystemPrompt(tools);

  // Wrap the prompt method to handle the tool-calling logic.
  const originalPrompt = session.prompt.bind(session);
  session.prompt = async (
    input: LanguageModelPrompt,
    promptOptions?: LanguageModelPromptOptions
  ): Promise<string> => {
    // Normalize input to array of messages
    let allPrompts: LanguageModelMessage[] = Array.isArray(input)
      ? [...input]
      : [{ role: 'user', content: input }];

    // Prepend system prompt with tool instructions
    allPrompts = prependSystemPromptToMessages(allPrompts, systemPrompt);

    // Get the response from the model
    const response = await originalPrompt(allPrompts, promptOptions);

    // Return the response directly - let the OpenAI Agents framework handle tool execution
    return response;
  };

  // Wrap the promptStreaming method to handle the tool-calling logic.
  const originalPromptStreaming = session.promptStreaming.bind(session);
  session.promptStreaming = function (
    input: LanguageModelPrompt,
    promptOptions?: LanguageModelPromptOptions
  ): ReadableStream<string> {
    // Normalize input to array of messages
    let allPrompts: LanguageModelMessage[] = Array.isArray(input)
      ? [...input]
      : [{ role: 'user', content: input }];

    // Prepend system prompt with tool instructions
    allPrompts = prependSystemPromptToMessages(allPrompts, systemPrompt);

    // Return the stream directly - let the OpenAI Agents framework handle tool execution
    return originalPromptStreaming(allPrompts, promptOptions);
  };

  return session;
};

// Make this file a module
export {};
