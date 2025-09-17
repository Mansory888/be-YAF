// src/api/projects/project.service.ts
import pool from '../../services/db';
import { cloneOrPullRepo } from '../../services/git';
import { runIngestion, IngestionLogger } from '../../scripts/ingest';
import path from 'path';
import { chunkText } from '../../core/textChunker';
import { getEmbedding } from '../../services/openai';
import fs from 'fs/promises';
import pgvector from 'pgvector/pg';
import { extractTextFromFile } from '../../core/documentExtractor';

export async function getAllProjects() {
    const client = await pool.connect();
    try {
        const { rows } = await client.query('SELECT id, name, source FROM projects ORDER BY created_at DESC');
        return rows;
    } finally {
        client.release();
    }
}

export async function getProjectById(projectId: number) {
    const client = await pool.connect();
    try {
        const { rows } = await client.query('SELECT * FROM projects WHERE id = $1', [projectId]);
        if (rows.length === 0) {
            return null;
        }
        return rows[0];
    } finally {
        client.release();
    }
}


export async function createProject(source: string) {
    const client = await pool.connect();
    try {
        const existing = await client.query('SELECT * FROM projects WHERE source = $1', [source]);
        if (existing.rows.length > 0) {
            return { project: existing.rows[0], created: false };
        }

        const projectName = path.basename(source, path.extname(source));
        const { rows } = await client.query(
            'INSERT INTO projects (name, source) VALUES ($1, $2) RETURNING *',
            [projectName, source]
        );
        return { project: rows[0], created: true };
    } finally {
        client.release();
    }
}

export async function startProjectIngestion(projectId: number, source: string, logger: IngestionLogger) {
    try {
        const projectPath = await cloneOrPullRepo(source, logger);
        logger(`[Project ${projectId}] Ingestion running...`);
        await runIngestion(projectId, projectPath, logger);
        logger(`✅ [Project ${projectId}] Ingestion complete.`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger(`❌ [Project ${projectId}] Ingestion failed: ${errorMessage}`);
        console.error(`❌ [Project ${projectId}] Ingestion failed:`, error);
    }
}

export function startProjectIngestionInBackground(projectId: number, source: string) {
    startProjectIngestion(projectId, source, console.log);
}

export async function addProjectDocument(projectId: number, originalFilename: string, storedFilePath: string) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const content = await extractTextFromFile(storedFilePath, originalFilename);

        const docResult = await client.query(
            'INSERT INTO project_documents (project_id, file_name, file_path) VALUES ($1, $2, $3) RETURNING id',
            [projectId, originalFilename, storedFilePath]
        );
        const documentId = docResult.rows[0].id;

        const chunks = chunkText(content);

        console.log(`[project.service] Number of chunks to be inserted: ${chunks.length}`);
        let chunkCounter = 0;

        for (const chunk of chunks) {
            chunkCounter++;
            console.log(`[project.service] >> Processing chunk ${chunkCounter}/${chunks.length}`);

            // Let's inspect the chunk to make sure it's valid
            if (!chunk || chunk.trim().length < 5) {
                console.log(`[project.service] >> Chunk ${chunkCounter} is too short or empty. Skipping.`);
                continue;
            }

            try {
                console.log(`[project.service] >>   1. Generating embedding for chunk ${chunkCounter}...`);
                const embedding = await getEmbedding(chunk);
                console.log(`[project.service] >>   2. Embedding generated (length: ${embedding.length}). Inserting into DB...`);

                await client.query(
                    'INSERT INTO document_chunks (document_id, content, embedding) VALUES ($1, $2, $3)',
                    [documentId, chunk, pgvector.toSql(embedding)]
                );

                console.log(`[project.service] >>   3. Successfully inserted chunk ${chunkCounter} into DB.`);

            } catch (loopError) {
                // THIS IS A NEW, CRITICAL CATCH BLOCK
                console.error(`[project.service] >> !! ERROR inside chunk loop on chunk ${chunkCounter}:`, loopError);
                // We re-throw the error to ensure the main transaction is rolled back.
                throw loopError;
            }
        }

        console.log(`[project.service] Finished processing all chunks. Committing transaction...`);

        await client.query('COMMIT');
        console.log('[project.service] Transaction committed.'); // Let's confirm this happens
        return { id: documentId, file_name: originalFilename, file_path: storedFilePath };
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Failed to process document ${originalFilename}:`, error);
        throw error;
    } finally {
        client.release();
    }
}

export async function getProjectDocuments(projectId: number) {
    const client = await pool.connect();
    try {
        const { rows } = await client.query(
            'SELECT id, file_name, created_at FROM project_documents WHERE project_id = $1 ORDER BY created_at DESC',
            [projectId]
        );
        return rows;
    } finally {
        client.release();
    }
}

export async function deleteProjectDocument(projectId: number, documentId: number) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const docResult = await client.query(
            'SELECT file_path FROM project_documents WHERE id = $1 AND project_id = $2',
            [documentId, projectId]
        );

        if (docResult.rows.length === 0) {
            throw new Error('Document not found or does not belong to this project.');
        }
        const filePath = docResult.rows[0].file_path;

        await client.query('DELETE FROM document_chunks WHERE document_id = $1', [documentId]);
        await client.query('DELETE FROM project_documents WHERE id = $1', [documentId]);

        await client.query('COMMIT');

        if (filePath) {
            try {
                await fs.unlink(filePath);
            } catch (fileError) {
                console.error(`Failed to delete document file ${filePath}:`, fileError);
            }
        }
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Failed to delete document ${documentId}:`, error);
        throw error;
    } finally {
        client.release();
    }
}

export async function getProjectStats(projectId: number) {
    const client = await pool.connect();
    try {
        const [
            fileStatsRes,
            taskStatsRes,
            docStatsRes,
            commitHistoryRes,
            contributorRes
        ] = await Promise.all([
            client.query(
                `SELECT
                    (SELECT COUNT(*) FROM indexed_files WHERE project_id = $1) as file_count,
                    (SELECT COUNT(*) FROM code_chunks WHERE file_id IN (SELECT id FROM indexed_files WHERE project_id = $1)) as chunk_count`,
                [projectId]
            ),
            client.query(
                `SELECT status, COUNT(*) as count FROM tasks WHERE project_id = $1 GROUP BY status`,
                [projectId]
            ),
            client.query(
                `SELECT COUNT(*) as document_count FROM project_documents WHERE project_id = $1`,
                [projectId]
            ),
            client.query(
                `SELECT commit_hash, author_name, commit_date, message FROM commits WHERE project_id = $1 ORDER BY commit_date DESC LIMIT 50`,
                [projectId]
            ),
            client.query(
                `SELECT COUNT(DISTINCT author_name) as contributor_count FROM commits WHERE project_id = $1`,
                [projectId]
            )
        ]);

        const taskStats = taskStatsRes.rows.reduce((acc, row) => {
            acc[row.status] = parseInt(row.count, 10);
            return acc;
        }, { open: 0, in_progress: 0, done: 0 });

        return {
            files: {
                count: parseInt(fileStatsRes.rows[0].file_count, 10),
                chunks: parseInt(fileStatsRes.rows[0].chunk_count, 10),
            },
            tasks: taskStats,
            documents: {
                count: parseInt(docStatsRes.rows[0].document_count, 10),
            },
            git: {
                commitCount: commitHistoryRes.rows.length,
                contributorCount: parseInt(contributorRes.rows[0].contributor_count, 10),
                history: commitHistoryRes.rows,
            }
        };
    } finally {
        client.release();
    }
}