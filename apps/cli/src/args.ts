/**
 * `dsh` 命令行的 Commander 适配层。
 *
 * 启动器只解析自身负责的选项：要启动的 profile、额外应用的 patch 覆盖层，以及配置导出选项。
 * 自身选项之后的所有参数原样交给启动的插件树，由其中的应用插件解析各自的选项并输出
 * 自身的 `--help`（参见 `@deepseek-ai/dsh-cmdline`）。因此，启动器选项必须放在前面；
 * 解析器遇到的第一个无法识别的参数及其后续内容，均作为应用参数。
 * 例如，`dsh --profile tui --resume abc` 会携带 `--resume abc` 启动 tui profile，
 * 而 `dsh --profile web -h` 会输出 Web 应用自己的帮助。
 *
 * `dsh <name>` 是 `dsh --profile <name>` 的简写；`plugin` 将参数转发给 pnpm，
 * 用于管理指定 profile 的插件依赖。
 * @module @deepseek-ai/dsh/args
 */

import { Command, CommanderError, InvalidArgumentError } from 'commander'

/** 启动指定 profile，并将本次调用的应用参数交给它。 */
interface ProfileInvocation {
  mode: 'profile'
  profile: string
  /** 用于替换指定 profile 的随附模板。 */
  fromDefaultProfile?: string | undefined
  /** 在 profile 自身配置层之后应用的额外 patch 列表覆盖层，顺序与命令行参数一致。 */
  patches: string[]
  /** 启动器自身选项之后的所有参数，原样交给注入的应用插件。 */
  args: string[]
}

/** 输出组合后的 profile 配置树并退出，不启动 profile。 */
interface DumpConfigInvocation {
  mode: 'dump-config'
  profile: string
  /** 用于替换指定 profile 的随附模板。 */
  fromDefaultProfile?: string | undefined
  /** 省略 profile 的用户配置层和 --patch 覆盖层，仅输出组合包层。 */
  defaultOnly: boolean
  patches: string[]
}

/** 在不挂载 profile 的情况下，输出插件声明的 schema。 */
interface DumpConfigSchemaInvocation {
  mode: 'dump-config-schema'
  profile: string
  /** 用于替换指定 profile 的随附模板。 */
  fromDefaultProfile?: string | undefined
  patches: string[]
}

/** 管理指定 profile 的插件：在该 profile 目录内将 `args` 转发给 pnpm。 */
interface PluginInvocation {
  mode: 'plugin'
  profile: string
  /** 原样转发给 pnpm 的原始参数。 */
  args: string[]
}

/** 解析得到的 `dsh` 调用信息。帮助、版本和错误由 {@link parseDshArgs} 处理并直接退出。 */
export type DshInvocation = ProfileInvocation | DumpConfigInvocation | DumpConfigSchemaInvocation | PluginInvocation

/** profile 启动与配置导出使用的启动器选项。 */
interface BootOptions {
  patch?: string[]
  dumpConfig?: boolean
  dumpDefaultConfig?: boolean
  dumpConfigSchema?: boolean
  fromDefaultProfile?: string
}

/**
 * 每次收集一个值，允许重复使用：`--patch a.yml --patch b.yml`。
 * 不能使用可变数量参数，否则 `--patch` 会把应用参数也收集进去。
 */
const collect = (value: string, previous: string[] = []): string[] => [...previous, value]

function selectProfile(value: string, previous?: string): string {
  if (previous !== undefined) throw new InvalidArgumentError('select a profile only once')
  return value
}

function rejectElectronProfile(program: Command, profile: string): void {
  if (profile.toLowerCase() === 'desktop') {
    program.error('error: profile "desktop" is managed exclusively by the Electron application')
  }
}

/** 启动器自身的帮助文本；各应用分别输出自己的帮助。 */
const HELP_EXAMPLES = `
Examples:
  dsh web                                   boot the web profile (same as: dsh --profile web)
  dsh rescue --from-default-profile web
                                            recreate rescue from the shipped web template, then boot it
  dsh headless "run the tests"              answer one task, print the result, and exit
  dsh tui --patch ./extra.yml               boot a custom profile with one extra overlay
  dsh tui --resume <session>                arguments after the launcher flags reach the app
  dsh web --help                            the web app's own flags and help
  dsh plugin --profile tui add <package>    install a plugin into the tui profile
`

/**
 * 根据启动器选项和剩余的应用参数，解析出启动或配置导出操作。
 * @param program - 这些选项所属的 Commander 命令对象。
 * @param profile - 本次操作使用的 profile。
 * @param options - Commander 收集到的启动器选项。
 * @param args - 剩余的应用参数，顺序与命令行一致。
 * @returns 解析得到的调用信息。
 */
function resolveBoot(program: Command, profile: string, options: BootOptions, args: string[]): DshInvocation {
  const patches = options.patch ?? []
  if (patches.includes('')) program.error('error: --patch needs a path')
  if (options.fromDefaultProfile === '') program.error('error: --from-default-profile needs a name')
  const dumps = [options.dumpConfig, options.dumpDefaultConfig, options.dumpConfigSchema].filter(Boolean)
  if (dumps.length === 0) {
    return { mode: 'profile', profile, fromDefaultProfile: options.fromDefaultProfile, patches, args }
  }
  if (dumps.length > 1) {
    program.error('error: --dump-config, --dump-default-config, and --dump-config-schema are mutually exclusive')
  }
  // 配置导出不启动应用，也不运行应用命令行参数提供器，因此无法反映应用参数对配置的影响。
  // 拒绝应用参数，避免导出的配置树与同一命令实际启动时的配置不一致。
  if (args.length > 0) {
    program.error(`error: config dumps take no app arguments, got ${args.map(argument => JSON.stringify(argument)).join(' ')}`)
  }
  if (options.dumpConfigSchema === true) {
    return { mode: 'dump-config-schema', profile, fromDefaultProfile: options.fromDefaultProfile, patches }
  }
  const defaultOnly = options.dumpDefaultConfig === true
  if (defaultOnly && patches.length > 0) {
    program.error('error: --dump-default-config prints the bundle layers and takes no --patch')
  }
  return { mode: 'dump-config', profile, fromDefaultProfile: options.fromDefaultProfile, defaultOnly, patches }
}

/**
 * 将 argv 解析为一次调用；遇到帮助、版本或错误时，输出相应信息并直接退出。
 * @param argv - Node 可执行文件和入口脚本之后的命令行参数。
 * @param version - `--version` 输出的版本字符串。
 * @param manageDesktopProfile - 是否允许 Desktop 安装包提供的命令管理其保留 profile 的插件。
 * @returns 解析得到的调用信息。
 */
export function parseDshArgs(argv: readonly string[], version: string, manageDesktopProfile = false): DshInvocation {
  const first = argv[0]
  let resolved: DshInvocation | undefined
  // 下方 action 回调会引用 program；显式标注类型，避免链式调用中的类型推断形成循环。
  const program: Command = new Command()
  program
    .name('dsh')
    .version(version, '-V, --version', 'output the version number')
    .usage('[--profile] <name> [options] [app-args...]\n       dsh plugin --profile <name> <pnpm-args...>')
    .description('dsh: boot a DeepSeek Harness profile — an ordered stack of plugin-bundle patch layers under your own overrides.')
    .addHelpText('after', HELP_EXAMPLES)
    .exitOverride()
    // 启动器选项必须位于应用参数之前；从第一个无法识别的参数起，所有内容都交给应用，
    // 包括 -h。未指定 profile 的 `dsh -h` 仍输出启动器帮助，具体处理见下方 action。
    .helpOption(false)
    .helpCommand(false)
    .allowUnknownOption()
    .passThroughOptions()
    .enablePositionalOptions()
    .argument('[args...]', 'arguments for the booted profile\'s app (see: dsh --profile <name> --help)')
    .option('--profile <name>', 'the profile under $DSH_HOME/profiles to boot', selectProfile)
    .option('--from-default-profile <name>', 'replace a custom profile with a fresh copy of a shipped profile template')
    .option('--patch <path>', 'extra patch-list overlay applied after the profile layer (repeatable)', collect)
    .option('--dump-config', 'print the composed profile tree and exit')
    .option('--dump-config-schema', 'print JSON Schema for profile entries and patches without mounting')
    .option('--dump-default-config', 'print the profile tree without its user layer or --patch overlays and exit')
    .action((args: string[], options: BootOptions & { profile?: string }) => {
      // 未指定 profile 时，无法将 -h 交给应用，因此 `dsh -h` 输出启动器自己的帮助。
      if (options.profile === undefined) {
        if (args.some(argument => argument === '-h' || argument === '--help')) program.help()
        program.error('error: --profile <name> is required')
      }
      const profile = options.profile
      if (profile === '') program.error('error: --profile needs a name')
      rejectElectronProfile(program, profile)
      resolved = resolveBoot(program, profile, options, args)
    })

  if (first === 'plugin') {
    const plugin = program.command('plugin').description('manage a profile\'s plugins by forwarding the remaining arguments to pnpm in the profile directory')
    plugin
      // Commander 会将启动器禁用帮助选项的设置继承给子命令。
      // 此处恢复 plugin 自身的帮助，并在遇到要转发给 pnpm 的参数时停止解析选项。
      .helpOption('-h, --help', 'show this help')
      .passThroughOptions()
      .requiredOption('--profile <name>', 'the profile whose plugins to manage (initialized on first use)', selectProfile)
      .allowUnknownOption()
      .argument('[args...]', 'pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)')
      .action((args: string[], options: { profile: string }) => {
        if (options.profile === '') program.error('error: --profile needs a name')
        if (!manageDesktopProfile) rejectElectronProfile(plugin, options.profile)
        if (args.length === 0) program.error('error: plugin needs pnpm arguments to forward (e.g. add <package>)')
        resolved = { mode: 'plugin', profile: options.profile.toLowerCase() === 'desktop' ? 'desktop' : options.profile, args }
      })
  }

  try {
    const expanded = first !== undefined && !first.startsWith('-') && first !== 'plugin'
      ? ['--profile', ...argv]
      : argv
    program.parse(expanded, { from: 'user' })
  } catch (error) {
    return process.exit(error instanceof CommanderError ? error.exitCode : 1)
  }
  /* v8 ignore next -- action 会设置解析结果，否则 Commander 会抛出异常 */
  if (resolved === undefined) throw new Error('dsh: no invocation resolved')
  return resolved
}
