// src/services/db.ts
import { Client } from 'pg';
import pgvector from 'pgvector/pg';

const connectionString = process.env.DATABASE_URL!;

export async function getDbClient(): Promise<Client> {
    const client = new Client({ connectionString });
    await client.connect();
    await pgvector.registerType(client);
    return client;
}