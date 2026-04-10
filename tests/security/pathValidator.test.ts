import { describe, it, expect, beforeEach } from 'vitest';
import { PathValidator, PathTraversalError, InvalidExtensionError, SymlinkEscapeError, PathNotFoundError } from '../../src/security/pathValidator';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('PathValidator', () => {
  let validator: PathValidator;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathvalidator-test-'));
    validator = new PathValidator({
      projectRoot: tempDir,
      allowedExtensions: ['.ts', '.js', '.json'],
      allowNonExistent: false,
      followSymlinks: false
    });
  });

  describe('Validaciones básicas', () => {
    it('debe aceptar un path válido dentro del proyecto', () => {
      const filePath = path.join(tempDir, 'test.ts');
      fs.writeFileSync(filePath, 'content');

      const result = validator.validate('test.ts');
      expect(result.isOk()).toBe(true);
      expect(result.unwrap()).toBe(filePath);
    });

    it('debe rechazar path null', () => {
      const result = validator.validate(null as any);
      expect(result.isErr()).toBe(true);
      expect((result as any).error.code).toBe('NULL_PATH');
    });

    it('debe rechazar path undefined', () => {
      const result = validator.validate(undefined as any);
      expect(result.isErr()).toBe(true);
      expect((result as any).error.code).toBe('NULL_PATH');
    });

    it('debe rechazar string vacío', () => {
      const result = validator.validate('');
      expect(result.isErr()).toBe(true);
      expect((result as any).error.code).toBe('EMPTY_PATH');
    });

    it('debe rechazar string con solo espacios', () => {
      const result = validator.validate('   ');
      expect(result.isErr()).toBe(true);
    });
  });

  describe('Path Traversal Protection', () => {
    const traversalAttacks = [
      { name: 'simple dot-dot', path: '../etc/passwd' },
      { name: 'múltiple niveles', path: '../../../etc/passwd' },
      { name: 'con current dir', path: './../etc/passwd' },
      { name: 'URL encoded', path: '%2e%2e%2f%2e%2e%2fetc%2fpasswd' },
      { name: 'doble encoding', path: '%252e%252e%252fetc%252fpasswd' },
      { name: 'null byte', path: 'test.ts%00../etc/passwd' },
      { name: 'backslash Windows', path: '..\\..\\windows\\system32\\config\\sam' },
      { name: 'mixed separators', path: '../..\\../etc/passwd' },
      { name: 'double dots', path: '....//....//etc/passwd' },
      { name: 'triple dots', path: '.../.../.../etc/passwd' },
      { name: 'con src', path: 'src/../../../etc/passwd' },
      { name: 'absoluto', path: '/etc/passwd' },
    ];

    traversalAttacks.forEach(({ name, path: attackPath }) => {
      it(`debe bloquear ataque: ${name} (${attackPath})`, () => {
        const result = validator.validate(attackPath);
        expect(result.isErr()).toBe(true);
        expect((result as any).error).toBeInstanceOf(PathTraversalError);
        expect((result as any).error.code).toBe('PATH_TRAVERSAL');
      });
    });
  });

  describe('Validación de extensiones', () => {
    it('debe aceptar extensión permitida .ts', () => {
      const filePath = path.join(tempDir, 'test.ts');
      fs.writeFileSync(filePath, 'content');

      const result = validator.validate('test.ts');
      expect(result.isOk()).toBe(true);
    });

    it('debe aceptar extensión permitida .js', () => {
      const filePath = path.join(tempDir, 'test.js');
      fs.writeFileSync(filePath, 'content');

      const result = validator.validate('test.js');
      expect(result.isOk()).toBe(true);
    });

    it('debe rechazar extensión no permitida .exe', () => {
      const filePath = path.join(tempDir, 'test.exe');
      fs.writeFileSync(filePath, 'content');

      const result = validator.validate('test.exe');
      expect(result.isErr()).toBe(true);
      expect((result as any).error).toBeInstanceOf(InvalidExtensionError);
    });

    it('debe rechazar extensión no permitida .sh', () => {
      const filePath = path.join(tempDir, 'test.sh');
      fs.writeFileSync(filePath, 'content');

      const result = validator.validate('test.sh');
      expect(result.isErr()).toBe(true);
    });

    it('debe ser case-insensitive en extensiones', () => {
      const filePath = path.join(tempDir, 'test.TS');
      fs.writeFileSync(filePath, 'content');

      const result = validator.validate('test.TS');
      expect(result.isOk()).toBe(true);
    });

    it('debe rechazar archivo sin extensión', () => {
      const filePath = path.join(tempDir, 'test');
      fs.writeFileSync(filePath, 'content');

      const result = validator.validate('test');
      expect(result.isErr()).toBe(true);
    });
  });

  describe('Validación de existencia', () => {
    it('debe rechazar archivo inexistente cuando allowNonExistent=false', () => {
      const result = validator.validate('noexiste.ts');
      expect(result.isErr()).toBe(true);
      expect((result as any).error).toBeInstanceOf(PathNotFoundError);
    });

    it('debe aceptar archivo inexistente cuando allowNonExistent=true', () => {
      const validatorWithNonExistent = new PathValidator({
        projectRoot: tempDir,
        allowedExtensions: ['.ts'],
        allowNonExistent: true
      });

      const result = validatorWithNonExistent.validate('nuevo.ts');
      expect(result.isOk()).toBe(true);
    });
  });

  describe('Protección contra directorios', () => {
    it('debe rechazar un directorio (no archivo)', () => {
      const dirPath = path.join(tempDir, 'micarpeta');
      fs.mkdirSync(dirPath);

      const result = validator.validate('micarpeta');
      expect(result.isErr()).toBe(true);
      expect((result as any).error.code).toBe('IS_DIRECTORY');
    });
  });

  // Symlinks require elevated privileges on Windows — skip unless available
  const canSymlink = (() => {
    try {
      const tmp = path.join(os.tmpdir(), `symtest-${process.pid}`);
      fs.symlinkSync(os.tmpdir(), tmp);
      fs.unlinkSync(tmp);
      return true;
    } catch { return false; }
  })();

  describe('Protección contra symlinks', () => {
    it.skipIf(!canSymlink)('debe detectar symlink que escapa del project root', () => {
      // Crear archivo fuera del tempDir
      const outsideFile = path.join(os.tmpdir(), 'outside-secret.txt');
      fs.writeFileSync(outsideFile, 'secret');

      // Crear symlink dentro del tempDir que apunta fuera
      const symlinkPath = path.join(tempDir, 'evil-link');
      fs.symlinkSync(outsideFile, symlinkPath);

      const result = validator.validate('evil-link');
      expect(result.isErr()).toBe(true);
      expect((result as any).error).toBeInstanceOf(SymlinkEscapeError);

      // Cleanup
      fs.unlinkSync(outsideFile);
      fs.unlinkSync(symlinkPath);
    });

    it.skipIf(!canSymlink)('debe permitir symlink interno cuando followSymlinks=true', () => {
      const realFile = path.join(tempDir, 'real.ts');
      const symlinkPath = path.join(tempDir, 'link.ts');

      fs.writeFileSync(realFile, 'content');
      fs.symlinkSync(realFile, symlinkPath);

      const validatorWithSymlinks = new PathValidator({
        projectRoot: tempDir,
        allowedExtensions: ['.ts'],
        followSymlinks: true
      });

      const result = validatorWithSymlinks.validate('link.ts');
      expect(result.isOk()).toBe(true);

      fs.unlinkSync(symlinkPath);
    });
  });

  describe('validateMany', () => {
    it('debe validar múltiples paths válidos', () => {
      const file1 = path.join(tempDir, 'a.ts');
      const file2 = path.join(tempDir, 'b.ts');
      fs.writeFileSync(file1, 'a');
      fs.writeFileSync(file2, 'b');

      const result = validator.validateMany(['a.ts', 'b.ts']);
      expect(result.isOk()).toBe(true);
      expect(result.unwrap()).toHaveLength(2);
    });

    it('debe fallar si algún path es inválido', () => {
      const file1 = path.join(tempDir, 'a.ts');
      fs.writeFileSync(file1, 'a');

      const result = validator.validateMany(['a.ts', '../../../etc/passwd']);
      expect(result.isErr()).toBe(true);
    });
  });

  describe('getSecurityInfo', () => {
    it('debe retornar información sin validar', () => {
      const info = validator.getSecurityInfo('src/test.ts');

      expect(info.normalized).toBe('src/test.ts');
      expect(info.relative).toBe(path.join('src', 'test.ts')); // cross-platform
      expect(info.extension).toBe('.ts');
      expect(info.isInsideRoot).toBe(true);
    });

    it('debe detectar path fuera del root en info', () => {
      const info = validator.getSecurityInfo('../../../etc/passwd');
      expect(info.isInsideRoot).toBe(false);
    });
  });
});
