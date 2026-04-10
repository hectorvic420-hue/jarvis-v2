import * as fs from 'fs';
import * as path from 'path';
import { Result, Ok, Err } from '../shared/result.js';

// ─── Error types ──────────────────────────────────────────────────────────────

export class PathSecurityError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly attemptedPath: string
  ) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

export class PathTraversalError extends PathSecurityError {
  constructor(attemptedPath: string) {
    super(`Path traversal detectado: "${attemptedPath}"`, 'PATH_TRAVERSAL', attemptedPath);
    this.name = 'PathTraversalError';
  }
}

export class InvalidExtensionError extends PathSecurityError {
  constructor(attemptedPath: string, ext: string) {
    super(`Extensión no permitida: ${ext || '(ninguna)'}`, 'INVALID_EXTENSION', attemptedPath);
    this.name = 'InvalidExtensionError';
  }
}

export class SymlinkEscapeError extends PathSecurityError {
  constructor(attemptedPath: string, realPath: string) {
    super(`Symlink escapa del project root → ${realPath}`, 'SYMLINK_ESCAPE', attemptedPath);
    this.name = 'SymlinkEscapeError';
  }
}

export class PathNotFoundError extends PathSecurityError {
  constructor(attemptedPath: string) {
    super(`Archivo no encontrado: "${attemptedPath}"`, 'PATH_NOT_FOUND', attemptedPath);
    this.name = 'PathNotFoundError';
  }
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface PathValidatorOptions {
  projectRoot: string;
  allowedExtensions: string[];
  allowNonExistent?: boolean;
  followSymlinks?: boolean;
}

// ─── Validator ────────────────────────────────────────────────────────────────

export class PathValidator {
  private readonly projectRoot: string;
  private readonly allowedExtensions: Set<string>;
  private readonly allowNonExistent: boolean;
  private readonly followSymlinks: boolean;

  constructor(options: PathValidatorOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.allowedExtensions = new Set(options.allowedExtensions.map(e => e.toLowerCase()));
    this.allowNonExistent = options.allowNonExistent ?? false;
    this.followSymlinks = options.followSymlinks ?? false;
  }

  validate(inputPath: string): Result<string, PathSecurityError> {
    // Step 1: null / undefined
    if (inputPath === null || inputPath === undefined) {
      return Err(new PathSecurityError(
        'Path inválido: null o undefined', 'NULL_PATH', String(inputPath)
      ));
    }
    if (typeof inputPath !== 'string') {
      return Err(new PathSecurityError(
        'Path inválido: no es string', 'NULL_PATH', String(inputPath)
      ));
    }

    // Step 2: empty
    const trimmed = inputPath.trim();
    if (trimmed.length === 0) {
      return Err(new PathSecurityError('Path vacío', 'EMPTY_PATH', inputPath));
    }

    // Step 3: traversal pattern detection (before resolution)
    const traversalResult = this.detectTraversal(trimmed);
    if (traversalResult.isErr()) return traversalResult as Result<string, PathSecurityError>;

    // Step 4: resolve and root boundary check
    const absolutePath = path.resolve(this.projectRoot, trimmed);
    const rootWithSep = this.projectRoot + path.sep;
    if (!absolutePath.startsWith(rootWithSep) && absolutePath !== this.projectRoot) {
      return Err(new PathTraversalError(inputPath));
    }

    // Step 5: existence-dependent checks
    const exists = fs.existsSync(absolutePath);

    if (exists) {
      const lstat = fs.lstatSync(absolutePath);

      // 5a: symlink escape check (before following the link)
      if (lstat.isSymbolicLink() && !this.followSymlinks) {
        const realPath = fs.realpathSync(absolutePath);
        if (!realPath.startsWith(rootWithSep) && realPath !== this.projectRoot) {
          return Err(new SymlinkEscapeError(inputPath, realPath));
        }
      }

      // 5b: directory check (follows symlinks via stat)
      const stat = fs.statSync(absolutePath);
      if (stat.isDirectory()) {
        return Err(new PathSecurityError(
          `Es un directorio, no un archivo`, 'IS_DIRECTORY', inputPath
        ));
      }

      // 5c: extension check
      const ext = path.extname(absolutePath).toLowerCase();
      if (!ext || !this.allowedExtensions.has(ext)) {
        return Err(new InvalidExtensionError(inputPath, ext));
      }
    } else {
      // File does not exist
      if (!this.allowNonExistent) {
        return Err(new PathNotFoundError(inputPath));
      }
      // Still validate extension for non-existent files
      const ext = path.extname(absolutePath).toLowerCase();
      if (!ext || !this.allowedExtensions.has(ext)) {
        return Err(new InvalidExtensionError(inputPath, ext));
      }
    }

    return Ok(absolutePath);
  }

  validateMany(paths: string[]): Result<string[], PathSecurityError> {
    const resolved: string[] = [];
    for (const p of paths) {
      const result = this.validate(p);
      if (result.isErr()) return result as unknown as Result<string[], PathSecurityError>;
      resolved.push(result.value);
    }
    return Ok(resolved);
  }

  getSecurityInfo(inputPath: string): {
    normalized: string;
    relative: string;
    extension: string;
    isInsideRoot: boolean;
  } {
    const absolutePath = path.resolve(this.projectRoot, inputPath);
    const rootWithSep = this.projectRoot + path.sep;
    const isInsideRoot =
      absolutePath.startsWith(rootWithSep) || absolutePath === this.projectRoot;

    return {
      normalized: inputPath,
      relative: path.relative(this.projectRoot, absolutePath),
      extension: path.extname(absolutePath),
      isInsideRoot,
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private detectTraversal(inputPath: string): Result<string, PathSecurityError> {
    // Absolute paths are not allowed (relative-only policy)
    if (path.isAbsolute(inputPath)) {
      return Err(new PathTraversalError(inputPath));
    }

    // Null-byte injection
    if (inputPath.includes('\0') || inputPath.includes('%00')) {
      return Err(new PathTraversalError(inputPath));
    }

    // Decode URL encoding (single then double) to catch %2e%2e and %252e%252e
    let decoded = inputPath;
    try {
      decoded = decodeURIComponent(inputPath);
      decoded = decodeURIComponent(decoded);
    } catch {
      return Err(new PathTraversalError(inputPath));
    }

    // Normalize mixed separators to forward slash for analysis
    const normalized = decoded.replace(/\\/g, '/');

    // Split and scan each path component
    for (const segment of normalized.split('/')) {
      // Block any segment that is two or more dots: .., ..., ....
      if (/^\.{2,}$/.test(segment)) {
        return Err(new PathTraversalError(inputPath));
      }
    }

    return Ok(inputPath);
  }
}
