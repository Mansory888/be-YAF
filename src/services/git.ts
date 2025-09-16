// src/services/git.ts
import simpleGit from 'simple-git';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const WORKSPACE_DIR = path.join(os.homedir(), '.ai-brain-workspace');
// Optional: Define a logger type for clarity
type GitLogger = (message: string) => void;


export function getWorkspacePathFromUrl(url: string): string {
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

export async function cloneOrPullRepo(source: string, logger: GitLogger = console.log): Promise<string> {
    const projectPath = getWorkspacePathFromUrl(source);
    await fs.mkdir(WORKSPACE_DIR, { recursive: true });

    try {
        await fs.access(path.join(projectPath, '.git'));
        logger(`Found existing repository. Fetching updates from ${source}...`);
        await simpleGit(projectPath).pull();
        logger(`-> Updates pulled successfully.`);
    } catch (error) {
        logger(`Cloning repository from ${source}...`);
        await simpleGit().clone(source, projectPath);
        logger(`-> Cloned successfully.`);
    }
    return projectPath;
}