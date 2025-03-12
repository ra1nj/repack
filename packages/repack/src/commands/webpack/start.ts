// @ts-expect-error type-only import
import type { Server } from '@callstack/repack-dev-server';
import type { Configuration, StatsCompilation } from 'webpack';
import packageJson from '../../../package.json';
import {
  ConsoleReporter,
  FileReporter,
  type Reporter,
  composeReporters,
  makeLogEntryFromFastifyLog,
} from '../../logging/index.js';
import type { HMRMessage } from '../../types.js';
import { CLIError } from '../common/cliError.js';
import { makeCompilerConfig } from '../common/config/makeCompilerConfig.js';
import {
  getMimeType,
  parseFileUrl,
  runAdbReverse,
  setupInteractions,
} from '../common/index.js';
import logo from '../common/logo.js';
import { setupEnvironment } from '../common/setupEnvironment.js';
import type { CliConfig, StartArguments } from '../types.js';
import { Compiler } from './Compiler.js';

/**
 * Start command that runs a development server.
 * It runs `@callstack/repack-dev-server` to provide Development Server functionality
 * in development mode.
 *
 * @param _ Original, non-parsed arguments that were provided when running this command.
 * @param cliConfig Configuration object containing platform and project settings.
 * @param args Parsed command line arguments.
 */
export async function start(
  _: string[],
  cliConfig: CliConfig,
  args: StartArguments
) {
  const detectedPlatforms = Object.keys(cliConfig.platforms);

  if (args.platform && !detectedPlatforms.includes(args.platform)) {
    throw new CLIError(`Unrecognized platform: ${args.platform}`);
  }

  const configs = await makeCompilerConfig<Configuration>({
    args: args,
    bundler: 'webpack',
    command: 'start',
    rootDir: cliConfig.root,
    platforms: args.platform ? [args.platform] : detectedPlatforms,
    reactNativePath: cliConfig.reactNativePath,
  });

  // expose selected args as environment variables
  setupEnvironment(args);

  const devServerOptions = configs[0].devServer ?? {};
  const showHttpRequests = args.verbose || args.logRequests;

  const reporter = composeReporters(
    [
      new ConsoleReporter({ asJson: args.json, isVerbose: args.verbose }),
      args.logFile ? new FileReporter({ filename: args.logFile }) : undefined,
    ].filter(Boolean) as Reporter[]
  );

  process.stdout.write(logo(packageJson.version, 'webpack'));

  const compiler = new Compiler(
    args,
    reporter,
    cliConfig.root,
    cliConfig.reactNativePath
  );

  const { createServer } = await import('@callstack/repack-dev-server');
  const { start, stop } = await createServer({
    options: {
      ...devServerOptions,
      rootDir: cliConfig.root,
      logRequests: showHttpRequests,
    },
    delegate: (ctx): Server.Delegate => {
      if (args.interactive) {
        setupInteractions(
          {
            onReload() {
              ctx.broadcastToMessageClients({ method: 'reload' });
            },
            onOpenDevMenu() {
              ctx.broadcastToMessageClients({ method: 'devMenu' });
            },
            onOpenDevTools() {
              fetch(`${ctx.options.url}/open-debugger`, {
                method: 'POST',
              }).catch(() => {
                ctx.log.warn('Failed to open React Native DevTools');
              });
            },
            onAdbReverse() {
              void runAdbReverse({
                port: ctx.options.port,
                logger: ctx.log,
                verbose: true,
              });
            },
          },
          { logger: ctx.log }
        );
      }

      if (args.reversePort) {
        void runAdbReverse({
          logger: ctx.log,
          port: ctx.options.port,
          wait: true,
        });
      }

      compiler.on('watchRun', ({ platform }) => {
        ctx.notifyBuildStart(platform);
        ctx.broadcastToHmrClients<HMRMessage>({
          action: 'compiling',
          body: { name: platform },
        });
        if (platform === 'android') {
          void runAdbReverse({
            port: ctx.options.port,
            logger: ctx.log,
          });
        }
      });

      compiler.on('invalid', ({ platform }) => {
        ctx.notifyBuildStart(platform);
        ctx.broadcastToHmrClients<HMRMessage>({
          action: 'compiling',
          body: { name: platform },
        });
      });

      compiler.on(
        'done',
        ({
          platform,
          stats,
        }: {
          platform: string;
          stats: StatsCompilation;
        }) => {
          ctx.notifyBuildEnd(platform);
          ctx.broadcastToHmrClients<HMRMessage>({
            action: 'hash',
            body: { name: platform, hash: stats.hash },
          });
          ctx.broadcastToHmrClients<HMRMessage>({
            action: 'ok',
            body: { name: platform },
          });
        }
      );

      return {
        compiler: {
          getAsset: (filename, platform, sendProgress) => {
            const parsedUrl = parseFileUrl(filename, 'file:///');
            return compiler.getSource(
              parsedUrl.filename,
              platform,
              sendProgress
            );
          },
          getMimeType: (filename) => getMimeType(filename),
          inferPlatform: (uri) => {
            const { platform } = parseFileUrl(uri, 'file:///');
            return platform;
          },
        },
        symbolicator: {
          getSource: (fileUrl) => {
            const { filename, platform } = parseFileUrl(fileUrl);
            return compiler.getSource(filename, platform);
          },
          getSourceMap: (fileUrl) => {
            const { filename, platform } = parseFileUrl(fileUrl);
            return compiler.getSourceMap(filename, platform);
          },
          shouldIncludeFrame: (frame) => {
            // If the frame points to internal bootstrap/module system logic, skip the code frame.
            return !/webpack[/\\]runtime[/\\].+\s/.test(frame.file);
          },
        },
        messages: {
          getHello: () => 'React Native packager is running',
          getStatus: () => 'packager-status:running',
        },
        logger: {
          onMessage: (log) => {
            const logEntry = makeLogEntryFromFastifyLog(log);
            logEntry.issuer = 'DevServer';
            reporter.process(logEntry);
          },
        },
        api: {
          getPlatforms: () => Promise.resolve(Object.keys(compiler.workers)),
          getAssets: (platform) =>
            Promise.resolve(
              Object.entries(compiler.assetsCache[platform] ?? {}).map(
                ([name, asset]) => ({ name, size: asset.size })
              )
            ),
          getCompilationStats: (platform) =>
            Promise.resolve(compiler.statsCache[platform] ?? null),
        },
      };
    },
  });

  await start();

  return {
    stop: async () => {
      reporter.stop();
      await stop();
    },
  };
}
