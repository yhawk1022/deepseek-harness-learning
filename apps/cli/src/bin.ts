#!/usr/bin/env node
/**
 * dsh 的命令行入口。
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- 构建后可执行文件的验收测试覆盖此入口的自动执行与命令分发。 */

import { getDshRuntimeVersion, loadLayeredEnv, StartupError } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parseDshArgs } from './args.ts'
import { reportStartupFailure } from './startup-diagnostics.ts'
import type { RunProfileOptions } from './profile-boot.ts'

/**
 * 由打包后的 CLI 启动器提供、归安装包管理的选项；允许传入空对象 `{}`。
 *
 * `Pick` 从 {@link RunProfileOptions} 中仅选取可选字段 `packageManager`，
 * 再通过交叉类型 `&` 添加独立的可选标志 `manageDesktopProfile`。
 * 如果提供 `packageManager`，其内部必须包含以下三个只读字段：
 * - `command: string`：用于运行 pnpm 的可执行文件，例如安装包内置的 Node 运行时。
 * - `args: readonly string[]`：参数前缀，例如 pnpm 脚本路径，置于每次包操作的参数之前。
 * - `env: Readonly<Record<string, string>>`：包操作使用的环境变量覆盖项，键和值均为字符串。
 *
 * 该运行环境仅用于插件包操作，包括已启动的配置档案（profile）发起的包操作，
 * 不改变智能体 shell 的环境。
 */
export type RunCliOptions = Pick<RunProfileOptions, 'packageManager'> & {
  /**
   * 允许 `dsh plugin --profile desktop ...` 管理由桌面应用初始化的配置档案。
   * 仅供桌面应用的已安装启动器启用；省略或设为 `false` 时，插件命令拒绝访问该档案。
   * 此标志不允许通过 `dsh --profile desktop` 启动桌面应用。
   */
  manageDesktopProfile?: boolean
}

/**
 * 运行 dsh 对外提供的命令行接口。
 * @param options - 安装包提供的包管理运行环境及桌面应用配置档案的插件管理权限。
 * @returns 在所选命令模式结束时完成的 Promise。
 */
export async function runCli(options: RunCliOptions = {}): Promise<void> {
  // 使用当前安装的 Harness 版本响应命令行的 --version。
  const version = getDshRuntimeVersion()
  // Desktop 档案管理权限只交给参数解析器；其余安装包选项传给 profile 启动器。
  const { manageDesktopProfile, ...profileOptions } = options
  // argv 的前两项是 Node 可执行文件和入口脚本。帮助、版本和参数错误由解析器直接输出并退出；
  // 正常返回时，mode 确定后续可用的 profile、patch 和应用参数字段。
  const invocation = parseDshArgs(process.argv.slice(2), version, manageDesktopProfile)

  // 指定 profile 且未选择插件管理或配置导出时，mode 默认为 'profile'。
  // 未指定 profile 时，参数解析器会报错退出，不会进入此 switch。
  // 以下命令分别选择对应分支：
  // - pnpm run dsh web：profile，调用 runProfile() 启动 Web profile 的插件树。
  // - pnpm run dsh plugin --profile web add <包名>：plugin，调用 runPlugin() 管理插件依赖。
  // - pnpm run dsh web --dump-config：dump-config，调用 runDumpConfig() 输出组合后的 YAML 配置。
  // - pnpm run dsh web --dump-default-config：同为 dump-config，defaultOnly 为 true，仅输出组合包层。
  // - pnpm run dsh web --dump-config-schema：dump-config-schema，输出配置字段、类型和校验规则的 JSON Schema。
  // 两种配置导出模式均不启动插件树；default 分支对未处理的 mode 报错。
  switch (invocation.mode) {
    case 'profile': {
      // 例如执行 pnpm run dsh web 时，['web'] 会展开为 ['--profile', 'web']，invocation 为：
      // {
      //   mode: 'profile',
      //   profile: 'web',
      //   fromDefaultProfile: undefined,
      //   patches: [],
      //   args: [],
      // }
      // 因此进入此分支，由 runProfile() 启动 Web profile。
      // 仅在选择此模式后加载启动器；应用参数由 profile 内的插件解释。
      const { runProfile } = await import('./profile-boot.ts')
      try {
        await runProfile({
          // 在挂载插件前冻结分层环境，供本次启动统一使用。
          environment: loadLayeredEnv('dsh'),
          profile: invocation.profile,
          // 显式指定模板时，先用该模板重建自定义 profile。
          fromDefaultProfile: invocation.fromDefaultProfile,
          // 命令行 overlay 保留声明顺序；args 原样交给应用插件。
          patchFiles: invocation.patches,
          args: invocation.args,
          ...profileOptions,
        })
      } catch (error) {
        // 仅在这里处理可生成完整启动诊断的 StartupError；其他异常继续向调用方传播。
        if (!(error instanceof StartupError)) throw error
        // 等待诊断保存与终端输出完成后再以失败状态退出。
        await reportStartupFailure(error, { home: resolveDshHome(), version, profile: invocation.profile })
        process.exit(1)
      }
      break
    }
    case 'plugin': {
      // 在指定 profile 中执行插件管理命令，并沿用安装包提供的包管理运行环境。
      // 命令返回的退出码直接作为 CLI 进程退出码。
      const { runPlugin } = await import('./plugin.ts')
      process.exit(await runPlugin(invocation.profile, invocation.args, options.packageManager))
      break
    }
    case 'dump-config': {
      // 导出组合后的配置，不挂载插件树；defaultOnly 决定是否只保留组合包层。
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(
        invocation.profile,
        invocation.defaultOnly,
        invocation.patches,
        invocation.fromDefaultProfile,
      )
      break
    }
    case 'dump-config-schema': {
      // 导入插件的 schema 声明并导出 JSON Schema，不挂载插件树；模块顶层代码仍可能执行。
      const { runDumpConfigSchema } = await import('./dump-config-schema.ts')
      await runDumpConfigSchema(invocation.profile, invocation.patches, invocation.fromDefaultProfile)
      break
    }
    default:
      // 编译期检查所有 mode 均已处理；若增加新模式却遗漏分支，此处会报类型错误。
      invocation satisfies never
      throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

if (import.meta.main) {
  await runCli()
}
