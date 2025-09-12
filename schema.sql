-- Step 1: Enable the pgvector extension.
CREATE EXTENSION IF NOT EXISTS vector;

-- Step 2: Create a table for indexed files.
CREATE TABLE indexed_files (
  id SERIAL PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  content_hash TEXT NOT NULL,
  summary TEXT,
  summary_embedding VECTOR(1536),
  last_indexed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 3: Create the table for code chunks.
CREATE TABLE code_chunks (
  id SERIAL PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
  chunk_name TEXT,
  chunk_type TEXT,
  content TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  embedding VECTOR(1536) NOT NULL
);

-- Step 4: Create the table for Git commits.
CREATE TABLE commits (
  id SERIAL PRIMARY KEY,
  commit_hash TEXT UNIQUE NOT NULL,
  author_name TEXT,
  author_email TEXT,
  commit_date TIMESTAMPTZ NOT NULL,
  message TEXT NOT NULL,
  embedding VECTOR(1536)
);

-- Step 5: Create a link table between commits and files.
CREATE TABLE commit_files (
  id SERIAL PRIMARY KEY,
  commit_id INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
  change_type TEXT NOT NULL,
  UNIQUE (commit_id, file_id)
);

-- Step 6: Create HNSW indexes for fast vector search.
CREATE INDEX ON indexed_files USING HNSW (summary_embedding vector_l2_ops);
CREATE INDEX ON code_chunks USING HNSW (embedding vector_l2_ops);
CREATE INDEX ON commits USING HNSW (embedding vector_l2_ops);

-- Step 7: Create B-tree indexes for faster joins.
CREATE INDEX ON code_chunks (file_id);
CREATE INDEX ON commit_files (commit_id);
CREATE INDEX ON commit_files (file_id);