# Vercel AI SDK - Google Vertex AI Provider

The Google provider for the [Vercel AI SDK](https://sdk.vercel.ai/docs) contains language model support for the [Google Vertex AI](https://cloud.google.com/vertex-ai) APIs.
It creates language model objects that can be used with the `generateText` and `streamText` AI functions.
Tool calls are currently not supported.

## Setup

The Google provider is available in the `@ai-sdk/google-vertex` module. You can install it with

```bash
npm i @ai-sdk/google-vertex
```

## Provider Instance

You can import the default provider instance `vertex` from `@ai-sdk/google-vertex`:

```ts
import { vertex } from '@ai-sdk/google-vertex';
```

If you need a customized setup, you can import `createVertex` from `@ai-sdk/google-vertex` and create a provider instance with your settings:

```ts
import { createVertex } from '@ai-sdk/google-vertex';

const vertex = createVertex({
  // custom settings
});
```
