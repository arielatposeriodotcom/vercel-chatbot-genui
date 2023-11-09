export type AssistantStatus = {
  status: 'in_progress' | 'complete' | 'failed';
  information?: string;
};

export type AssistantMessage = {
  id: string;
  role: 'assistant';
  content: Array<{
    type: 'text';
    text: {
      value: string;
    };
  }>;
};

export function AssistantResponse(
  process: (stream: {
    sendStatus: (status: AssistantStatus) => void;
    sendThreadId: (threadId: string) => void;
    sendMessage: (message: AssistantMessage) => void;
  }) => Promise<void>,
): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const textEncoder = new TextEncoder();

      await process({
        // TODO send custom data

        sendStatus: (status: AssistantStatus) => {
          controller.enqueue(
            textEncoder.encode(`3: ${JSON.stringify(status)}\n\n`),
          );
        },

        sendThreadId: (threadId: string) => {
          controller.enqueue(
            textEncoder.encode(`4: ${JSON.stringify(threadId)}\n\n`),
          );
        },

        sendMessage: (message: AssistantMessage) => {
          // TODO have a smarter streaming protocol that only sends delta + msg id
          controller.enqueue(
            textEncoder.encode(`0: ${JSON.stringify(message)}\n\n`),
          );
        },
      });

      controller.close();
    },
    pull(controller) {},
    cancel() {
      // This is called if the reader cancels,
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
