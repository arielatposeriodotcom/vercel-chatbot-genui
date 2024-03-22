import type OpenAI from 'openai';
import * as React from 'react';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

// TODO: This needs to be externalized.
import { OpenAIStream } from '../streams';

import {
  STREAMABLE_VALUE_TYPE,
  DEV_DEFAULT_STREAMABLE_WARNING_TIME,
} from './constants';
import {
  createResolvablePromise,
  createSuspensedChunk,
  consumeStream,
} from './utils';
import type { StreamablePatch, StreamableValue } from './types';

/**
 * Create a piece of changable UI that can be streamed to the client.
 * On the client side, it can be rendered as a normal React node.
 */
export function createStreamableUI(initialValue?: React.ReactNode) {
  let currentValue = initialValue;
  let closed = false;
  let { row, resolve, reject } = createSuspensedChunk(initialValue);

  function assertStream(method: string) {
    if (closed) {
      throw new Error(method + ': UI stream is already closed.');
    }
  }

  let warningTimeout: NodeJS.Timeout | undefined;
  function warnUnclosedStream() {
    if (process.env.NODE_ENV === 'development') {
      if (warningTimeout) {
        clearTimeout(warningTimeout);
      }
      warningTimeout = setTimeout(() => {
        console.warn(
          'The streamable UI has been slow to update. This may be a bug or a performance issue or you forgot to call `.done()`.',
        );
      }, DEV_DEFAULT_STREAMABLE_WARNING_TIME);
    }
  }
  warnUnclosedStream();

  return {
    /**
     * The value of the streamable UI. This can be returned from a Server Action and received by the client.
     */
    value: row,
    /**
     * This method updates the current UI node. It takes a new UI node and replaces the old one.
     */
    update(value: React.ReactNode) {
      assertStream('.update()');

      // There is no need to update the value if it's referentially equal.
      if (value === currentValue) {
        warnUnclosedStream();
        return;
      }

      const resolvable = createResolvablePromise();
      currentValue = value;

      resolve({ value: currentValue, done: false, next: resolvable.promise });
      resolve = resolvable.resolve;
      reject = resolvable.reject;

      warnUnclosedStream();
    },
    /**
     * This method is used to append a new UI node to the end of the old one.
     * Once appended a new UI node, the previous UI node cannot be updated anymore.
     *
     * @example
     * ```jsx
     * const ui = createStreamableUI(<div>hello</div>)
     * ui.append(<div>world</div>)
     *
     * // The UI node will be:
     * // <>
     * //   <div>hello</div>
     * //   <div>world</div>
     * // </>
     * ```
     */
    append(value: React.ReactNode) {
      assertStream('.append()');

      const resolvable = createResolvablePromise();
      currentValue = value;

      resolve({ value, done: false, append: true, next: resolvable.promise });
      resolve = resolvable.resolve;
      reject = resolvable.reject;

      warnUnclosedStream();
    },
    /**
     * This method is used to signal that there is an error in the UI stream.
     * It will be thrown on the client side and caught by the nearest error boundary component.
     */
    error(error: any) {
      assertStream('.error()');

      if (warningTimeout) {
        clearTimeout(warningTimeout);
      }
      closed = true;
      reject(error);
    },
    /**
     * This method marks the UI node as finalized. You can either call it without any parameters or with a new UI node as the final state.
     * Once called, the UI node cannot be updated or appended anymore.
     *
     * This method is always **required** to be called, otherwise the response will be stuck in a loading state.
     */
    done(...args: [] | [React.ReactNode]) {
      assertStream('.done()');

      if (warningTimeout) {
        clearTimeout(warningTimeout);
      }
      closed = true;
      if (args.length) {
        resolve({ value: args[0], done: true });
        return;
      }
      resolve({ value: currentValue, done: true });
    },
  };
}

/**
 * Create a wrapped, changable value that can be streamed to the client.
 * On the client side, the value can be accessed via the readStreamableValue() API.
 */
export function createStreamableValue<T = any, E = any>(initialValue?: T) {
  let closed = false;
  let resolvable = createResolvablePromise<StreamableValue<T, E>>();

  let currentValue = initialValue;
  let currentError: E | undefined;
  let currentPromise: typeof resolvable.promise | undefined =
    resolvable.promise;
  let currentPatchValue: StreamablePatch;

  function assertStream(method: string) {
    if (closed) {
      throw new Error(method + ': Value stream is already closed.');
    }
  }

  let warningTimeout: NodeJS.Timeout | undefined;
  function warnUnclosedStream() {
    if (process.env.NODE_ENV === 'development') {
      if (warningTimeout) {
        clearTimeout(warningTimeout);
      }
      warningTimeout = setTimeout(() => {
        console.warn(
          'The streamable UI has been slow to update. This may be a bug or a performance issue or you forgot to call `.done()`.',
        );
      }, DEV_DEFAULT_STREAMABLE_WARNING_TIME);
    }
  }
  warnUnclosedStream();

  function createWrapped(initialChunk?: boolean): StreamableValue<T, E> {
    // This makes the payload much smaller if there're mutative updates before the first read.
    let init: Partial<StreamableValue<T, E>>;

    if (currentError !== undefined) {
      init = { error: currentError };
    } else {
      if (currentPatchValue && !initialChunk) {
        init = { diff: currentPatchValue };
      } else {
        init = { curr: currentValue };
      }
    }

    if (currentPromise) {
      init.next = currentPromise;
    }

    if (initialChunk) {
      init.type = STREAMABLE_VALUE_TYPE;
    }

    return init;
  }

  // Update the internal `currentValue` and `currentPatchValue` if needed.
  function updateValueStates(value: T) {
    // If we can only send a patch over the wire, it's better to do so.
    currentPatchValue = undefined;
    if (typeof value === 'string') {
      if (typeof currentValue === 'string') {
        if (value.startsWith(currentValue)) {
          currentPatchValue = [0, value.slice(currentValue.length)];
        }
      }
    }

    currentValue = value;
  }

  return {
    /**
     * The value of the streamable. This can be returned from a Server Action and
     * received by the client. To read the streamed values, use the
     * `readStreamableValue` API.
     */
    get value() {
      return createWrapped(true);
    },
    /**
     * This method updates the current value with a new one.
     */
    update(value: T) {
      assertStream('.update()');

      const resolvePrevious = resolvable.resolve;
      resolvable = createResolvablePromise();

      updateValueStates(value);
      currentPromise = resolvable.promise;
      resolvePrevious(createWrapped());

      warnUnclosedStream();
    },
    error(error: any) {
      assertStream('.error()');

      if (warningTimeout) {
        clearTimeout(warningTimeout);
      }
      closed = true;
      currentError = error;
      currentPromise = undefined;

      resolvable.resolve({ error });
    },
    done(...args: [] | [T]) {
      assertStream('.done()');

      if (warningTimeout) {
        clearTimeout(warningTimeout);
      }
      closed = true;
      currentPromise = undefined;

      if (args.length) {
        updateValueStates(args[0]);
        resolvable.resolve(createWrapped());
        return;
      }

      resolvable.resolve({});
    },
  };
}

type Streamable = React.ReactNode | Promise<React.ReactNode>;

type Renderer<TProps> = (
  props: TProps,
) =>
  | Streamable
  | Generator<Streamable, Streamable, void>
  | AsyncGenerator<Streamable, Streamable, void>;

type StreamableUI = ReturnType<typeof createStreamableUI>;

interface StreamableUIContext {
  ui: StreamableUI;
  finished: Promise<void> | undefined;
}

interface StreamableFunctionUIContext extends StreamableUIContext {
  name: string;
}

interface StreamableToolUIContext extends StreamableUIContext {
  name: string;
  id: string;
}

/**
 * `render` is a helper function to create a streamable UI from some LLMs.
 * Currently, it only supports OpenAI's GPT models with Function Calling and Assistants Tools.
 */
export function render<
  TS extends {
    [name: string]: z.Schema;
  } = {},
  FS extends {
    [name: string]: z.Schema;
  } = {},
>(options: {
  /**
   * The model name to use. Must be OpenAI SDK compatible. Tools and Functions are only supported
   * GPT models (3.5/4), OpenAI Assistants, Mistral small and large, and Fireworks firefunction-v1.
   *
   * @example "gpt-3.5-turbo"
   */
  model: string;
  /**
   * The provider instance to use. Currently the only provider available is OpenAI.
   * This needs to match the model name.
   */
  provider: OpenAI;
  messages: Parameters<
    typeof OpenAI.prototype.chat.completions.create
  >[0]['messages'];
  /**
   * Control how text, function calls, and tool calls are composed into a single UI.
   *
   * Per default, text, function and tool nodes are wrapped in a React Fragment.
   */
  compose?: Renderer<{
    text: React.ReactNode;
    functionCall: { name: keyof FS; node: React.ReactNode } | undefined;
    toolCalls: { name: keyof TS; id: string; node: React.ReactNode }[];
  }>;
  text?: Renderer<{
    /**
     * The full text content from the model so far.
     */
    content: string;
    /**
     * The new appended text content from the model since the last `text` call.
     */
    delta?: string;
    /**
     * Whether the model is done generating text.
     * If `true`, the `content` will be the final output and this call will be the last.
     */
    done: boolean;
  }>;
  tools?: {
    [name in keyof TS]: {
      description?: string;
      parameters: TS[name];
      initial?: React.ReactNode;
      render: Renderer<z.infer<TS[name]>>;
    };
  };
  functions?: {
    [name in keyof FS]: {
      description?: string;
      parameters: FS[name];
      initial?: React.ReactNode;
      render: Renderer<z.infer<FS[name]>>;
    };
  };
  initial?: React.ReactNode;
  temperature?: number;
}): React.ReactNode {
  const composedUIContext: StreamableUIContext = {
    ui: createStreamableUI(options.initial),
    finished: undefined,
  };

  const textUIContext: StreamableUIContext = {
    ui: createStreamableUI(),
    finished: undefined,
  };

  let functionUIContext: StreamableFunctionUIContext | undefined;
  const toolUIContexts: StreamableToolUIContext[] = [];

  // The default text renderer just returns the content as string.
  const text = options.text ?? (({ content }: { content: string }) => content);

  const compose =
    options.compose ??
    (({ text, functionCall, toolCalls }) => (
      <>
        {text}
        {functionCall && functionCall.node}
        {toolCalls.map(({ id, node }) => (
          <React.Fragment key={id}>{node}</React.Fragment>
        ))}
      </>
    ));

  const functions = options.functions
    ? Object.entries(options.functions).map(
        ([name, { description, parameters }]) => {
          return {
            name,
            description,
            parameters: zodToJsonSchema(parameters) as Record<string, unknown>,
          };
        },
      )
    : undefined;

  const tools = options.tools
    ? Object.entries(options.tools).map(
        ([name, { description, parameters }]) => {
          return {
            type: 'function' as const,
            function: {
              name,
              description,
              parameters: zodToJsonSchema(parameters) as Record<
                string,
                unknown
              >,
            },
          };
        },
      )
    : undefined;

  if (functions && tools) {
    throw new Error(
      "You can't have both functions and tools defined. Please choose one or the other.",
    );
  }

  async function handleRender<TProps>(
    args: TProps,
    renderer: Renderer<TProps>,
    context: StreamableUIContext,
  ) {
    if (!renderer) return;

    const resolvable = createResolvablePromise<void>();

    if (context.finished) {
      context.finished = context.finished.then(() => resolvable.promise);
    } else {
      context.finished = resolvable.promise;
    }

    const value = renderer(args);
    if (
      value instanceof Promise ||
      (value &&
        typeof value === 'object' &&
        'then' in value &&
        typeof value.then === 'function')
    ) {
      const node = await (value as Promise<React.ReactNode>);
      context.ui.update(node);
      resolvable.resolve(void 0);
    } else if (
      value &&
      typeof value === 'object' &&
      Symbol.asyncIterator in value
    ) {
      const it = value as AsyncGenerator<
        React.ReactNode,
        React.ReactNode,
        void
      >;
      while (true) {
        const { done, value } = await it.next();
        context.ui.update(value);
        if (done) break;
      }
      resolvable.resolve(void 0);
    } else if (value && typeof value === 'object' && Symbol.iterator in value) {
      const it = value as Generator<React.ReactNode, React.ReactNode, void>;
      while (true) {
        const { done, value } = it.next();
        context.ui.update(value);
        if (done) break;
      }
      resolvable.resolve(void 0);
    } else {
      context.ui.update(value);
      resolvable.resolve(void 0);
    }
  }

  function updateComposedUI() {
    handleRender(
      {
        text: textUIContext.ui.value,
        functionCall: functionUIContext
          ? {
              name: functionUIContext.name,
              node: functionUIContext.ui.value,
            }
          : undefined,
        toolCalls: toolUIContexts.map(toolUIContexts => ({
          name: toolUIContexts.name,
          id: toolUIContexts.id,
          node: toolUIContexts.ui.value,
        })),
      },
      compose,
      composedUIContext,
    );
  }

  (async () => {
    let content = '';

    consumeStream(
      OpenAIStream(
        await options.provider.chat.completions.create({
          model: options.model,
          messages: options.messages,
          temperature: options.temperature,
          stream: true,
          ...(functions ? { functions } : {}),
          ...(tools ? { tools } : {}),
        }),
        {
          ...(functions
            ? {
                async experimental_onFunctionCall(functionCallPayload) {
                  const functionConfig =
                    options.functions?.[functionCallPayload.name];

                  if (functionConfig) {
                    functionUIContext = {
                      name: functionCallPayload.name,
                      ui: createStreamableUI(functionConfig.initial),
                      finished: undefined,
                    };

                    handleRender(
                      functionCallPayload.arguments,
                      functionConfig.render,
                      functionUIContext,
                    );

                    updateComposedUI();
                  }
                },
              }
            : {}),
          ...(tools
            ? {
                async experimental_onToolCall(toolCallPayload) {
                  for (const tool of toolCallPayload.tools) {
                    const toolConfig = options.tools?.[tool.func.name];

                    if (toolConfig) {
                      const toolUIContext: StreamableToolUIContext = {
                        name: tool.func.name,
                        id: tool.id,
                        ui: createStreamableUI(toolConfig.initial),
                        finished: undefined,
                      };

                      toolUIContexts.push(toolUIContext);

                      handleRender(
                        tool.func.arguments,
                        toolConfig.render,
                        toolUIContext,
                      );

                      updateComposedUI();
                    }
                  }
                },
              }
            : {}),
          onText(chunk) {
            content += chunk;

            handleRender(
              { content, done: false, delta: chunk },
              text,
              textUIContext,
            );

            // Update the composed UI when receiving the first text chunk. Until
            // then, then initial UI is used.
            if (content === chunk) {
              updateComposedUI();
            }
          },
          async onFinal() {
            handleRender({ content, done: true }, text, textUIContext);

            const contexts = [
              composedUIContext,
              textUIContext,
              ...(functionUIContext ? [functionUIContext] : []),
              ...toolUIContexts,
            ];

            await Promise.all(
              contexts.map(async ({ ui, finished }) => {
                await finished;
                ui.done();
              }),
            );
          },
        },
      ),
    );
  })();

  return composedUIContext.ui.value;
}
