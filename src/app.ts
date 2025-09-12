// src/app.ts
import 'dotenv/config';
import express from 'express';
import path from 'path';
import projectRoutes from './api/projects/project.routes';
import { errorHandler } from './middleware/errorHandler';

const app = express();

// Middleware
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// API Routes
app.use('/api/projects', projectRoutes);

// Error Handler
app.use(errorHandler);

export default app;