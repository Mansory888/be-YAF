#!/usr/bin/env node
// --- FILE: brain.ts ---

import 'dotenv/config';
import { Command } from 'commander';
import { Client } from 'pg';
import pgvector from 'pgvector/pg';
import OpenAI from 'openai';
import { runIngestion } from './scripts/ingest';
import simpleGit, { SimpleGit } from 'simple-git';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// --- CONFIGURATION ---
const connectionString = process.env.DATABASE_URL!;
const openaiApiKey = process.env.OPENAI_API_KEY!;
// NEW: Define a persistent workspace directory in the user's home folder
const WORKSPACE_DIR = path.join(os.homedir(), '.ai-brain-workspace');

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

/**
 * Creates a stable, filesystem-safe directory path from a Git URL.
 * This ensures the same URL always maps to the same local folder.
 * e.g., https://github.com/foo/bar.git -> ~/.ai-brain-workspace/github.com/foo/bar
 */
function getWorkspacePathFromUrl(url: string): string {
    try {
        const parsedUrl = new URL(url);
        // a.com/b/c.git -> a.com/b/c
        const cleanPath = (parsedUrl.hostname + parsedUrl.pathname).replace(/\.git$/, '');
        return path.join(WORKSPACE_DIR, cleanPath);
    } catch (e) {
        // Handle SSH URLs like git@github.com:foo/bar.git
        const sshMatch = url.match(/git@([^:]+):(.*)/);
        if (sshMatch) {
            const host = sshMatch[1];
            const repoPath = sshMatch[2].replace(/\.git$/, '');
            return path.join(WORKSPACE_DIR, host, repoPath);
        }
        // Fallback for other formats by replacing non-alphanumeric chars
        return path.join(WORKSPACE_DIR, url.replace(/[^a-zA-Z0-9]/g, '_'));
    }
}

// --- CLI COMMAND DEFINITIONS ---

program
  .command('ingest')
  .description('Ingest a project from a local path or a public Git URL.')
  .argument('<source>', 'The local path or Git URL of the project')
  .action(async (source: string) => {
    let projectPath = source;

    // If the source is a URL, manage it in the persistent workspace
    if (source.startsWith('http') || source.startsWith('git@')) {
        projectPath = getWorkspacePathFromUrl(source);
        
        try {
            // Ensure the base workspace directory exists
            await fs.mkdir(WORKSPACE_DIR, { recursive: true });

            // Check if the repo has already been cloned
            try {
                await fs.access(path.join(projectPath, '.git')); // Check for .git dir
                // It exists, so pull the latest changes
                console.log(`🧠 Found existing repository. Fetching updates from ${source}...`);
                const git: SimpleGit = simpleGit(projectPath);
                await git.pull();
                console.log(`   -> Updates pulled successfully.`);
            } catch (error) {
                // It doesn't exist, so clone it
                console.log(`🧠 Cloning repository from ${source}...`);
                await simpleGit().clone(source, projectPath);
                console.log(`   -> Cloned successfully into: ${projectPath}`);
            }
        } catch (gitError) {
            console.error('❌ A Git error occurred:', gitError);
            process.exit(1);
        }
    }

    try {
      await runIngestion(projectPath);
      console.log('✅ Ingestion complete.');
    } catch (error) {
      console.error('❌ Ingestion failed:', error);
      process.exit(1);
    }
  });

// The `ask` command (remains unchanged)
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