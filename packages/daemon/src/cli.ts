#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolveConfigPath, loadConfig } from './config.js';
import { Logger } from './logger.js';
import { Daemon } from './daemon.js';

const USAGE = `Usage: gsd-daemon [options]

Options:
  --config <path>  Path to YAML config file (default: ~/.gsd/daemon.yaml)
  --verbose        Print log entries to stderr in addition to the log file
  --help           Show this help message and exit
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const configPath = resolveConfigPath(values.config);
  const config = loadConfig(configPath);

  const logger = new Logger({
    filePath: config.log.file,
    level: config.log.level,
    verbose: values.verbose,
  });

  const daemon = new Daemon(config, logger);
  await daemon.start();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`gsd-daemon: fatal: ${msg}\n`);
  process.exit(1);
});
