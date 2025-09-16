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
import simpleGit, { SimpleGit, LogResult, DefaultLogFields } from 'simple-git';
// REFACTORED: Import both dedicated prompt generators
import { generateFileSummaryPrompt } from '../core/prompts/fileSummary.prompt';
import { generateTaskFromCommitPrompt } from '../core/prompts/taskGeneration.prompt';

// --- CONFIGURATION (Global) ---
const connectionString = process.env.DATABASE_URL!;
const openaiApiKey = process.env.OPENAI_API_KEY!;

if (!connectionString || !openaiApiKey) {
  throw new Error('FATAL: Missing environment variables DATABASE_URL or OPENAI_API_KEY');
}

const openai = new OpenAI({ apiKey: openaiApiKey });
const IGNORED_EXTENSIONS = new Set(['.lock', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico']);
const IGNORED_FILENAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

export type IngestionLogger = (message: string) => void;

// --- CORE HELPER FUNCTIONS ---
async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.replace(/\n/g, ' '),
  });
  return response.data[0].embedding;
}

// REFACTORED: This function now uses the imported prompt
async function summarizeFile(filePath: string, content: string, logger: IngestionLogger): Promise<string> {
  const prompt = generateFileSummaryPrompt(filePath, content);
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 100,
      temperature: 0.1,
    });
    return response.choices[0].message.content?.trim() || "Could not generate a summary.";
  } catch (error) {
    logger(`  - Failed to summarize ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return "Summary generation failed.";
  }
}

// --- MAIN INGESTION LOGIC ---
export async function runIngestion(projectId: number, projectPath: string, logger: IngestionLogger) {
  const client = new Client({ connectionString });
  await client.connect();
  await pgvector.registerType(client);
  logger('Database connection established.');

  const git: SimpleGit = simpleGit(projectPath);

  try {
    await syncFiles(client, projectId, projectPath, logger);
    await syncGitHistory(client, projectId, git, logger);
  } finally {
    logger('Ingestion process finished. Closing database connection.');
    await client.end();
  }
}

// --- STAGE 1: Sync Filesystem State ---
// This function remains the same, but its call to summarizeFile is now cleaner.
async function syncFiles(client: Client, projectId: number, projectPath: string, logger: IngestionLogger) {
  logger(`[1/4] Starting file sync for project ID: ${projectId}`);
  
  logger(`[2/4] Pruning deleted files from the database...`);
  const { rows: dbFiles } = await client.query('SELECT path FROM indexed_files WHERE project_id = $1', [projectId]);
  const dbPaths = new Set(dbFiles.map(f => f.path));
  
  const allDiskFiles = await glob('**/*', { cwd: projectPath, nodir: true, dot: true, ignore: ['**/node_modules/**', '**/.git/**'] });
  const diskPaths = new Set(allDiskFiles);

  const pathsToDelete = [...dbPaths].filter(p => !diskPaths.has(p));

  if (pathsToDelete.length > 0) {
    logger(`      Found ${pathsToDelete.length} files to delete.`);
    await client.query('DELETE FROM indexed_files WHERE project_id = $1 AND path = ANY($2::text[])', [projectId, pathsToDelete]);
    logger(`      -> Pruning complete.`);
  } else {
    logger(`      -> No files to prune.`);
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

  logger(`[3/4] Found ${filesToIndex.length} files to process for additions/modifications.`);
  let processedCount = 0;

  for (const relativePath of filesToIndex) {
    const fullPath = path.join(projectPath, relativePath);
    const content = fs.readFileSync(fullPath, 'utf-8');
    if (!content.trim()) continue;

    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const { rows } = await client.query('SELECT content_hash FROM indexed_files WHERE project_id = $1 AND path = $2', [projectId, relativePath]);

    if (rows.length > 0 && rows[0].content_hash === hash) {
      continue;
    }

    processedCount++;
    logger(`      Processing changed file: ${relativePath}`);

    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM indexed_files WHERE project_id = $1 AND path = $2', [projectId, relativePath]);
      
      const summary = await summarizeFile(relativePath, content, logger);
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
      logger(`      Failed to process ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  logger(`[4/4] File sync complete. Processed ${processedCount} new or changed files.`);
}

// --- STAGE 2: Sync Git Commit History ---

// REFACTORED: This function now uses the imported prompt
async function generateTaskFromCommit(client: Client, projectId: number, commit: DefaultLogFields, git: SimpleGit, logger: IngestionLogger) {
    const diff = await git.show(['--patch', '--first-parent', commit.hash]);
    
    if (!diff || diff.trim().length < 50) { 
        logger(`      -> Commit ${commit.hash.substring(0,7)} is trivial, skipping task generation.`);
        return;
    }

    const prompt = generateTaskFromCommitPrompt(commit.message, diff);

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
            max_tokens: 400, // Increased token limit for more detailed descriptions
            temperature: 0.1,
        });
        
        const responseText = response.choices[0].message.content?.trim();

        if (!responseText || responseText.toUpperCase() === 'NULL') {
            logger(`      -> AI determined commit is trivial, skipping task generation.`);
            return;
        }

        // MODIFIED: Destructure the new 'description' field
        const { title, category, description } = JSON.parse(responseText);

        if (!title || !category || !description) {
            throw new Error('AI response was missing title, category, or description.');
        }

        logger(`      -> AI generated task: [${category}] "${title}"`);

        // MODIFIED: The content to embed now includes the more detailed description
        const contentToEmbed = `[${category}] ${title}\n\n${description}\n\nCompleted in commit: ${commit.hash}`;
        const taskEmbedding = await getEmbedding(contentToEmbed);

        await client.query(
            `INSERT INTO tasks (project_id, title, description, status, category, embedding, created_at, updated_at) 
             VALUES ($1, $2, $3, 'done', $4, $5, $6, $6)`,
            [
                projectId, 
                title, 
                // MODIFIED: Use the AI-generated description
                description,
                category,
                pgvector.toSql(taskEmbedding),
                commit.date
            ]
        );
        logger(`      ✅ Created and closed retrospective task for commit ${commit.hash.substring(0,7)}.`);

    } catch (error) {
        logger(`      ❌ Failed to generate task for commit ${commit.hash.substring(0,7)}: ${error instanceof Error ? error.message : 'Unknown AI or parsing error'}`);
    }
}

// This function now contains the core orchestration logic for git history.
async function syncGitHistory(client: Client, projectId: number, git: SimpleGit, logger: IngestionLogger) {
    logger('\n[1/3] Starting Git history sync...');
    
    const { rows: existingCommits } = await client.query('SELECT commit_hash FROM commits WHERE project_id = $1', [projectId]);
    const existingHashes = new Set(existingCommits.map(c => c.commit_hash));
    logger(`[2/3] Found ${existingHashes.size} existing commits in the database.`);

    const log: LogResult<DefaultLogFields> = await git.log();
    const allCommits = [...log.all].reverse();

    const newCommits = allCommits.filter(c => !existingHashes.has(c.hash));
    if (newCommits.length === 0) {
        logger('[3/3] Git history is already up-to-date.');
        return;
    }
    logger(`      Found ${newCommits.length} new commits to process.`);

    for (const commit of newCommits) {
        logger(`      Processing commit ${commit.hash.substring(0, 7)}: ${commit.message}`);
        
        await client.query('BEGIN');
        try {
            const messageEmbedding = await getEmbedding(commit.message);
            const commitInsertResult = await client.query(
                `INSERT INTO commits (project_id, commit_hash, author_name, author_email, commit_date, message, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [projectId, commit.hash, commit.author_name, commit.author_email, commit.date, commit.message, pgvector.toSql(messageEmbedding)]
            );
            const commitId = commitInsertResult.rows[0].id;
            
            const diffSummary = await git.show(['--name-status', '--pretty=format:', commit.hash]);
            const changedFiles = diffSummary.split('\n').filter(line => line.trim());

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

            const taskRegex = /(?:closes|fixes|resolves)\s+#(\d+)/gi;
            const match = taskRegex.exec(commit.message);

            if (match) {
                const taskNumber = parseInt(match[1], 10);
                logger(`      -> Found reference to close task #${taskNumber}.`);
                const updateResult = await client.query(
                    `UPDATE tasks SET status = 'done', updated_at = NOW() WHERE project_id = $1 AND task_number = $2 AND status != 'done'`,
                    [projectId, taskNumber]
                );
                if (updateResult.rowCount && updateResult.rowCount > 0) {
                    logger(`      ✅ Automatically closed task #${taskNumber}.`);
                }
            } else {
                await generateTaskFromCommit(client, projectId, commit, git, logger);
            }

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            logger(`      Failed to process commit ${commit.hash}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    logger('[3/3] Git history sync complete.');
}