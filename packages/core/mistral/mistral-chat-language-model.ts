import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
  LanguageModelV1,
  LanguageModelV1CallWarning,
  LanguageModelV1StreamPart,
  ParsedChunk,
  UnsupportedFunctionalityError,
  createEventSourceResponseHandler,
  createJsonResponseHandler,
  postJsonToApi,
} from '../ai-model-specification';
import { convertToMistralChatMessages } from './convert-to-mistral-chat-messages';
import { mapMistralFinishReason } from './map-mistral-finish-reason';
import {
  MistralChatModelId,
  MistralChatSettings,
} from './mistral-chat-settings';
import { mistralFailedResponseHandler } from './mistral-error';

type MistralChatConfig = {
  provider: string;
  baseUrl: string;
  headers: () => Record<string, string | undefined>;
};

export class MistralChatLanguageModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1';
  readonly defaultObjectGenerationMode = 'json';

  readonly modelId: MistralChatModelId;
  readonly settings: MistralChatSettings;

  private readonly config: MistralChatConfig;

  constructor(
    modelId: MistralChatModelId,
    settings: MistralChatSettings,
    config: MistralChatConfig,
  ) {
    this.modelId = modelId;
    this.settings = settings;
    this.config = config;
  }

  get provider(): string {
    return this.config.provider;
  }

  private getArgs({
    mode,
    prompt,
    maxTokens,
    temperature,
    topP,
    frequencyPenalty,
    presencePenalty,
    seed,
  }: Parameters<LanguageModelV1['doGenerate']>[0]) {
    const type = mode.type;

    const warnings: LanguageModelV1CallWarning[] = [];

    if (frequencyPenalty != null) {
      warnings.push({
        type: 'unsupported-setting',
        setting: 'frequencyPenalty',
      });
    }

    if (presencePenalty != null) {
      warnings.push({
        type: 'unsupported-setting',
        setting: 'presencePenalty',
      });
    }

    const baseArgs = {
      // model id:
      model: this.modelId,

      // model specific settings:
      safe_prompt: this.settings.safePrompt,

      // standardized settings:
      max_tokens: maxTokens,
      temperature, // uses 0..1 scale
      top_p: topP,
      random_seed: seed,

      // messages:
      messages: convertToMistralChatMessages({
        provider: this.provider,
        prompt,
      }),
    };

    switch (type) {
      case 'regular': {
        // when the tools array is empty, change it to undefined to prevent OpenAI errors:
        const tools = mode.tools?.length ? mode.tools : undefined;

        return {
          args: {
            ...baseArgs,
            tools: tools?.map(tool => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          },
          warnings,
        };
      }

      case 'object-json': {
        return {
          args: {
            ...baseArgs,
            response_format: { type: 'json_object' },
          },
          warnings,
        };
      }

      case 'object-tool': {
        return {
          args: {
            ...baseArgs,
            tool_choice: 'any',
            tools: [{ type: 'function', function: mode.tool }],
          },
          warnings,
        };
      }

      case 'object-grammar': {
        throw new UnsupportedFunctionalityError({
          functionality: 'object-grammar mode',
          provider: this.provider,
        });
      }

      default: {
        const _exhaustiveCheck: never = type;
        throw new Error(`Unsupported type: ${_exhaustiveCheck}`);
      }
    }
  }

  async doGenerate(
    options: Parameters<LanguageModelV1['doGenerate']>[0],
  ): Promise<Awaited<ReturnType<LanguageModelV1['doGenerate']>>> {
    const { args, warnings } = this.getArgs(options);

    const response = await postJsonToApi({
      url: `${this.config.baseUrl}/chat/completions`,
      headers: this.config.headers(),
      body: args,
      failedResponseHandler: mistralFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(
        openAIChatResponseSchema,
      ),
      abortSignal: options.abortSignal,
    });

    const { messages: rawPrompt, ...rawSettings } = args;
    const choice = response.choices[0];

    return {
      text: choice.message.content ?? undefined,
      toolCalls: choice.message.tool_calls?.map(toolCall => ({
        toolCallType: 'function',
        toolCallId: nanoid(),
        toolName: toolCall.function.name,
        args: toolCall.function.arguments!,
      })),
      finishReason: mapMistralFinishReason(choice.finish_reason),
      usage: {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
      },
      rawCall: { rawPrompt, rawSettings },
      warnings,
    };
  }

  async doStream(
    options: Parameters<LanguageModelV1['doStream']>[0],
  ): Promise<Awaited<ReturnType<LanguageModelV1['doStream']>>> {
    const { args, warnings } = this.getArgs(options);

    const response = await postJsonToApi({
      url: `${this.config.baseUrl}/chat/completions`,
      headers: this.config.headers(),
      body: {
        ...args,
        stream: true,
      },
      failedResponseHandler: mistralFailedResponseHandler,
      successfulResponseHandler: createEventSourceResponseHandler(
        mistralChatChunkSchema,
      ),
      abortSignal: options.abortSignal,
    });

    const { messages: rawPrompt, ...rawSettings } = args;

    return {
      stream: response.pipeThrough(
        new TransformStream<
          ParsedChunk<z.infer<typeof mistralChatChunkSchema>>,
          LanguageModelV1StreamPart
        >({
          transform(chunk, controller) {
            if (chunk.type === 'error') {
              controller.enqueue(chunk);
              return;
            }

            const value = chunk.value;

            if (value.choices?.[0]?.delta == null) {
              return;
            }

            const delta = value.choices[0].delta;

            if (delta.content != null) {
              controller.enqueue({
                type: 'text-delta',
                textDelta: delta.content,
              });
            }

            if (delta.tool_calls != null) {
              for (const toolCall of delta.tool_calls) {
                // mistral tool calls come in one piece

                controller.enqueue({
                  type: 'tool-call-delta',
                  toolCallId: nanoid(),
                  toolName: toolCall.function.name,
                  argsTextDelta: toolCall.function.arguments,
                });

                controller.enqueue({
                  type: 'tool-call',
                  toolCallType: 'function',
                  toolCallId: nanoid(),
                  toolName: toolCall.function.name,
                  args: toolCall.function.arguments,
                });
              }
            }
          },
        }),
      ),
      rawCall: { rawPrompt, rawSettings },
      warnings,
    };
  }
}

// limited version of the schema, focussed on what is needed for the implementation
// this approach limits breakages when the API changes and increases efficiency
const openAIChatResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        role: z.literal('assistant'),
        content: z.string().nullable(),
        tool_calls: z
          .array(
            z.object({
              function: z.object({
                name: z.string(),
                arguments: z.string(),
              }),
            }),
          )
          .optional()
          .nullable(),
      }),
      index: z.number(),
      finish_reason: z.string().optional().nullable(),
    }),
  ),
  object: z.literal('chat.completion'),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
  }),
});

// limited version of the schema, focussed on what is needed for the implementation
// this approach limits breakages when the API changes and increases efficiency
const mistralChatChunkSchema = z.object({
  object: z.literal('chat.completion.chunk'),
  choices: z.array(
    z.object({
      delta: z.object({
        role: z.enum(['assistant']).optional(),
        content: z.string().nullable().optional(),
        tool_calls: z
          .array(
            z.object({
              function: z.object({ name: z.string(), arguments: z.string() }),
            }),
          )
          .optional()
          .nullable(),
      }),
      finish_reason: z.string().nullable().optional(),
      index: z.number(),
    }),
  ),
});
