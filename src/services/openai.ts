// src/services/openai.ts
import OpenAI from 'openai';

const openaiApiKey = process.env.OPENAI_API_KEY!;
if (!openaiApiKey) {
    throw new Error("FATAL: Missing environment variable OPENAI_API_KEY");
}

const openai = new OpenAI({ apiKey: openaiApiKey });

// NEW: Define a reusable type for chat messages
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}


export async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.replace(/\n/g, ' '),
  });
  return response.data[0].embedding;
}

// MODIFIED: This function now accepts a flexible array of messages
export async function getChatCompletionStream(messages: ChatMessage[]) {
    return openai.chat.completions.create({
        model: 'gpt-4o',
        messages: messages,
        stream: true,
    });
}

// NEW: A non-streaming version for tasks like summarization.
export async function getChatCompletion(messages: ChatMessage[]): Promise<string | null> {
    const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: messages,
    });
    return response.choices[0].message.content;
}