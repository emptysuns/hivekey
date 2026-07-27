'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const levelName = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = Object.prototype.hasOwnProperty.call(LEVELS, levelName) ? LEVELS[levelName] : LEVELS.info;

// Docker has no TTY; set LOG_COLOR=always (or FORCE_COLOR=1) to keep ANSI in `docker logs`
const colorEnv = process.env.LOG_COLOR || process.env.FORCE_COLOR || 'auto';
const useColor =
  colorEnv === 'always' || colorEnv === '1' || colorEnv === 'true'
    ? true
    : colorEnv === 'never' || colorEnv === '0' || colorEnv === 'false'
      ? false
      : !!(process.stdout.isTTY || process.stderr.isTTY);

const C = useColor
  ? {
      reset: '\x1b[0m',
      red: '\x1b[31m',
      yellow: '\x1b[33m',
      green: '\x1b[32m',
      cyan: '\x1b[36m',
      gray: '\x1b[90m',
      bold: '\x1b[1m',
    }
  : { reset: '', red: '', yellow: '', green: '', cyan: '', gray: '', bold: '' };

const STYLE = {
  error: { color: C.red, stream: process.stderr },
  warn: { color: C.yellow, stream: process.stderr },
  info: { color: C.green, stream: process.stdout },
  debug: { color: C.cyan, stream: process.stdout },
};

function fmt(args) {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function write(level, args) {
  if (LEVELS[level] > threshold) return;
  const { color, stream } = STYLE[level];
  const line = `${C.gray}${new Date().toISOString()}${C.reset} ${color}${C.bold}${level.toUpperCase().padEnd(5)}${C.reset} ${fmt(args)}\n`;
  stream.write(line);
}

const log = {
  level: levelName in LEVELS ? levelName : 'info',
  useColor,
  error: (...args) => write('error', args),
  warn: (...args) => write('warn', args),
  info: (...args) => write('info', args),
  debug: (...args) => write('debug', args),
};

module.exports = log;
