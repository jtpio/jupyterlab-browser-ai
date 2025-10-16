/* eslint-disable */
/// <reference types="@types/dom-chromium-ai" />

import { LanguageModelV2, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { BuiltInAIChatLanguageModel } from '@built-in-ai/core';

/**
 * Extended Chrome AI provider that adds tool calling support via JSON parsing.
 *
 * This provider extends the built-in AI model to:
 * 1. Use the polyfill to inject tool calling instructions into the system prompt
 * 2. Parse JSON tool call responses from the model
 * 3. Convert them to properly structured tool calls that the AI SDK expects
 *
 * The polyfill instructs the model to return tool calls in this JSON format:
 * {
 *   "output": [
 *     {
 *       "type": "function_call",
 *       "callId": "call_1",
 *       "name": "tool_name",
 *       "arguments": "{\"arg1\": \"value1\"}"
 *     }
 *   ]
 * }
 *
 * This provider detects that format and converts it to proper AI SDK tool call objects.
 */
export class ChromeAIToolCallingProvider extends BuiltInAIChatLanguageModel {
  /**
   * Parse JSON tool call response if present, otherwise return null.
   * Handles various formats including:
   * - Plain JSON
   * - JSON wrapped in markdown code blocks
   * - JSON with text before/after
   */
  private parseToolCallResponse(text: string): {
    type: 'function_call';
    callId: string;
    name: string;
    arguments: string;
  }[] | null {
    let jsonText = text.trim();

    // Try 1: Extract from markdown code block (```json ... ``` or ``` ... ```)
    const codeBlockMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      jsonText = codeBlockMatch[1].trim();
    }

    // Try 2: Find JSON object in the text (look for { ... } pattern)
    if (!jsonText.startsWith('{')) {
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
      }
    }

    try {
      const parsed = JSON.parse(jsonText);

      // Check if it matches the expected tool call format
      if (parsed.output && Array.isArray(parsed.output)) {
        // Validate that all items are function calls
        const isToolCallResponse = parsed.output.every(
          (item: any) => {
            const hasRequiredFields =
              item.type === 'function_call' &&
              item.callId &&
              item.name &&
              typeof item.arguments === 'string';

            if (!hasRequiredFields) {
              console.warn('Invalid tool call item:', item);
            }

            return hasRequiredFields;
          }
        );

        if (isToolCallResponse) {
          console.log('Successfully parsed tool call:', parsed.output);
          return parsed.output;
        } else {
          console.warn('Tool call validation failed. Expected format with type="function_call", callId, name, and arguments (string)');
        }
      } else if (parsed.output) {
        console.warn('Tool call output is not an array:', parsed);
      }

      return null;
    } catch (error) {
      // Not JSON or doesn't match expected format - treat as regular text
      // Only log if the text looks like it might be trying to be JSON
      if (jsonText.includes('{') && jsonText.includes('output')) {
        console.warn('Failed to parse potential tool call response:', error);
        console.warn('Text:', jsonText.substring(0, 200));
      }
      return null;
    }
  }

  /**
   * Override doGenerate to parse tool calls from the response
   */
  async doGenerate(options: Parameters<BuiltInAIChatLanguageModel['doGenerate']>[0]): Promise<Awaited<ReturnType<BuiltInAIChatLanguageModel['doGenerate']>>> {
    // Call the parent implementation
    const result = await super.doGenerate(options);

    // Check if the response is a text response (should always be for Prompt API)
    if (result.content.length === 1 && result.content[0].type === 'text') {
      const text = result.content[0].text;
      const toolCalls = this.parseToolCallResponse(text);

      if (toolCalls) {
        // Convert to AI SDK tool call format
        // The 'input' field should be the JSON string, not a parsed object
        const content = toolCalls.map(call => ({
          type: 'tool-call' as const,
          toolCallId: call.callId,
          toolName: call.name,
          input: call.arguments
        }));

        return {
          ...result,
          content,
          finishReason: 'tool-calls'
        };
      }
    }

    // Return as-is if not a tool call
    return result;
  }

  /**
   * Override doStream to parse tool calls from the streamed response
   */
  async doStream(options: Parameters<BuiltInAIChatLanguageModel['doStream']>[0]): Promise<Awaited<ReturnType<BuiltInAIChatLanguageModel['doStream']>>> {
    // Call the parent implementation
    const result = await super.doStream(options);

    // Buffer the entire text response to detect tool calls
    let bufferedText = '';
    let textId: string | null = null;

    const transformedStream = result.stream.pipeThrough(
      new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>({
        transform: (chunk, controller) => {
          // Buffer text chunks
          if (chunk.type === 'text-start') {
            textId = chunk.id;
            bufferedText = '';
            return; // Don't forward yet
          }

          if (chunk.type === 'text-delta') {
            bufferedText += chunk.delta;
            return; // Don't forward yet
          }

          if (chunk.type === 'text-end') {
            // Now we have the complete text, check if it's a tool call
            const toolCalls = this.parseToolCallResponse(bufferedText);

            if (toolCalls) {
              // Emit tool call events instead of text
              for (const call of toolCalls) {
                controller.enqueue({
                  type: 'tool-input-start',
                  id: call.callId,
                  toolName: call.name
                });

                controller.enqueue({
                  type: 'tool-input-delta',
                  id: call.callId,
                  delta: call.arguments
                });

                controller.enqueue({
                  type: 'tool-input-end',
                  id: call.callId
                });

                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: call.callId,
                  toolName: call.name,
                  input: call.arguments
                });
              }
            } else {
              // Not a tool call, forward the buffered text
              if (textId) {
                controller.enqueue({
                  type: 'text-start',
                  id: textId
                });

                controller.enqueue({
                  type: 'text-delta',
                  id: textId,
                  delta: bufferedText
                });

                controller.enqueue({
                  type: 'text-end',
                  id: textId
                });
              }
            }

            return;
          }

          // Forward all other events
          controller.enqueue(chunk);
        }
      })
    );

    return {
      ...result,
      stream: transformedStream
    };
  }
}

/**
 * Factory function to create a Chrome AI provider with tool calling support
 */
export function createChromeAIProvider(modelId: 'text' = 'text', settings?: any): LanguageModelV2 {
  return new ChromeAIToolCallingProvider(modelId, settings);
}
