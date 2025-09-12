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
const WORKSPACE_DIR = path.join(os.homedir(), '.ai-brain-workspace');

if (!connectionString || !openaiApiKey) {
    throw new Error("FATAL: Missing environment variables DATABASE_URL or OPENAI_API_KEY");
}
const openai = new OpenAI({ apiKey: openaiApiKey });
const program = new Command();

// --- HELPER FUNCTIONS ---

/**
 * Retrieves the ID for a project from the database based on its source (Git URL or path).
 * If the project doesn't exist, it creates a new one.
 * @param source The unique Git URL or local path for the project.
 * @param client The active Postgres client.
 * @returns The numeric ID of the project.
 */
async function getProjectId(source: string, client: Client): Promise<number> {
    const projectRes = await client.query('SELECT id FROM projects WHERE source = $1', [source]);
    if (projectRes.rows.length > 0) {
        return projectRes.rows[0].id;
    } else {
        const projectName = path.basename(source, path.extname(source));
        console.log(`✨ Creating new project entry for '${projectName}'...`);
        const newProjectRes = await client.query(
            'INSERT INTO projects (name, source) VALUES ($1, $2) RETURNING id',
            [projectName, source]
        );
        return newProjectRes.rows[0].id;
    }
}

async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.replace(/\n/g, ' '),
  });
  return response.data[0].embedding;
}

function getWorkspacePathFromUrl(url: string): string {
    try {
        const parsedUrl = new URL(url);
        const cleanPath = (parsedUrl.hostname + parsedUrl.pathname).replace(/\.git$/, '');
        return path.join(WORKSPACE_DIR, cleanPath);
    } catch (e) {
        const sshMatch = url.match(/git@([^:]+):(.*)/);
        if (sshMatch) {
            const host = sshMatch[1];
            const repoPath = sshMatch[2].replace(/\.git$/, '');
            return path.join(WORKSPACE_DIR, host, repoPath);
        }
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

    if (source.startsWith('http') || source.startsWith('git@')) {
        projectPath = getWorkspacePathFromUrl(source);
        try {
            await fs.mkdir(WORKSPACE_DIR, { recursive: true });
            try {
                await fs.access(path.join(projectPath, '.git'));
                console.log(`🧠 Found existing repository. Fetching updates from ${source}...`);
                await simpleGit(projectPath).pull();
                console.log(`   -> Updates pulled successfully.`);
            } catch (error) {
                console.log(`🧠 Cloning repository from ${source}...`);
                await simpleGit().clone(source, projectPath);
                console.log(`   -> Cloned successfully into: ${projectPath}`);
            }
        } catch (gitError) {
            console.error('❌ A Git error occurred:', gitError);
            process.exit(1);
        }
    }

    const client = new Client({ connectionString });
    try {
      await client.connect();
      const projectId = await getProjectId(source, client);
      await runIngestion(projectId, projectPath);
      console.log('✅ Ingestion complete.');
    } catch (error) {
      console.error('❌ Ingestion failed:', error);
      process.exit(1);
    } finally {
      await client.end();
    }
  });

program
  .command('ask')
  .description('Ask a question about the indexed codebase.')
  .argument('<question>', 'The question to ask')
  .requiredOption('-p, --project <source>', 'The project source (Git URL or local path)')
  .action(async (question: string, options: { project: string }) => {
    console.log(`🧠 Thinking about: "${question}"`);
    const client = new Client({ connectionString });
    try {
      await client.connect();
      await pgvector.registerType(client);
      const projectId = await getProjectId(options.project, client);

      const questionEmbedding = await getEmbedding(question);

      const { rows: relevantFiles } = await client.query(
        `SELECT id, path, summary FROM indexed_files WHERE project_id = $1 ORDER BY summary_embedding <=> $2 LIMIT 5`,
        [projectId, pgvector.toSql(questionEmbedding)]
      );
      
      if (relevantFiles.length === 0) {
        console.log("I couldn't find any relevant files to answer that question.");
        return;
      }
      
      console.log(`\n🔍 Found relevant files: ${relevantFiles.map(f => f.path).join(', ')}`);
      const relevantFileIds = relevantFiles.map(f => f.id);

      const { rows: contextChunks } = await client.query(
        `SELECT file_id, content, chunk_name FROM code_chunks WHERE file_id = ANY($1::int[]) ORDER BY embedding <=> $2 LIMIT 10`,
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

// --- NEW: TASK MANAGEMENT COMMANDS ---
const task = program.command('task').description('Manage project tasks');

task
  .command('add')
  .description('Add a new task to a project')
  .argument('<title>', 'The title of the task')
  .requiredOption('-p, --project <source>', 'The project source (Git URL or local path)')
  .action(async (title: string, options: { project: string }) => {
    const client = new Client({ connectionString });
    try {
        await client.connect();
        const projectId = await getProjectId(options.project, client);
        const result = await client.query(
            'INSERT INTO tasks (project_id, title) VALUES ($1, $2) RETURNING task_number',
            [projectId, title]
        );
        const taskNumber = result.rows[0].task_number;
        console.log(`✅ Created task #${taskNumber}: "${title}"`);
    } catch (error) {
        console.error('❌ Could not add task:', error);
    } finally {
        await client.end();
    }
  });

task
  .command('list')
  .description('List tasks for a project')
  .requiredOption('-p, --project <source>', 'The project source (Git URL or local path)')
  .option('--status <status>', 'Filter by status (e.g., open, done)', 'open')
  .action(async (options: { project: string, status: string }) => {
    const client = new Client({ connectionString });
    try {
        await client.connect();
        const projectId = await getProjectId(options.project, client);
        const { rows } = await client.query(
            'SELECT task_number, title, status FROM tasks WHERE project_id = $1 AND status = $2 ORDER BY task_number ASC',
            [projectId, options.status]
        );

        if (rows.length === 0) {
            console.log(`No '${options.status}' tasks found for project: ${options.project}`);
            return;
        }

        console.log(`\nTasks for project: ${options.project} [Status: ${options.status}]`);
        console.log('--------------------------------------------------');
        rows.forEach(t => {
            const status = `[${t.status.toUpperCase()}]`.padEnd(7);
            console.log(`#${t.task_number.toString().padEnd(4)} ${status} ${t.title}`);
        });
        console.log('--------------------------------------------------');
    } catch (error) {
        console.error('❌ Could not list tasks:', error);
    } finally {
        await client.end();
    }
  });

program.parse(process.argv);