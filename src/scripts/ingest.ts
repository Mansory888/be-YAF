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
import { chunkCodeWithAST } from '../core/chunker';
import simpleGit, { SimpleGit } from 'simple-git';

// --- CONFIGURATION (Global) ---
const connectionString = process.env.DATABASE_URL!;
const openaiApiKey = process.env.OPENAI_API_KEY!;

if (!connectionString || !openaiApiKey) {
  throw new Error('FATAL: Missing environment variables DATABASE_URL or OPENAI_API_KEY');
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

async function summarizeFile(filePath: string, content: string): Promise<string> {
  const prompt = `Summarize the purpose of the following code file in one sentence. File Path: ${filePath}\n\nCode:\n---\n${content}\n---\n\nOne-sentence summary:`;
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
export async function runIngestion(projectId: number, projectPath: string) {
  const client = new Client({ connectionString });
  await client.connect();
  await pgvector.registerType(client);
  console.log('Database connection established.');

  const git: SimpleGit = simpleGit(projectPath);

  try {
    await syncFiles(client, projectId, projectPath);
    await syncGitHistory(client, projectId, git);
  } finally {
    console.log('Ingestion process finished. Closing database connection.');
    await client.end();
  }
}

// --- STAGE 1: Sync Filesystem State ---
async function syncFiles(client: Client, projectId: number, projectPath: string) {
  console.log(`[1/4] Starting file sync for project ID: ${projectId}`);
  
  console.log(`[2/4] Pruning deleted files from the database...`);
  const { rows: dbFiles } = await client.query('SELECT path FROM indexed_files WHERE project_id = $1', [projectId]);
  const dbPaths = new Set(dbFiles.map(f => f.path));
  
  const allDiskFiles = await glob('**/*', { cwd: projectPath, nodir: true, dot: true, ignore: ['**/node_modules/**', '**/.git/**'] });
  const diskPaths = new Set(allDiskFiles);

  const pathsToDelete = [...dbPaths].filter(p => !diskPaths.has(p));

  if (pathsToDelete.length > 0) {
    console.log(`      Found ${pathsToDelete.length} files to delete.`);
    await client.query('DELETE FROM indexed_files WHERE project_id = $1 AND path = ANY($2::text[])', [projectId, pathsToDelete]);
    console.log(`      -> Pruning complete.`);
  } else {
    console.log(`      -> No files to prune.`);
  }

  const gitignorePath = path.join(projectPath, '.gitignore');
  const ignore = fs.existsSync(gitignorePath)
    ? gitignore.compile(fs.readFileSync(gitignorePath, 'utf8'))
    : { accepts: (_p: string) => true };

  const filesToIndex = allDiskFiles.filter(file => {
    const ext = path.extname(file);
    const filename = path.basename(file);
    return ignore.accepts(file) && !IGNORED_EXTENSIONS.has(ext) && !IGNORED_FILENAMES.has(filename);
  });

  console.log(`[3/4] Found ${filesToIndex.length} files to process for additions/modifications.`);
  let processedCount = 0;

  for (const relativePath of filesToIndex) {
    const fullPath = path.join(projectPath, relativePath);
    const content = fs.readFileSync(fullPath, 'utf-8');
    if (!content.trim()) continue;

    const hash = crypto.createHash('sha265').update(content).digest('hex');
    const { rows } = await client.query('SELECT content_hash FROM indexed_files WHERE project_id = $1 AND path = $2', [projectId, relativePath]);

    if (rows.length > 0 && rows[0].content_hash === hash) {
      continue;
    }

    processedCount++;
    console.log(`      Processing changed file: ${relativePath}`);

    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM indexed_files WHERE project_id = $1 AND path = $2', [projectId, relativePath]);
      
      const summary = await summarizeFile(relativePath, content);
      const summaryEmbedding = await getEmbedding(summary);
      
      const fileInsertResult = await client.query(
        'INSERT INTO indexed_files (project_id, path, content_hash, summary, summary_embedding, last_indexed_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id',
        [projectId, relativePath, hash, summary, pgvector.toSql(summaryEmbedding)]
      );
      const fileId = fileInsertResult.rows[0].id;
      
      const chunks = chunkCodeWithAST(content);
      for (const chunk of chunks) {
        const chunkEmbedding = await getEmbedding(chunk.content);
        await client.query(
          `INSERT INTO code_chunks (file_id, chunk_name, chunk_type, content, start_line, end_line, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [fileId, chunk.metadata.name, chunk.metadata.type, chunk.content, chunk.metadata.start_line, chunk.metadata.end_line, pgvector.toSql(chunkEmbedding)]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`      Failed to process ${relativePath}:`, error);
    }
  }
  console.log(`[4/4] File sync complete. Processed ${processedCount} new or changed files.`);
}

// --- STAGE 2: Sync Git Commit History ---
async function syncGitHistory(client: Client, projectId: number, git: SimpleGit) {
    console.log('\n[1/3] Starting Git history sync...');
    
    const { rows: existingCommits } = await client.query('SELECT commit_hash FROM commits WHERE project_id = $1', [projectId]);
    const existingHashes = new Set(existingCommits.map(c => c.commit_hash));
    console.log(`[2/3] Found ${existingHashes.size} existing commits in the database.`);

    const log = await git.log();
    const allCommits = [...log.all].reverse();

    const newCommits = allCommits.filter(c => !existingHashes.has(c.hash));
    if (newCommits.length === 0) {
        console.log('[3/3] Git history is already up-to-date.');
        return;
    }
    console.log(`      Found ${newCommits.length} new commits to process.`);

    for (const commit of newCommits) {
        console.log(`      Processing commit ${commit.hash.substring(0, 7)}: ${commit.message}`);
        
        await client.query('BEGIN');
        try {
            const messageEmbedding = await getEmbedding(commit.message);
            const commitInsertResult = await client.query(
                `INSERT INTO commits (project_id, commit_hash, author_name, author_email, commit_date, message, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [projectId, commit.hash, commit.author_name, commit.author_email, commit.date, commit.message, pgvector.toSql(messageEmbedding)]
            );
            const commitId = commitInsertResult.rows[0].id;
            
            const diff = await git.show(['--name-status', '--pretty=format:', commit.hash]);
            const changedFiles = diff.split('\n').filter(line => line.trim());

            for (const line of changedFiles) {
                const parts = line.split('\t');
                if (parts.length < 2) continue;
                const change_type = parts[0].trim();
                const file_path = parts[1].trim();
                
                const { rows } = await client.query('SELECT id FROM indexed_files WHERE project_id = $1 AND path = $2', [projectId, file_path]);

                if (rows.length > 0) {
                    const fileId = rows[0].id;
                    await client.query(
                        `INSERT INTO commit_files (commit_id, file_id, change_type) VALUES ($1, $2, $3)`,
                        [commitId, fileId, change_type]
                    );
                }
            }

            // NEW: Check commit message for task-closing keywords
            const taskRegex = /(?:closes|fixes|resolves)\s+#(\d+)/gi;
            let match;
            while ((match = taskRegex.exec(commit.message)) !== null) {
                const taskNumber = parseInt(match[1], 10);
                console.log(`      -> Found reference to close task #${taskNumber}.`);
                const updateResult = await client.query(
                    `UPDATE tasks SET status = 'done', updated_at = NOW() WHERE project_id = $1 AND task_number = $2 AND status != 'done'`,
                    [projectId, taskNumber]
                );
                if (updateResult.rowCount && updateResult.rowCount > 0) {
                    console.log(`      ✅ Automatically closed task #${taskNumber}.`);
                }
            }

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            console.error(`      Failed to process commit ${commit.hash}:`, error);
        }
    }
    console.log('[3/3] Git history sync complete.');
}