// src/api/projects/project.service.ts
import { getDbClient } from '../../services/db';
import { cloneOrPullRepo } from '../../services/git';
import { runIngestion, IngestionLogger } from '../../scripts/ingest'; // Import IngestionLogger
import path from 'path';
import { chunkText } from '../../core/textChunker';
import { getEmbedding } from '../../services/openai';
import fs from 'fs/promises';
import pgvector from 'pgvector/pg';
import { extractTextFromFile } from '../../core/documentExtractor'; // <-- IMPORT THE NEW EXTRACTOR

export async function getAllProjects() {
    const client = await getDbClient();
    try {
        const { rows } = await client.query('SELECT id, name, source FROM projects ORDER BY created_at DESC');
        return rows;
    } finally {
        await client.end();
    }
}

export async function getProjectById(projectId: number) {
    const client = await getDbClient();
    try {
        const { rows } = await client.query('SELECT * FROM projects WHERE id = $1', [projectId]);
        if (rows.length === 0) {
            return null;
        }
        return rows[0];
    } finally {
        await client.end();
    }
}


export async function createProject(source: string) {
    const client = await getDbClient();
    try {
        const existing = await client.query('SELECT * FROM projects WHERE source = $1', [source]);
        if (existing.rows.length > 0) {
            // Project already exists, return it
            return { project: existing.rows[0], created: false };
        }

        const projectName = path.basename(source, path.extname(source));
        const { rows } = await client.query(
            'INSERT INTO projects (name, source) VALUES ($1, $2) RETURNING *',
            [projectName, source]
        );
        return { project: rows[0], created: true };
    } finally {
        await client.end();
    }
}

// MODIFIED: This function now accepts a logger and is the core logic for ingestion.
export async function startProjectIngestion(projectId: number, source: string, logger: IngestionLogger) {
    try {
        const projectPath = await cloneOrPullRepo(source, logger); // Pass logger to git service
        logger(`[Project ${projectId}] Ingestion running...`);
        await runIngestion(projectId, projectPath, logger);
        logger(`✅ [Project ${projectId}] Ingestion complete.`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger(`❌ [Project ${projectId}] Ingestion failed: ${errorMessage}`);
        console.error(`❌ [Project ${projectId}] Ingestion failed:`, error);
    }
}

// NEW HELPER for fire-and-forget ingestion
export function startProjectIngestionInBackground(projectId: number, source: string) {
    // We don't await this, so it runs in the background.
    // Logs will go to the console.
    startProjectIngestion(projectId, source, console.log);
}

export async function addProjectDocument(projectId: number, originalFilename: string, storedFilePath: string) {
    const client = await getDbClient();
    await client.query('BEGIN');
    try {
        // MODIFIED: Pass both the stored path AND the original filename to the extractor.
        const content = await extractTextFromFile(storedFilePath, originalFilename);

        // 2. Insert document metadata
        const docResult = await client.query(
            'INSERT INTO project_documents (project_id, file_name, file_path) VALUES ($1, $2, $3) RETURNING id',
            [projectId, originalFilename, storedFilePath]
        );
        const documentId = docResult.rows[0].id;

        // 3. Chunk the text content (now it's clean text)
        const chunks = chunkText(content);

        // 4. Embed and insert each chunk
        for (const chunk of chunks) {
            // This call is now safe from token overflows
            const embedding = await getEmbedding(chunk);
            await client.query(
                'INSERT INTO document_chunks (document_id, content, embedding) VALUES ($1, $2, $3)',
                [documentId, chunk, pgvector.toSql(embedding)]
            );
        }

        await client.query('COMMIT');
        return { id: documentId, file_name: originalFilename, file_path: storedFilePath };
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Failed to process document ${originalFilename}:`, error);
        throw error;
    } finally {
        await client.end();
    }
}

// NEW: Function to get comprehensive stats for a project
export async function getProjectStats(projectId: number) {
    const client = await getDbClient();
    try {
        // Run queries in parallel for efficiency
        const [
            fileStatsRes,
            taskStatsRes,
            docStatsRes,
            commitHistoryRes,
            contributorRes
        ] = await Promise.all([
            // Query 1: Get counts of indexed files and code chunks
            client.query(
                `SELECT
                    (SELECT COUNT(*) FROM indexed_files WHERE project_id = $1) as file_count,
                    (SELECT COUNT(*) FROM code_chunks WHERE file_id IN (SELECT id FROM indexed_files WHERE project_id = $1)) as chunk_count`,
                [projectId]
            ),
            // Query 2: Get task counts grouped by status
            client.query(
                `SELECT status, COUNT(*) as count FROM tasks WHERE project_id = $1 GROUP BY status`,
                [projectId]
            ),
            // Query 3: Get count of uploaded documents
            client.query(
                `SELECT COUNT(*) as document_count FROM project_documents WHERE project_id = $1`,
                [projectId]
            ),
            // Query 4: Get the 50 most recent commits (Git History)
            client.query(
                `SELECT commit_hash, author_name, commit_date, message FROM commits WHERE project_id = $1 ORDER BY commit_date DESC LIMIT 50`,
                [projectId]
            ),
            // Query 5: Get the count of unique contributors
            client.query(
                `SELECT COUNT(DISTINCT author_name) as contributor_count FROM commits WHERE project_id = $1`,
                [projectId]
            )
        ]);

        // Process task stats into a more friendly object
        const taskStats = taskStatsRes.rows.reduce((acc, row) => {
            acc[row.status] = parseInt(row.count, 10);
            return acc;
        }, { open: 0, in_progress: 0, done: 0 });

        const stats = {
            files: {
                count: parseInt(fileStatsRes.rows[0].file_count, 10),
                chunks: parseInt(fileStatsRes.rows[0].chunk_count, 10),
            },
            tasks: taskStats,
            documents: {
                count: parseInt(docStatsRes.rows[0].document_count, 10),
            },
            git: {
                commitCount: commitHistoryRes.rows.length, // Count from the returned limited list
                contributorCount: parseInt(contributorRes.rows[0].contributor_count, 10),
                history: commitHistoryRes.rows, // The actual commit objects
            }
        };

        return stats;

    } finally {
        await client.end();
    }
}