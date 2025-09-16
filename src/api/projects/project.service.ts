// src/api/projects/project.service.ts
import { getDbClient } from '../../services/db';
import { cloneOrPullRepo } from '../../services/git';
import { runIngestion, IngestionLogger } from '../../scripts/ingest'; // Import IngestionLogger
import path from 'path';

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