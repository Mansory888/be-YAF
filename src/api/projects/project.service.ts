// src/api/projects/project.service.ts
import { getDbClient } from '../../services/db';
import { cloneOrPullRepo } from '../../services/git';
import { runIngestion } from '../../scripts/ingest';
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

export async function createProject(source: string) {
    const client = await getDbClient();
    try {
        const existing = await client.query('SELECT id FROM projects WHERE source = $1', [source]);
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

export async function startProjectIngestion(projectId: number, source: string) {
    try {
        const projectPath = await cloneOrPullRepo(source);
        console.log(`[Project ${projectId}] Ingestion running...`);
        await runIngestion(projectId, projectPath);
        console.log(`✅ [Project ${projectId}] Ingestion complete.`);
    } catch (error) {
        console.error(`❌ [Project ${projectId}] Ingestion failed:`, error);
    }
}