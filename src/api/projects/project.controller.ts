// src/api/projects/project.controller.ts
import { Request, Response, NextFunction } from 'express';
import * as projectService from './project.service';
import * as qaService from './qa.service'; // We will create this next

export async function listProjects(req: Request, res: Response, next: NextFunction) {
    try {
        const projects = await projectService.getAllProjects();
        res.json(projects);
    } catch (error) {
        next(error);
    }
}

export async function addProject(req: Request, res: Response, next: NextFunction) {
    try {
        const { source } = req.body;
        if (!source) {
            return res.status(400).json({ error: 'A "source" Git URL is required.' });
        }
        
        const { project, created } = await projectService.createProject(source);

        if (!created) {
            return res.status(200).json({ message: 'Project already exists.', project });
        }
        
        // Respond immediately and start ingestion in the background
        res.status(202).json({ message: 'Project created. Ingestion started.', project });
        projectService.startProjectIngestion(project.id, project.source);

    } catch (error) {
        next(error);
    }
}

export async function syncProject(req: Request, res: Response, next: NextFunction) {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        const { source } = req.body; // Assuming source is passed to find repo
        
        res.status(202).json({ message: 'Project sync started.' });
        projectService.startProjectIngestion(projectId, source);
    } catch (error) {
        next(error);
    }
}

export async function askQuestion(req: Request, res: Response, next: NextFunction) {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        const { question } = req.body;
        if (!question) {
            return res.status(400).json({ error: 'A "question" is required.' });
        }
        
        const stream = await qaService.getAnswerStream(projectId, question);
        
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        for await (const chunk of stream) {
            res.write(chunk.choices[0]?.delta?.content || '');
        }
        res.end();

    } catch (error) {
        if (!res.headersSent) {
          next(error);
        } else {
          console.error("Error during streaming:", error);
          res.end();
        }
    }
}