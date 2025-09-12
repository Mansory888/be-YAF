// src/services/openai.ts
import OpenAI from 'openai';

const openaiApiKey = process.env.OPENAI_API_KEY!;
if (!openaiApiKey) {
    throw new Error("FATAL: Missing environment variable OPENAI_API_KEY");
}

const openai = new OpenAI({ apiKey: openaiApiKey });

export async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.replace(/\n/g, ' '),
  });
  return response.data[0].embedding;
}

export async function getChatCompletionStream(systemPrompt: string, userPrompt: string) {
    return openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        stream: true,
    });
}