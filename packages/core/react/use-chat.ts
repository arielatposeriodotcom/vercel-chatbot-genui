import { useCallback, useEffect, useId, useRef, useState } from 'react';
import useSWR, { KeyedMutator } from 'swr';
import { callChatApi } from '../shared/call-chat-api';
import { generateId as generateIdFunc } from '../shared/generate-id';
import { processChatStream } from '../shared/process-chat-stream';
import type {
  ChatRequest,
  ChatRequestOptions,
  CreateMessage,
  IdGenerator,
  JSONValue,
  Message,
  UseChatOptions,
} from '../shared/types';
import type {
  ReactResponseRow,
  experimental_StreamingReactResponse,
} from '../streams/streaming-react-response';

export type { CreateMessage, Message, UseChatOptions };

export type UseChatHelpers = {
  /** Current messages in the chat */
  messages: Message[];
  /** The error object of the API request */
  error: undefined | Error;
  /**
   * Append a user message to the chat list. This triggers the API call to fetch
   * the assistant's response.
   * @param message The message to append
   * @param options Additional options to pass to the API call
   */
  append: (
    message: Message | CreateMessage,
    chatRequestOptions?: ChatRequestOptions,
  ) => Promise<string | null | undefined>;
  /**
   * Reload the last AI chat response for the given chat history. If the last
   * message isn't from the assistant, it will request the API to generate a
   * new response.
   */
  reload: (
    chatRequestOptions?: ChatRequestOptions,
  ) => Promise<string | null | undefined>;
  /**
   * Abort the current request immediately, keep the generated tokens if any.
   */
  stop: () => void;
  /**
   * Update the `messages` state locally. This is useful when you want to
   * edit the messages on the client, and then trigger the `reload` method
   * manually to regenerate the AI response.
   */
  setMessages: (messages: Message[]) => void;
  /** The current value of the input */
  input: string;
  /** setState-powered method to update the input value */
  setInput: React.Dispatch<React.SetStateAction<string>>;
  /** An input/textarea-ready onChange handler to control the value of the input */
  handleInputChange: (
    e:
      | React.ChangeEvent<HTMLInputElement>
      | React.ChangeEvent<HTMLTextAreaElement>,
  ) => void;
  /** Form submission handler to automatically reset input and append a user message */
  handleSubmit: (
    e: React.FormEvent<HTMLFormElement>,
    chatRequestOptions?: ChatRequestOptions,
    metadata?: Object,
  ) => void;
  metadata?: Object;
  /** Whether the API request is in progress */
  isLoading: boolean;
  /** Additional data added on the server via StreamData */
  data?: JSONValue[];
};

/**
@deprecated Use AI SDK RSC instead: https://sdk.vercel.ai/docs/ai-sdk-rsc
 */
type StreamingReactResponseAction = (payload: {
  messages: Message[];
  data?: Record<string, string>;
}) => Promise<experimental_StreamingReactResponse>;

const getStreamedResponse = async (
  api: string | StreamingReactResponseAction,
  chatRequest: ChatRequest,
  mutate: KeyedMutator<Message[]>,
  mutateStreamData: KeyedMutator<JSONValue[] | undefined>,
  existingData: JSONValue[] | undefined,
  extraMetadataRef: React.MutableRefObject<any>,
  messagesRef: React.MutableRefObject<Message[]>,
  abortControllerRef: React.MutableRefObject<AbortController | null>,
  generateId: IdGenerator,
  streamMode?: 'stream-data' | 'text',
  onFinish?: (message: Message) => void,
  onResponse?: (response: Response) => void | Promise<void>,
  sendExtraMessageFields?: boolean,
) => {
  // Do an optimistic update to the chat state to show the updated messages
  // immediately.
  const previousMessages = messagesRef.current;
  mutate(chatRequest.messages, false);

  const constructedMessagesPayload = sendExtraMessageFields
    ? chatRequest.messages
    : chatRequest.messages.map(
        ({
          role,
          content,
          name,
          toolInvocations,
          function_call,
          tool_calls,
          tool_call_id,
        }) => ({
          role,
          content,
          ...(name !== undefined && { name }),
          ...(toolInvocations !== undefined && { toolInvocations }),
          // outdated function/tool call handling (TODO deprecate):
          tool_call_id,
          ...(function_call !== undefined && { function_call }),
          ...(tool_calls !== undefined && { tool_calls }),
        }),
      );

  // TODO deprecated, remove in next major release
  if (typeof api !== 'string') {
    // In this case, we are handling a Server Action. No complex mode handling needed.

    const replyId = generateId();
    const createdAt = new Date();
    let responseMessage: Message = {
      id: replyId,
      createdAt,
      content: '',
      role: 'assistant',
    };

    async function readRow(promise: Promise<ReactResponseRow>) {
      const { content, ui, next } = await promise;

      // TODO: Handle function calls.
      responseMessage['content'] = content;
      responseMessage['ui'] = await ui;

      mutate([...chatRequest.messages, { ...responseMessage }], false);

      if (next) {
        await readRow(next);
      }
    }

    try {
      const promise = api({
        messages: constructedMessagesPayload as Message[],
        data: chatRequest.data,
      }) as Promise<ReactResponseRow>;
      await readRow(promise);
    } catch (e) {
      // Restore the previous messages if the request fails.
      mutate(previousMessages, false);
      throw e;
    }

    if (onFinish) {
      onFinish(responseMessage);
    }

    return responseMessage;
  }

  return await callChatApi({
    api,
    messages: constructedMessagesPayload,
    body: {
      data: chatRequest.data,
      ...extraMetadataRef.current.body,
      ...chatRequest.options?.body,
      ...(chatRequest.functions !== undefined && {
        functions: chatRequest.functions,
      }),
      ...(chatRequest.function_call !== undefined && {
        function_call: chatRequest.function_call,
      }),
      ...(chatRequest.tools !== undefined && {
        tools: chatRequest.tools,
      }),
      ...(chatRequest.tool_choice !== undefined && {
        tool_choice: chatRequest.tool_choice,
      }),
    },
    streamMode,
    credentials: extraMetadataRef.current.credentials,
    headers: {
      ...extraMetadataRef.current.headers,
      ...chatRequest.options?.headers,
    },
    abortController: () => abortControllerRef.current,
    restoreMessagesOnFailure() {
      mutate(previousMessages, false);
    },
    onResponse,
    onUpdate(merged, data) {
      mutate([...chatRequest.messages, ...merged], false);
      mutateStreamData([...(existingData || []), ...(data || [])], false);
    },
    onFinish,
    generateId,
  });
};

export function useChat({
  api = '/api/chat',
  id,
  initialMessages,
  initialInput = '',
  sendExtraMessageFields,
  experimental_onFunctionCall,
  experimental_onToolCall,
  experimental_maxAutomaticRoundtrips = 0,
  streamMode,
  onResponse,
  onFinish,
  onError,
  credentials,
  headers,
  body,
  generateId = generateIdFunc,
}: Omit<UseChatOptions, 'api'> & {
  api?: string | StreamingReactResponseAction;
  key?: string;
  /**
Maximal number of automatic roundtrips for tool calls.

An automatic tool call roundtrip is a call to the server with the 
tool call results when all tool calls in the last assistant 
message have results.

A maximum number is required to prevent infinite loops in the
case of misconfigured tools.

By default, it's set to 0, which will disable the feature.
   */
  experimental_maxAutomaticRoundtrips?: number;
} = {}): UseChatHelpers & {
  experimental_addToolResult: ({
    toolCallId,
    result,
  }: {
    toolCallId: string;
    result: any;
  }) => void;
} {
  // Generate a unique id for the chat if not provided.
  const hookId = useId();
  const idKey = id ?? hookId;
  const chatKey = typeof api === 'string' ? [api, idKey] : idKey;

  // Store a empty array as the initial messages
  // (instead of using a default parameter value that gets re-created each time)
  // to avoid re-renders:
  const [initialMessagesFallback] = useState([]);

  // Store the chat state in SWR, using the chatId as the key to share states.
  const { data: messages, mutate } = useSWR<Message[]>(
    [chatKey, 'messages'],
    null,
    { fallbackData: initialMessages ?? initialMessagesFallback },
  );

  // We store loading state in another hook to sync loading states across hook invocations
  const { data: isLoading = false, mutate: mutateLoading } = useSWR<boolean>(
    [chatKey, 'loading'],
    null,
  );

  const { data: streamData, mutate: mutateStreamData } = useSWR<
    JSONValue[] | undefined
  >([chatKey, 'streamData'], null);

  const { data: error = undefined, mutate: setError } = useSWR<
    undefined | Error
  >([chatKey, 'error'], null);

  // Keep the latest messages in a ref.
  const messagesRef = useRef<Message[]>(messages || []);
  useEffect(() => {
    messagesRef.current = messages || [];
  }, [messages]);

  // Abort controller to cancel the current API call.
  const abortControllerRef = useRef<AbortController | null>(null);

  const extraMetadataRef = useRef({
    credentials,
    headers,
    body,
  });

  useEffect(() => {
    extraMetadataRef.current = {
      credentials,
      headers,
      body,
    };
  }, [credentials, headers, body]);

  const triggerRequest = useCallback(
    async (chatRequest: ChatRequest) => {
      try {
        mutateLoading(true);
        setError(undefined);

        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        await processChatStream({
          getStreamedResponse: () =>
            getStreamedResponse(
              api,
              chatRequest,
              mutate,
              mutateStreamData,
              streamData!,
              extraMetadataRef,
              messagesRef,
              abortControllerRef,
              generateId,
              streamMode,
              onFinish,
              onResponse,
              sendExtraMessageFields,
            ),
          experimental_onFunctionCall,
          experimental_onToolCall,
          updateChatRequest: chatRequestParam => {
            chatRequest = chatRequestParam;
          },
          getCurrentMessages: () => messagesRef.current,
        });

        abortControllerRef.current = null;
      } catch (err) {
        // Ignore abort errors as they are expected.
        if ((err as any).name === 'AbortError') {
          abortControllerRef.current = null;
          return null;
        }

        if (onError && err instanceof Error) {
          onError(err);
        }

        setError(err as Error);
      } finally {
        mutateLoading(false);
      }

      // auto-submit when all tool calls in the last assistant message have results:
      const messages = messagesRef.current;
      const lastMessage = messages[messages.length - 1];
      if (
        // ensure there is a last message:
        lastMessage != null &&
        // check if the feature is enabled:
        experimental_maxAutomaticRoundtrips > 0 &&
        // check that roundtrip is possible:
        isAssistantMessageWithCompletedToolCalls(lastMessage) &&
        // limit the number of automatic roundtrips:
        countTrailingAssistantMessages(messages) <=
          experimental_maxAutomaticRoundtrips
      ) {
        await triggerRequest({ messages });
      }
    },
    [
      mutate,
      mutateLoading,
      api,
      extraMetadataRef,
      onResponse,
      onFinish,
      onError,
      setError,
      mutateStreamData,
      streamData,
      streamMode,
      sendExtraMessageFields,
      experimental_onFunctionCall,
      experimental_onToolCall,
      experimental_maxAutomaticRoundtrips,
      messagesRef,
      abortControllerRef,
      generateId,
    ],
  );

  const append = useCallback(
    async (
      message: Message | CreateMessage,
      {
        options,
        functions,
        function_call,
        tools,
        tool_choice,
        data,
      }: ChatRequestOptions = {},
    ) => {
      if (!message.id) {
        message.id = generateId();
      }

      const chatRequest: ChatRequest = {
        messages: messagesRef.current.concat(message as Message),
        options,
        data,
        ...(functions !== undefined && { functions }),
        ...(function_call !== undefined && { function_call }),
        ...(tools !== undefined && { tools }),
        ...(tool_choice !== undefined && { tool_choice }),
      };

      return triggerRequest(chatRequest);
    },
    [triggerRequest, generateId],
  );

  const reload = useCallback(
    async ({
      options,
      functions,
      function_call,
      tools,
      tool_choice,
    }: ChatRequestOptions = {}) => {
      if (messagesRef.current.length === 0) return null;

      // Remove last assistant message and retry last user message.
      const lastMessage = messagesRef.current[messagesRef.current.length - 1];
      if (lastMessage.role === 'assistant') {
        const chatRequest: ChatRequest = {
          messages: messagesRef.current.slice(0, -1),
          options,
          ...(functions !== undefined && { functions }),
          ...(function_call !== undefined && { function_call }),
          ...(tools !== undefined && { tools }),
          ...(tool_choice !== undefined && { tool_choice }),
        };

        return triggerRequest(chatRequest);
      }

      const chatRequest: ChatRequest = {
        messages: messagesRef.current,
        options,
        ...(functions !== undefined && { functions }),
        ...(function_call !== undefined && { function_call }),
        ...(tools !== undefined && { tools }),
        ...(tool_choice !== undefined && { tool_choice }),
      };

      return triggerRequest(chatRequest);
    },
    [triggerRequest],
  );

  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const setMessages = useCallback(
    (messages: Message[]) => {
      mutate(messages, false);
      messagesRef.current = messages;
    },
    [mutate],
  );

  // Input state and handlers.
  const [input, setInput] = useState(initialInput);

  const handleSubmit = useCallback(
    (
      e: React.FormEvent<HTMLFormElement>,
      options: ChatRequestOptions = {},
      metadata?: Object,
    ) => {
      if (metadata) {
        extraMetadataRef.current = {
          ...extraMetadataRef.current,
          ...metadata,
        };
      }

      e.preventDefault();
      if (!input) return;

      append(
        {
          content: input,
          role: 'user',
          createdAt: new Date(),
        },
        options,
      );
      setInput('');
    },
    [input, append],
  );

  const handleInputChange = (e: any) => {
    setInput(e.target.value);
  };

  return {
    messages: messages || [],
    error,
    append,
    reload,
    stop,
    setMessages,
    input,
    setInput,
    handleInputChange,
    handleSubmit,
    isLoading,
    data: streamData,
    experimental_addToolResult: ({
      toolCallId,
      result,
    }: {
      toolCallId: string;
      result: any;
    }) => {
      const updatedMessages = messagesRef.current.map((message, index, arr) =>
        // update the tool calls in the last assistant message:
        index === arr.length - 1 &&
        message.role === 'assistant' &&
        message.toolInvocations
          ? {
              ...message,
              toolInvocations: message.toolInvocations.map(toolInvocation =>
                toolInvocation.toolCallId === toolCallId
                  ? { ...toolInvocation, result }
                  : toolInvocation,
              ),
            }
          : message,
      );

      mutate(updatedMessages, false);

      // auto-submit when all tool calls in the last assistant message have results:
      const lastMessage = updatedMessages[updatedMessages.length - 1];
      if (isAssistantMessageWithCompletedToolCalls(lastMessage)) {
        triggerRequest({ messages: updatedMessages });
      }
    },
  };
}

/**
Check if the message is an assistant message with completed tool calls. 
The message must have at least one tool invocation and all tool invocations
must have a result.
 */
function isAssistantMessageWithCompletedToolCalls(message: Message) {
  return (
    message.role === 'assistant' &&
    message.toolInvocations &&
    message.toolInvocations.length > 0 &&
    message.toolInvocations.every(toolInvocation => 'result' in toolInvocation)
  );
}

/**
Returns the number of trailing assistant messages in the array.
 */
function countTrailingAssistantMessages(messages: Message[]) {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      count++;
    } else {
      break;
    }
  }
  return count;
}
