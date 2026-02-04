/**
 * Structured Logger Module
 *
 * Provides structured logging with support for:
 * - Log levels (DEBUG, INFO, WARN, ERROR)
 * - JSON formatting for enterprise log aggregation
 * - Configurable output destinations
 * - Backward-compatible console.log fallback
 */

/**
 * Log levels with numeric values for comparison
 */
export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4
};

/**
 * Parse log level from string or number
 * @param {string|number} level - Log level
 * @returns {number} Numeric log level
 */
function parseLogLevel(level) {
  if (typeof level === 'number') {
    return level;
  }

  const upperLevel = String(level).toUpperCase();
  if (upperLevel in LogLevel) {
    return LogLevel[upperLevel];
  }

  // Default to INFO if invalid
  return LogLevel.INFO;
}

/**
 * Get log level name from numeric value
 * @param {number} level - Numeric log level
 * @returns {string} Log level name
 */
function getLevelName(level) {
  for (const [name, value] of Object.entries(LogLevel)) {
    if (value === level) return name;
  }
  return 'INFO';
}

/**
 * ANSI color codes for console output
 */
const Colors = {
  RESET: '\x1b[0m',
  RED: '\x1b[31m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[34m',
  GRAY: '\x1b[90m'
};

/**
 * Color mapping for log levels
 */
const LevelColors = {
  [LogLevel.DEBUG]: Colors.GRAY,
  [LogLevel.INFO]: Colors.BLUE,
  [LogLevel.WARN]: Colors.YELLOW,
  [LogLevel.ERROR]: Colors.RED
};

/**
 * Logger class for structured logging
 */
export class Logger {
  /**
   * Create a new Logger instance
   * @param {object} options - Logger options
   * @param {string|number} options.level - Minimum log level
   * @param {boolean} options.json - Output in JSON format
   * @param {boolean} options.colors - Use ANSI colors (ignored if json=true)
   * @param {string} options.name - Logger name (for context)
   * @param {function} options.output - Custom output function
   */
  constructor(options = {}) {
    this.level = parseLogLevel(
      options.level ??
      process.env.LOG_LEVEL ??
      (process.env.NODE_ENV === 'production' ? 'INFO' : 'DEBUG')
    );

    this.json = options.json ?? (process.env.LOG_FORMAT === 'json');
    this.colors = options.colors ?? (!this.json && process.stdout.isTTY !== false);
    this.name = options.name ?? null;
    this.output = options.output ?? console.log;
    this.errorOutput = options.errorOutput ?? console.error;
  }

  /**
   * Create a child logger with additional context
   * @param {string} name - Child logger name
   * @returns {Logger} Child logger instance
   */
  child(name) {
    return new Logger({
      level: this.level,
      json: this.json,
      colors: this.colors,
      name: this.name ? `${this.name}:${name}` : name,
      output: this.output,
      errorOutput: this.errorOutput
    });
  }

  /**
   * Check if a log level is enabled
   * @param {number} level - Log level to check
   * @returns {boolean} Whether the level is enabled
   */
  isLevelEnabled(level) {
    return level >= this.level;
  }

  /**
   * Format a log entry
   * @param {number} level - Log level
   * @param {string} message - Log message
   * @param {object} data - Additional data
   * @returns {string} Formatted log entry
   */
  format(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const levelName = getLevelName(level);

    if (this.json) {
      return JSON.stringify({
        timestamp,
        level: levelName,
        ...(this.name && { logger: this.name }),
        message,
        ...(Object.keys(data).length > 0 && { data })
      });
    }

    // Human-readable format
    const color = this.colors ? (LevelColors[level] || Colors.RESET) : '';
    const reset = this.colors ? Colors.RESET : '';
    const prefix = this.name ? `[${this.name}] ` : '';

    let formatted = `${color}${levelName}${reset} ${prefix}${message}`;

    if (Object.keys(data).length > 0) {
      const dataStr = JSON.stringify(data);
      formatted += ` ${this.colors ? Colors.GRAY : ''}${dataStr}${reset}`;
    }

    return formatted;
  }

  /**
   * Log a message at the specified level
   * @param {number} level - Log level
   * @param {string} message - Log message
   * @param {object} data - Additional data
   */
  log(level, message, data = {}) {
    if (!this.isLevelEnabled(level)) return;

    const formatted = this.format(level, message, data);

    if (level >= LogLevel.ERROR) {
      this.errorOutput(formatted);
    } else {
      this.output(formatted);
    }
  }

  /**
   * Log at DEBUG level
   * @param {string} message - Log message
   * @param {object} data - Additional data
   */
  debug(message, data = {}) {
    this.log(LogLevel.DEBUG, message, data);
  }

  /**
   * Log at INFO level
   * @param {string} message - Log message
   * @param {object} data - Additional data
   */
  info(message, data = {}) {
    this.log(LogLevel.INFO, message, data);
  }

  /**
   * Log at WARN level
   * @param {string} message - Log message
   * @param {object} data - Additional data
   */
  warn(message, data = {}) {
    this.log(LogLevel.WARN, message, data);
  }

  /**
   * Log at ERROR level
   * @param {string} message - Log message
   * @param {object|Error} data - Additional data or Error object
   */
  error(message, data = {}) {
    // Handle Error objects
    if (data instanceof Error) {
      data = {
        error: data.message,
        stack: data.stack,
        name: data.name
      };
    }
    this.log(LogLevel.ERROR, message, data);
  }

  /**
   * Log a step (INFO level with step number formatting)
   * @param {number|string} step - Step number
   * @param {string} message - Step message
   * @param {object} data - Additional data
   */
  step(step, message, data = {}) {
    const prefix = this.colors ? Colors.BLUE : '';
    const reset = this.colors ? Colors.RESET : '';
    this.info(`${prefix}[Step ${step}]${reset} ${message}`, data);
  }

  /**
   * Log a success message (INFO level with checkmark)
   * @param {string} message - Success message
   * @param {object} data - Additional data
   */
  success(message, data = {}) {
    const prefix = this.colors ? Colors.GREEN : '';
    const reset = this.colors ? Colors.RESET : '';
    this.info(`${prefix}[OK]${reset} ${message}`, data);
  }
}

/**
 * Create a default logger instance
 * Uses environment variables for configuration
 */
export function createLogger(options = {}) {
  return new Logger(options);
}

/**
 * Create a logger from a config object (from loadConfig)
 * Maps config.logging properties to Logger options
 * @param {object} config - Config object with logging property
 * @returns {Logger} Configured logger instance
 */
export function createLoggerFromConfig(config) {
  const loggingConfig = config?.logging || {};
  
  return new Logger({
    level: loggingConfig.level,
    json: loggingConfig.format === 'json',
    colors: loggingConfig.colors,
    name: loggingConfig.name
  });
}

/**
 * Default logger instance
 */
export const logger = createLogger();

export default logger;
