// --- FILE: core/chunker.ts ---
import Parser, { Query } from 'tree-sitter'; // MODIFIED: Import the Query class
import TypeScript from 'tree-sitter-typescript/typescript';

export interface CodeChunk {
  content: string;
  metadata: {
    type: 'function' | 'class' | 'method' | 'arrow_function' | 'block';
    name: string;
    start_line: number;
    end_line: number;
  };
}

const parser = new Parser();
parser.setLanguage(TypeScript);

// CRITICAL: This query identifies the distinct, semantic blocks of code.
const TS_QUERY = `
[
  (function_declaration) @chunk
  (class_declaration) @chunk
  (method_definition) @chunk
  (lexical_declaration 
    (variable_declarator 
      value: (arrow_function)
    )
  ) @chunk
]
`;

export function chunkCodeWithAST(content: string): CodeChunk[] {
  const tree = parser.parse(content);
  // MODIFIED: Use the Query constructor for robustness
  const query = new Query(TypeScript, TS_QUERY);
  const matches = query.captures(tree.rootNode);

  const chunks: CodeChunk[] = [];

  for (const match of matches) {
    const node = match.node;
    let name = 'anonymous';
    let type: CodeChunk['metadata']['type'] = 'block';

    // Heuristics to find the name of the chunk
    if (node.type === 'function_declaration' || node.type === 'class_declaration' || node.type === 'method_definition') {
        name = node.childForFieldName('name')?.text || 'anonymous';
        if (node.type === 'method_definition') type = 'method';
        else if (node.type === 'class_declaration') type = 'class';
        else type = 'function';
    } else if (node.type === 'lexical_declaration') {
        // For arrow functions like `const myFunc = () => ...`
        name = node.firstNamedChild?.firstNamedChild?.text || 'anonymous_arrow_function';
        type = 'arrow_function';
    }
    
    chunks.push({
      content: node.text,
      metadata: {
        type: type,
        name: name,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
      },
    });
  }

  // Fallback: If no specific chunks were found (e.g., a simple config file),
  // treat the entire file as a single chunk.
  if (chunks.length === 0 && content.trim().length > 0) {
    chunks.push({
      content: content,
      metadata: {
        type: 'block',
        name: 'file_content',
        start_line: 1,
        end_line: content.split('\n').length,
      },
    });
  }

  return chunks;
}