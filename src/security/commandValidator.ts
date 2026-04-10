import { Result, Ok, Err } from '../shared/result.js';

export class CommandSecurityError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly attemptedCommand: string
  ) {
    super(message);
    this.name = 'CommandSecurityError';
  }
}

export class DangerousCharactersError extends CommandSecurityError {
  constructor(command: string, chars: string) {
    super(
      `Caracteres peligrosos detectados: ${chars} en "${command}"`,
      'DANGEROUS_CHARS',
      command
    );
  }
}

export class CommandNotAllowedError extends CommandSecurityError {
  constructor(command: string, baseCmd: string) {
    super(
      `Comando no permitido: ${baseCmd}`,
      'COMMAND_NOT_ALLOWED',
      command
    );
  }
}

export class InvalidCommandFormatError extends CommandSecurityError {
  constructor(command: string, pattern: string) {
    super(
      `Formato inválido para comando. Esperado: ${pattern}`,
      'INVALID_FORMAT',
      command
    );
  }
}

export interface CommandRule {
  name: string;
  pattern: RegExp;
  description: string;
  maxArgs?: number;
}

export class CommandValidator {
  private readonly allowedCommands: Map<string, CommandRule>;
  private readonly dangerousChars: RegExp;

  constructor(customRules?: CommandRule[]) {
    // Caracteres que permiten command injection
    this.dangerousChars = /[;|&\`$(){}[\]\\<>!]/;

    // Reglas por defecto - MUY restrictivas
    const defaultRules: CommandRule[] = [
      {
        name: 'ls',
        pattern: /^ls(\s+-[a-zA-Z]+)*\s*$/,
        description: 'Listar directorios',
        maxArgs: 5
      },
      {
        name: 'cat',
        pattern: /^cat\s+[a-zA-Z0-9_.\-\/~]+$/,
        description: 'Mostrar contenido de archivo',
        maxArgs: 1
      },
      {
        name: 'pwd',
        pattern: /^pwd\s*$/,
        description: 'Directorio actual'
      },
      {
        name: 'echo',
        pattern: /^echo\s+["']?[^"';|&`$(){}[\]\\<>!]*["']?\s*$/,
        description: 'Imprimir texto seguro'
      },
      {
        name: 'df',
        pattern: /^df\s*-h?\s*$/,
        description: 'Espacio en disco'
      },
      {
        name: 'free',
        pattern: /^free\s*-h?\s*$/,
        description: 'Memoria RAM'
      },
      {
        name: 'uptime',
        pattern: /^uptime\s*$/,
        description: 'Tiempo de actividad'
      },
      {
        name: 'whoami',
        pattern: /^whoami\s*$/,
        description: 'Usuario actual'
      },
      {
        name: 'uname',
        pattern: /^uname(\s+-[a-z]+)?\s*$/,
        description: 'Información del sistema'
      },
      {
        name: 'ps',
        pattern: /^ps(\s+-[efww]+)*\s*$/,
        description: 'Procesos'
      },
      {
        name: 'top',
        pattern: /^top\s+-bn1\s*$/,
        description: 'Procesos (snapshot)'
      },
      {
        name: 'pm2',
        pattern: /^pm2\s+(list|status|logs|monit|info)\s*$/,
        description: 'PM2 (solo lectura)',
        maxArgs: 2
      },
      {
        name: 'npm',
        pattern: /^npm\s+(list|outdated|audit|run)\s+[\w-]+\s*$/,
        description: 'NPM (operaciones seguras)',
        maxArgs: 3
      },
      {
        name: 'git',
        pattern: /^git\s+(status|log|diff|branch|remote|show)\s*$/,
        description: 'Git (solo lectura)',
        maxArgs: 3
      },
      {
        name: 'curl',
        pattern: /^curl\s+--max-time\s+\d+\s+https?:\/\/[a-zA-Z0-9_.\-\/]+\s*$/,
        description: 'HTTP GET seguro',
        maxArgs: 5
      }
    ];

    this.allowedCommands = new Map();
    const rules = customRules || defaultRules;

    for (const rule of rules) {
      this.allowedCommands.set(rule.name, rule);
    }
  }

  validate(command: string): Result<string, CommandSecurityError> {
    if (command === null || command === undefined || typeof command !== 'string') {
      return Err(new CommandSecurityError(
        'Comando inválido: null o undefined',
        'NULL_COMMAND',
        String(command)
      ));
    }

    const sanitized = command.trim();

    if (sanitized.length === 0) {
      return Err(new CommandSecurityError(
        'Comando vacío',
        'EMPTY_COMMAND',
        sanitized
      ));
    }

    // PASO 2: Extraer comando base solo con chars alfanuméricos (nunca incluye
    // chars de inyección aunque estén pegados, ej. "ls;cat" → baseCmd="ls")
    const baseCmdMatch = sanitized.match(/^([a-zA-Z0-9]+)/);
    const baseCmd = baseCmdMatch ? baseCmdMatch[1].toLowerCase() : '';

    // PASO 3: Verificar contra whitelist PRIMERO — rechaza cualquier binario
    // no autorizado antes de analizar su contenido
    const rule = this.allowedCommands.get(baseCmd);
    if (!rule) {
      return Err(new CommandNotAllowedError(sanitized, baseCmd || sanitized.split(/\s+/)[0]));
    }

    // PASO 4: Bloquear caracteres peligrosos (SEGUNDA LÍNEA DE DEFENSA)
    // — solo alcanzamos aquí si el binario base está en la whitelist
    const dangerousMatch = sanitized.match(this.dangerousChars);
    if (dangerousMatch) {
      return Err(new DangerousCharactersError(sanitized, dangerousMatch[0]));
    }

    // PASO 5: Verificar patrón completo
    if (!rule.pattern.test(sanitized)) {
      return Err(new InvalidCommandFormatError(sanitized, rule.description));
    }

    // PASO 6: Verificar límite de argumentos (si aplica)
    const parts = sanitized.split(/\s+/);
    if (rule.maxArgs && parts.length > rule.maxArgs + 1) {
      return Err(new CommandSecurityError(
        `Demasiados argumentos. Máximo: ${rule.maxArgs}`,
        'TOO_MANY_ARGS',
        sanitized
      ));
    }

    // PASO 7: Verificaciones adicionales específicas
    const specificCheck = this.runSpecificChecks(sanitized, baseCmd);
    if (specificCheck.isErr()) {
      return specificCheck;
    }

    return Ok(sanitized);
  }

  private runSpecificChecks(command: string, baseCmd: string): Result<string, CommandSecurityError> {
    switch (baseCmd) {
      case 'cat': {
        const sensitiveFiles = ['/etc/passwd', '/etc/shadow', '.env', 'id_rsa', '.ssh'];
        const lowerCmd = command.toLowerCase();
        for (const sensitive of sensitiveFiles) {
          if (lowerCmd.includes(sensitive.toLowerCase())) {
            return Err(new CommandSecurityError(
              `Acceso a archivo sensible bloqueado: ${sensitive}`,
              'SENSITIVE_FILE',
              command
            ));
          }
        }
        break;
      }

      case 'curl': {
        if (command.includes('-o') || command.includes('--output') || command.includes('>')) {
          return Err(new CommandSecurityError(
            'curl con output no permitido',
            'CURL_OUTPUT_BLOCKED',
            command
          ));
        }
        break;
      }
    }

    return Ok(command);
  }

  async validateAndRun(
    command: string,
    executor: (cmd: string) => Promise<string>
  ): Promise<Result<string, CommandSecurityError>> {
    const validation = this.validate(command);
    if (validation.isErr()) {
      return validation;
    }

    try {
      const output = await executor(validation.value);
      return Ok(output);
    } catch (err) {
      return Err(new CommandSecurityError(
        `Error de ejecución: ${(err as Error).message}`,
        'EXECUTION_ERROR',
        command
      ));
    }
  }

  getAllowedCommands(): Array<{ name: string; description: string; pattern: string }> {
    return Array.from(this.allowedCommands.values()).map(rule => ({
      name: rule.name,
      description: rule.description,
      pattern: rule.pattern.toString()
    }));
  }
}

// Singleton preconfigurado
export const defaultCommandValidator = new CommandValidator();

export function validateCommand(command: string): Result<string, CommandSecurityError> {
  return defaultCommandValidator.validate(command);
}
