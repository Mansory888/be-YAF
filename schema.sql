-- Step 1: Enable the pgvector extension.
CREATE EXTENSION IF NOT EXISTS vector;

-- Step 2: Create a table for files (the "macro" view of your project).
-- This is an evolution of your `indexed_files` table.
-- We use a numeric `id` as the primary key for better join performance.
CREATE TABLE indexed_files (
  -- A unique, auto-incrementing integer ID. This is the best practice for a primary key.
  id SERIAL PRIMARY KEY,
  
  -- The relative path of the file from the project root. We add a UNIQUE constraint to it.
  path TEXT UNIQUE NOT NULL,

  -- The SHA-256 hash of the file's content to detect changes.
  content_hash TEXT NOT NULL,
  
  -- NEW: An LLM-generated summary of the file's purpose.
  summary TEXT,
  
  -- NEW: The vector embedding of the file's summary. This is for high-level concept searches.
  summary_embedding VECTOR(1536),

  -- A timestamp to track when the file was last processed. Useful for maintenance.
  last_indexed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 3: Create the table for code chunks (the "micro" view).
-- This is largely the same, but now references the integer ID of the file.
CREATE TABLE code_chunks (
  -- A unique ID for each chunk.
  id SERIAL PRIMARY KEY,
  
  -- IMPROVEMENT: Links to the numeric ID of the file for faster joins.
  -- If the file is deleted from indexed_files, all its chunks are also deleted.
  file_id INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
  
  -- The name of the function or class, if applicable (e.g., from an AST).
  chunk_name TEXT,
  
  -- The type of chunk (e.g., 'function', 'class', 'component', 'block').
  chunk_type TEXT,
  
  -- The actual source code content of the chunk.
  content TEXT NOT NULL,
  
  -- Metadata for locating the chunk in the original file.
  start_line INTEGER,
  end_line INTEGER,
  
  -- The vector embedding for this specific chunk's content.
  embedding VECTOR(1536) NOT NULL
);

-- Step 4: Create modern, high-performance HNSW indexes for vector search.
-- HNSW is generally preferred over IVFFlat for its superior performance and ease of use.

-- Index for fast searching on file summaries.
CREATE INDEX ON indexed_files USING HNSW (summary_embedding vector_l2_ops);

-- Index for fast searching on code chunks.
CREATE INDEX ON code_chunks USING HNSW (embedding vector_l2_ops);

-- Step 5 (Optional but Recommended): Create a standard B-tree index for foreign keys.
-- This speeds up finding all chunks belonging to a specific file.
CREATE INDEX ON code_chunks (file_id);