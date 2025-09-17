// src/services/db.ts
import { Pool } from 'pg';
import pgvector from 'pgvector/pg';

const connectionString = process.env.DATABASE_URL!;

if (!connectionString) {
    throw new Error("FATAL: Missing environment variable DATABASE_URL");
}

// Create a single, shared pool for the entire application
const pool = new Pool({ connectionString });

// Add a listener to register the vector type on each new connection
// that the pool creates.
pool.on('connect', async (client) => {
    await pgvector.registerType(client);
});

export default pool;