import 'dotenv/config';
import express from 'express';
import path from 'path';
import { Client } from 'pg';
import OpenAI from 'openai';
import pgvector from 'pgvector/pg'; // ✅ correct import

// --- CONFIGURATION & VALIDATION ---
const app = express();
const port = 3000;
const connectionString = process.env.DATABASE_URL!;
const openaiApiKey = process.env.OPENAI_API_KEY!;

if (!connectionString || !openaiApiKey) {
    throw new Error("FATAL: Missing environment variables DATABASE_URL or OPENAI_API_KEY");
}
const openai = new OpenAI({ apiKey: openaiApiKey });

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// --- HELPER FUNCTION ---
async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.replace(/\n/g, ' '),
  });
  return response.data[0].embedding;
}

// --- API ENDPOINT ---
app.post('/api/ask', async (req, res) => {
    const { question } = req.body;
    if (!question) {
        return res.status(400).json({ error: 'Question is required.' });
    }
    console.log(`Received question: ${question}`);

    const client = new Client({ connectionString });
    try {
        await client.connect();

        // ✅ REGISTER THE VECTOR TYPE FOR THE QUERY
        await pgvector.registerType(client);
        
        const questionEmbedding = await getEmbedding(question);

        console.log('Querying for similar chunks...');
        const { rows: contextChunks } = await client.query(
            `SELECT file_path, content, embedding <=> $1 AS distance
             FROM code_chunks
             ORDER BY distance
             LIMIT 10`,
            [pgvector.toSql(questionEmbedding)] // ✅ USE THE HELPER TO FORMAT THE VECTOR
        );
        
        console.log(`Found ${contextChunks.length} relevant chunks.`);
        if (contextChunks.length > 0) {
            console.log('Top result distance:', contextChunks[0].distance);
        }

        if (contextChunks.length === 0) {
            return res.json({ answer: "I couldn't find any relevant context in the codebase to answer that." });
        }

        const contextString = contextChunks.map(c => `--- FILE: ${c.file_path} ---\n\n${c.content}`).join('\n\n');
        const systemPrompt = `You are an expert AI software engineer. Answer the user's question based ONLY on the provided code context. Be concise and accurate. Format code blocks using Markdown. If the context is insufficient, say so.`;
        const userPrompt = `CONTEXT:\n${contextString}\n\nQUESTION:\n${question}`;

        const stream = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            stream: true,
        });

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        for await (const chunk of stream) {
            res.write(chunk.choices[0]?.delta?.content || '');
        }
        res.end();
    } catch (error) {
        console.error('Error in /api/ask:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    } finally {
        // Ensure the client is always closed
        if (client) {
            await client.end();
        }
    }
});

// --- START SERVER ---
app.listen(port, () => {
    console.log(`🧠 AI Project Brain is listening at http://localhost:${port}`);
});