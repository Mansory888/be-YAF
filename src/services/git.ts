// src/services/git.ts
import simpleGit from 'simple-git';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const WORKSPACE_DIR = path.join(os.homedir(), '.ai-brain-workspace');

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

export async function cloneOrPullRepo(source: string): Promise<string> {
    const projectPath = getWorkspacePathFromUrl(source);
    await fs.mkdir(WORKSPACE_DIR, { recursive: true });

    try {
        await fs.access(path.join(projectPath, '.git'));
        console.log(`Found existing repository. Fetching updates from ${source}...`);
        await simpleGit(projectPath).pull();
    } catch (error) {
        console.log(`Cloning repository from ${source}...`);
        await simpleGit().clone(source, projectPath);
    }
    return projectPath;
}