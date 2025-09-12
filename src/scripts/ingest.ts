// --- FILE: scripts/ingest.ts ---

import 'dotenv/config';
import { glob } from 'glob';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Client } from 'pg';
import OpenAI from 'openai';
import gitignore from 'gitignore-parser';
import pgvector from 'pgvector/pg';
import { chunkCodeWithAST } from '../core/chunker'; // UPDATED to new chunker

// --- CONFIGURATION ---
const PROJECT_PATH = process.env.PROJECT_TO_INDEX!;
const connectionString = process.env.DATABASE_URL!;
const openaiApiKey = process.env.OPENAI_API_KEY!;

if (!PROJECT_PATH || !connectionString || !openaiApiKey) {
  throw new Error('FATAL: Missing environment variables PROJECT_TO_INDEX, DATABASE_URL, or OPENAI_API_KEY');
}

const openai = new OpenAI({ apiKey: openaiApiKey });
const IGNORED_EXTENSIONS = new Set(['.lock', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico']);
const IGNORED_FILENAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

// --- CORE HELPER FUNCTIONS ---
async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.replace(/\n/g, ' '),
  });
  return response.data[0].embedding;
}

// NEW: Summarization Function
async function summarizeFile(filePath: string, content: string): Promise<string> {
    const prompt = `You are an expert software architect. Summarize the purpose and core responsibility of the following code file in one or two sentences. Focus on the high-level role of the file, not the specifics of each function.
    
    File Path: ${filePath}
    
    Code:
    ---
    ${content}
    ---
    
    One-sentence summary:`;
    
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 100,
            temperature: 0.1,
        });
        return response.choices[0].message.content?.trim() || "Could not generate a summary.";
    } catch (error) {
        console.error(`  - Failed to summarize ${filePath}:`, error);
        return "Summary generation failed.";
    }
}


// --- MAIN INGESTION LOGIC ---
export async function runIngestion() {
  console.log(`[1/4] Starting ingestion for project: ${PROJECT_PATH}`);
  const client = new Client({ connectionString });
  await client.connect();
  await pgvector.registerType(client);

  try {
    const gitignorePath = path.join(PROJECT_PATH, '.gitignore');
    const ignore = fs.existsSync(gitignorePath)
      ? gitignore.compile(fs.readFileSync(gitignorePath, 'utf8'))
      : { accepts: (_p: string) => true };

    const allFiles = await glob('**/*', { cwd: PROJECT_PATH, nodir: true, dot: true, ignore: ['**/node_modules/**', '**/.git/**'] });
    const filesToIndex = allFiles.filter(file => {
      const ext = path.extname(file);
      const filename = path.basename(file);
      return ignore.accepts(file) && !IGNORED_EXTENSIONS.has(ext) && !IGNORED_FILENAMES.has(filename);
    });

    console.log(`[2/4] Found ${filesToIndex.length} files to process.`);
    let processedCount = 0;

    for (const relativePath of filesToIndex) {
      const fullPath = path.join(PROJECT_PATH, relativePath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (!content.trim()) continue;

      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const { rows } = await client.query('SELECT content_hash FROM indexed_files WHERE path = $1', [relativePath]);

      if (rows.length > 0 && rows[0].content_hash === hash) {
        continue; // Skip unchanged files
      }

      processedCount++;
      console.log(`      Processing changed file: ${relativePath}`);

      await client.query('BEGIN');
      try {
        // Clear old data for this file
        await client.query('DELETE FROM indexed_files WHERE path = $1', [relativePath]);

        // NEW: Summarize and embed summary
        console.log(`        - Summarizing file...`);
        const summary = await summarizeFile(relativePath, content);
        const summaryEmbedding = await getEmbedding(summary);

        // Insert file record and get its new ID
        const fileInsertResult = await client.query(
          'INSERT INTO indexed_files (path, content_hash, summary, summary_embedding, last_indexed_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id',
          [relativePath, hash, summary, pgvector.toSql(summaryEmbedding)]
        );
        const fileId = fileInsertResult.rows[0].id;
        
        // UPDATED: Use the new AST-based chunker
        const chunks = chunkCodeWithAST(content);
        console.log(`        - Found ${chunks.length} semantic chunks.`);

        // Embed and insert each chunk
        for (const chunk of chunks) {
          const chunkEmbedding = await getEmbedding(chunk.content);
          await client.query(
            `INSERT INTO code_chunks (file_id, chunk_name, chunk_type, content, start_line, end_line, embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              fileId,
              chunk.metadata.name,
              chunk.metadata.type,
              chunk.content,
              chunk.metadata.start_line,
              chunk.metadata.end_line,
              pgvector.toSql(chunkEmbedding),
            ]
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`      Failed to process ${relativePath}:`, error);
      }
    }
    console.log(`[3/4] Processed ${processedCount} new or changed files.`);
  } finally {
    console.log('[4/4] Ingestion complete.');
    await client.end();
  }
}