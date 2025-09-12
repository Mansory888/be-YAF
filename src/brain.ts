#!/usr/bin/env node
// --- FILE: brain.ts ---

import 'dotenv/config';
import { Command } from 'commander';
import { Client } from 'pg';
import pgvector from 'pgvector/pg';
import OpenAI from 'openai';
import { runIngestion } from './scripts/ingest';

// --- CONFIGURATION ---
const connectionString = process.env.DATABASE_URL!;
const openaiApiKey = process.env.OPENAI_API_KEY!;

if (!connectionString || !openaiApiKey) {
    throw new Error("FATAL: Missing environment variables DATABASE_URL or OPENAI_API_KEY");
}
const openai = new OpenAI({ apiKey: openaiApiKey });
const program = new Command();

// --- HELPER FUNCTIONS ---
async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.replace(/\n/g, ' '),
  });
  return response.data[0].embedding;
}

// --- CLI COMMAND DEFINITIONS ---

// The `ingest` command
program
  .command('ingest')
  .description('Ingest and index a project codebase into the brain.')
  .action(async () => {
    try {
      await runIngestion();
      console.log('✅ Ingestion complete.');
    } catch (error) {
      console.error('❌ Ingestion failed:', error);
      process.exit(1);
    }
  });

// The `ask` command
program
  .command('ask')
  .description('Ask a question about the indexed codebase.')
  .argument('<question>', 'The question to ask')
  .action(async (question: string) => {
    console.log(`🧠 Thinking about: "${question}"`);
    const client = new Client({ connectionString });
    try {
      await client.connect();
      await pgvector.registerType(client);

      const questionEmbedding = await getEmbedding(question);

      // CRITICAL: Two-Stage Retrieval
      // Stage 1: Find the most relevant files using summary embeddings.
      const { rows: relevantFiles } = await client.query(
        `SELECT id, path, summary FROM indexed_files ORDER BY summary_embedding <=> $1 LIMIT 5`,
        [pgvector.toSql(questionEmbedding)]
      );
      
      if (relevantFiles.length === 0) {
        console.log("I couldn't find any relevant files to answer that question.");
        return;
      }
      
      console.log(`\n🔍 Found relevant files: ${relevantFiles.map(f => f.path).join(', ')}`);
      const relevantFileIds = relevantFiles.map(f => f.id);

      // Stage 2: Find the most relevant chunks WITHIN those files.
      const { rows: contextChunks } = await client.query(
        `SELECT file_id, content, chunk_name 
         FROM code_chunks 
         WHERE file_id = ANY($1::int[])
         ORDER BY embedding <=> $2 
         LIMIT 10`,
        [relevantFileIds, pgvector.toSql(questionEmbedding)]
      );

      if (contextChunks.length === 0) {
        console.log("I found some relevant files, but couldn't pinpoint specific code snippets to answer your question.");
        return;
      }

      // Synthesize the final answer
      const contextString = contextChunks.map(c => {
        const filePath = relevantFiles.find(f => f.id === c.file_id)?.path;
        return `--- FILE: ${filePath} (Chunk: ${c.chunk_name}) ---\n\n${c.content}`;
      }).join('\n\n');

      const systemPrompt = `You are an expert AI software engineer. Answer the user's question based ONLY on the provided code context. Be concise, accurate, and provide code snippets in Markdown format when relevant. If the context is insufficient, state that clearly.`;
      const userPrompt = `CONTEXT:\n${contextString}\n\nQUESTION:\n${question}`;

      const stream = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        stream: true,
      });
      
      console.log('\n💬 Answer:\n');
      for await (const chunk of stream) {
        process.stdout.write(chunk.choices[0]?.delta?.content || '');
      }
      console.log('\n');

    } catch (error) {
      console.error('❌ An error occurred:', error);
    } finally {
      await client.end();
    }
  });

program.parse(process.argv);