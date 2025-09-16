// --- FILE: services/queue.service.ts ---
import PQueue from 'p-queue';

// Create a single, shared queue for the entire application.
// concurrency: 1 ensures that only one promise runs at a time.
// This is our lock to prevent multiple ingestions from running simultaneously.
const ingestionQueue = new PQueue({ concurrency: 1 });

export default ingestionQueue;