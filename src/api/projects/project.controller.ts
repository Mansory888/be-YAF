// src/api/projects/project.controller.ts
import { Request, Response, NextFunction } from 'express';
import * as projectService from './project.service';
import * as qaService from './qa.service';
import ingestionQueue from '../../services/queue.service';
import { UnsupportedFileTypeError } from '../../core/documentExtractor'; // <-- IMPORT THE CUSTOM ERROR


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
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const logger = (message: string) => {
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ log: message })}\n\n`);
        }
    };

    req.on('close', () => {
        console.log(`Client disconnected from ingestion stream for project ${projectId}.`);
        res.end();
    });

    // MODIFIED: Wrap the entire ingestion logic in the queue
    ingestionQueue.add(async () => {
        try {
            const project = await projectService.getProjectById(projectId);
            if (!project) {
                logger(`Error: Project with ID ${projectId} not found.`);
                return; // Return from the job, not the outer function
            }
            
            logger('Your sync request is now being processed...');
            await projectService.startProjectIngestion(projectId, project.source, logger);
            
            logger('Ingestion complete.');
            res.write('event: end\ndata: {"message": "Ingestion complete"}\n\n');

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger(`FATAL ERROR: ${errorMessage}`);
            console.error("Error during ingestion stream:", error);
            res.write(`event: error\ndata: {"message": "${errorMessage}"}\n\n`);
        } finally {
            if (!res.writableEnded) {
                res.end();
            }
        }
    }).catch((err:any) => {
        // This catch is for errors adding the job to the queue itself, which is rare.
        console.error("Failed to add ingestion job to queue:", err);
        if (!res.writableEnded) {
            res.status(500).send("Failed to queue the ingestion job.");
        }
    });
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

export async function uploadDocument(req: Request, res: Response, next: NextFunction) {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded.' });
        }
        
        const document = await projectService.addProjectDocument(
            projectId,
            req.file.originalname,
            req.file.path
        );

        res.status(201).json({ message: 'Document uploaded and indexed successfully.', document });
    } catch (error) {
        // MODIFIED: Catch specific error for unsupported file types
        if (error instanceof UnsupportedFileTypeError) {
            return res.status(400).json({ error: error.message });
        }
        next(error);
    }
}

// NEW: Controller for project stats
export async function getProjectStats(req: Request, res: Response, next: NextFunction) {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        const stats = await projectService.getProjectStats(projectId);
        res.json(stats);
    } catch (error) {
        next(error);
    }
}