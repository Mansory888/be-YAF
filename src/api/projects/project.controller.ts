// src/api/projects/project.controller.ts
import { Request, Response, NextFunction } from 'express';
import * as projectService from './project.service';
import * as qaService from './qa.service';

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
        res.status(202).json({ message: 'Project created. Ingestion will start in the background.', project });
        projectService.startProjectIngestionInBackground(project.id, project.source);

    } catch (error) {
        next(error);
    }
}

// REMOVED old syncProject, which is replaced by streamIngestionLogs

// NEW: Controller for streaming ingestion logs
export async function streamIngestionLogs(req: Request, res: Response, next: NextFunction) {
    const projectId = parseInt(req.params.projectId, 10);
    
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); // Flush the headers to establish the connection

    const logger = (message: string) => {
        // Format message for SSE
        res.write(`data: ${JSON.stringify({ log: message })}\n\n`);
    };

    // Handle client disconnect
    req.on('close', () => {
        console.log(`Client disconnected from ingestion stream for project ${projectId}.`);
        res.end();
    });

    try {
        const project = await projectService.getProjectById(projectId);
        if (!project) {
            logger(`Error: Project with ID ${projectId} not found.`);
            res.end();
            return;
        }
        
        // Start the ingestion and wait for it to complete, streaming logs along the way
        await projectService.startProjectIngestion(projectId, project.source, logger);
        
        // Signal the end of the stream
        res.write('event: end\ndata: {"message": "Ingestion complete"}\n\n');
        res.end();

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger(`FATAL ERROR: ${errorMessage}`);
        console.error("Error during ingestion stream:", error);
        res.write(`event: error\ndata: {"message": "${errorMessage}"}\n\n`);
        res.end();
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