// src/api/projects/project.routes.ts
import { Router } from 'express';
import * as projectController from './project.controller';
import taskRoutes from '../tasks/task.routes';
import multer from 'multer';

const router = Router();
const upload = multer({ dest: 'uploads/' });

router.get('/', projectController.listProjects);
router.post('/', projectController.addProject);

// MODIFIED: This is now a GET request to establish an SSE connection for logs
router.get('/:projectId/sync-stream', projectController.streamIngestionLogs);

// NEW: Route to get project statistics
router.get('/:projectId/stats', projectController.getProjectStats);

router.post('/:projectId/ask', projectController.askQuestion);

// --- Document Routes ---
router.post('/:projectId/documents', upload.single('document'), projectController.uploadDocument);
// NEW: Route to list all documents for a project
router.get('/:projectId/documents', projectController.listDocuments);
// NEW: Route to delete a specific document
router.delete('/:projectId/documents/:documentId', projectController.deleteDocument);


// Mount task routes nested under projects
router.use('/:projectId/tasks', taskRoutes);

export default router;