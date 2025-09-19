-- Step 1: Enable the pgvector extension.
CREATE EXTENSION IF NOT EXISTS vector;

-- NEW: Table for projects. This is the root of all data.
CREATE TABLE projects (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT UNIQUE NOT NULL, -- The Git URL or unique local path
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- MODIFIED: Link indexed_files to a project.
CREATE TABLE IF NOT EXISTS indexed_files (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, -- New
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  summary TEXT,
  summary_embedding VECTOR(1536),
  last_indexed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, path) -- Path is unique *within* a project
);

-- MODIFIED: code_chunks is implicitly linked via file_id. No changes needed.
CREATE TABLE IF NOT EXISTS code_chunks (
  id SERIAL PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
  chunk_name TEXT,
  chunk_type TEXT,
  content TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  embedding VECTOR(1536) NOT NULL
);

-- MODIFIED: Link commits to a project.
CREATE TABLE IF NOT EXISTS commits (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, -- New
  commit_hash TEXT NOT NULL,
  author_name TEXT,
  author_email TEXT,
  commit_date TIMESTAMPTZ NOT NULL,
  message TEXT NOT NULL,
  embedding VECTOR(1536),
  UNIQUE (project_id, commit_hash) -- Hash is unique *within* a project
);

-- MODIFIED: commit_files is implicitly linked. No changes needed.
CREATE TABLE IF NOT EXISTS commit_files (
  id SERIAL PRIMARY KEY,
  commit_id INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
  change_type TEXT NOT NULL,
  UNIQUE (commit_id, file_id)
);

-- NEW: Table for tasks, ready for the Kanban board.
CREATE TABLE tasks (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_number SERIAL, -- Project-specific task ID (#1, #2, etc.)
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open', -- e.g., 'open', 'in_progress', 'done'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (project_id, task_number)
);

ALTER TABLE tasks ADD COLUMN embedding vector(1536);

-- Recreate indexes to ensure they exist for all tables.
DROP INDEX IF EXISTS idx_indexed_files_summary_embedding;
DROP INDEX IF EXISTS idx_code_chunks_embedding;
DROP INDEX IF EXISTS idx_commits_embedding;
CREATE INDEX idx_indexed_files_summary_embedding ON indexed_files USING HNSW (summary_embedding vector_l2_ops);
CREATE INDEX idx_code_chunks_embedding ON code_chunks USING HNSW (embedding vector_l2_ops);
CREATE INDEX idx_commits_embedding ON commits USING HNSW (embedding vector_l2_ops);

-- B-tree indexes for faster joins.
CREATE INDEX IF NOT EXISTS idx_indexed_files_project_id ON indexed_files (project_id);
CREATE INDEX IF NOT EXISTS idx_code_chunks_file_id ON code_chunks (file_id);
CREATE INDEX IF NOT EXISTS idx_commits_project_id ON commits (project_id);
CREATE INDEX IF NOT EXISTS idx_commit_files_commit_id ON commit_files (commit_id);
CREATE INDEX IF NOT EXISTS idx_commit_files_file_id ON commit_files (file_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks (project_id);

ALTER TABLE tasks ADD COLUMN embedding vector(1536);

ALTER TABLE tasks ADD COLUMN category TEXT;


-- Create a table to store metadata about uploaded project documents.
CREATE TABLE project_documents (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL, -- Path on the server's file system
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, file_name)
);

-- Create a table to store the embedded chunks of these documents.
CREATE TABLE document_chunks (
  id SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES project_documents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding VECTOR(1536) NOT NULL
);

-- Create an index for fast vector searching on document chunks.
CREATE INDEX idx_document_chunks_embedding ON document_chunks USING HNSW (embedding vector_l2_ops);

-- B-tree index for faster joins.
CREATE INDEX IF NOT EXISTS idx_project_documents_project_id ON project_documents (project_id);


CREATE TABLE conversations (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE conversation_messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role VARCHAR(10) NOT NULL CHECK (role IN ('user', 'assistant')), -- 'user' or 'assistant'
    content TEXT NOT NULL,
    sources JSONB, -- Storing the sources for the assistant's message
    created_at TIMESTAMPTZ DEFAULT NOW()
);


CREATE TABLE knowledge_notes (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL, -- Optional link
    note_summary TEXT NOT NULL, -- e.g., "Decision: Change JWT expiration from 1h to 24h"
    embedding VECTOR(1536), -- The vector representation of the summary
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE knowledge_note_links (
    id SERIAL PRIMARY KEY,
    knowledge_note_id INTEGER NOT NULL REFERENCES knowledge_notes(id) ON DELETE CASCADE,
    file_id INTEGER REFERENCES indexed_files(id) ON DELETE CASCADE,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    commit_id INTEGER REFERENCES commits(id) ON DELETE CASCADE
    -- Note: We can use constraints to ensure at least one link is not null
);