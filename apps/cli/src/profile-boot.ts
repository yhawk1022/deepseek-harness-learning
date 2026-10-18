/**
 * Shared profile boot for every `dsh` surface: resolve the profile, stack its
 * patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
 * own `cordis.patch.yml`, `--patch` overlays, the telemetry switch), mount the
 * tree over the profile's empty root config, and wire fail-loud plus bounded shutdown.
 *
 * App flags are not the launcher's business: the invocation's inner arguments
 * are provided to the tree through `ctx.cmdlineArgs`, where any injected app
 * plugin may read the same immutable snapshot.
 * @module @deepseek-ai/dsh/profile-boot
 */

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  readProfilePatches,
  createRuntimeResolution,
  initProfile,
  installFailLoud,
  loadOverlayPatches,
  loadProfile,
  reportSkippedBundles,
  PluginPackages,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  resolveProfileDir,
  type ProfileContext,
  type Profile,
  type RuntimeResolution,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline, type AppReady } from '@deepseek-ai/dsh-cmdline'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'

const NAME = 'dsh'

/** Launcher-owned readiness signal committed only after boot and host setup succeed. */
function createAppReady(): { service: AppReady; commit(): void } {
  let ready = false
  const listeners = new Set<() => void>()
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    commit() {
      if (ready) return
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

/**
 * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
 * over every profile's own layer. Resolved per call, not at module load:
 * `$DSH_HOME` may be set by the test or launcher after import.
 * @returns the absolute patch-file path.
 */
export function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/** Absolute path of this dsh installation's package.json (both anchors: src/ and lib/ sit one level under apps/cli). */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Root config filename inside a profile directory. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * Replace the named custom profile with a fresh copy of one shipped template.
 * This copies only the template's bundle list; local state from the
 * same-named shipped profile is not read, and no inheritance metadata is
 * persisted. The new profile is assembled in a `.<name>.staging-*` directory
 * under the profiles directory and moved into place; only then is any previous
 * target directory, including its dependencies and user patch, deleted. A
 * failed move restores the previous directory; when restoring also fails, it
 * stays in the staging directory. Shipped profile names, compared without
 * case, are reserved. Concurrent replacements leave one complete copy; each
 * one either succeeds or reports the concurrent recreation.
 * @param name - the profile name to create or replace.
 * @param fromDefaultProfile - shipped profile template to copy.
 * @param home - Harness home containing the profile directory.
 * @throws when the template is unknown, the target name is shipped, another process recreates the target
 *   between the two renames, or a file-system operation fails; a restore failure is an `AggregateError`
 *   that names the staging path holding the previous profile.
 */
export function initializeProfileFromDefault(
  name: string,
  fromDefaultProfile: string,
  home: string = resolveDshHome(),
): void {
  const dir = resolveProfileDir(name, home)
  const template = Object.hasOwn(PROFILE_TEMPLATES, fromDefaultProfile)
    ? PROFILE_TEMPLATES[fromDefaultProfile]
    : undefined
  if (template === undefined) {
    const expected = Object.keys(PROFILE_TEMPLATES).sort().map(value => JSON.stringify(value)).join(', ')
    throw new Error(
      `${NAME}: unknown default profile ${JSON.stringify(fromDefaultProfile)}; expected one of ${expected}`,
    )
  }
  // Case-insensitive file systems resolve a case variant such as `Web` to the shipped directory.
  const shipped = Object.keys(PROFILE_TEMPLATES).find(shippedName => shippedName.toLowerCase() === name.toLowerCase())
  if (shipped !== undefined) {
    throw new Error(
      `${NAME}: profile ${JSON.stringify(name)} names shipped profile ${JSON.stringify(shipped)} and cannot be a custom profile target; `
      + 'omit --from-default-profile to use it',
    )
  }
  mkdirSync(dirname(dir), { recursive: true })
  // The staging directory sits beside the target so both renames stay on one filesystem.
  const staging = mkdtempSync(join(dirname(dir), `.${name}.staging-`))
  const previous = join(staging, 'previous')
  try {
    const fresh = join(staging, 'new', name)
    initProfile(fresh, template.bundles)
    let moved = false
    try {
      renameSync(dir, previous)
      moved = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      renameSync(fresh, dir)
    } catch (error) {
      // Windows reports EPERM instead of EEXIST or ENOTEMPTY, so the target's state identifies a concurrent winner.
      if (existsSync(dir)) {
        // The concurrent replacement supersedes the previous profile.
        rmSync(previous, { recursive: true, force: true })
        throw new Error(`${NAME}: profile ${JSON.stringify(name)} was recreated concurrently at ${dir}`, { cause: error })
      }
      if (moved) {
        try {
          renameSync(previous, dir)
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `${NAME}: profile replacement failed and ${dir} could not be restored from ${previous}`,
          )
        }
      }
      throw error
    }
  } catch (error) {
    // A previous profile that could not be restored stays in staging at the reported path.
    if (!existsSync(previous)) rmSync(staging, { recursive: true, force: true })
    throw error
  }
  try {
    rmSync(staging, { recursive: true, force: true })
  } catch (error) {
    // The replacement is complete; leftover files only occupy space.
    process.stderr.write(`${NAME}: replaced profile ${JSON.stringify(name)} but could not remove ${staging}: ${String(error)}\n`)
  }
}

/**
 * 读取 profile，并将根配置 cordis.yml 重置为 []，让本次启动从空配置应用补丁。
 * Loader 可能把运行中的配置回写到根文件；保留上次结果会让下次启动的 insert 重复添加插件。
 * 仍需保留这个空文件，让 Include 以 profile 目录为基准解析相对路径；配置导出也使用相同基准。
 * @param name - profile 名称。
 * @param userLayer - 为 false 时跳过 cordis.patch.yml，用于只导出默认配置。
 * @param fromDefaultProfile - 提供时先用指定内置模板重建 profile。
 * @returns 已读取的 profile。
 * @throws 模板不存在，或试图用模板重建内置 profile 时抛出错误。
 */
export function prepareProfile(name: string, userLayer = true, fromDefaultProfile?: string): Profile {
  if (fromDefaultProfile !== undefined) initializeProfileFromDefault(name, fromDefaultProfile)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })
  reportSkippedBundles(NAME, profile)
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return profile
}

/** 加载插件前准备好的配置数据和模块位置。 */
interface ComposedProfile {
  profile: Profile
  /** Immutable runtime resolution computed before any plugin imports. */
  resolution: RuntimeResolution
  /** Command-line overlay contents, frozen for this invocation. */
  overlays: PatchOptions[]
}

/**
 * 收集本次启动的配置和模块位置，让后续插件使用同一组配置来源和依赖解析规则。
 * 这里只准备数据；readProfilePatches 排列补丁，boot 应用补丁并加载插件。
 * @param name - profile 名称。
 * @param patchFiles - 按命令行顺序传入的 --patch 文件路径。
 * @param fromDefaultProfile - 提供时先用内置模板替换指定 profile，否则加载已有 profile。
 * @param resolvedProfile - 提供时使用应用已加载的 profile 和安装位置，跳过按名称初始化。
 * @returns profile、模块解析表和已读取的命令行补丁；此时尚未挂载配置中的插件。
 */
async function composeProfile(
  name: string,
  patchFiles: readonly string[],
  fromDefaultProfile?: string,
  resolvedProfile?: ResolvedProfileRuntime,
): Promise<ComposedProfile> {
  const profile = resolvedProfile?.profile ?? prepareProfile(name, true, fromDefaultProfile)
  if (resolvedProfile !== undefined) writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  const resolutionOptions = { installAnchor: resolvedProfile?.installAnchor ?? INSTALL_ANCHOR, profile }
  const resolution = await createRuntimeResolution(resolutionOptions)
  const overlays = patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file)))
  return { profile, resolution, overlays }
}

/** An application-owned profile and its independent installation fallback. */
export interface ResolvedProfileRuntime {
  /** Profile already loaded from the application's own directory. */
  profile: Profile
  /** Absolute package.json path of the application's dsh installation. */
  installAnchor: string
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts. */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot. */
  profile: string
  /** Loaded application profile; bypasses named profile initialization when supplied. */
  resolvedProfile?: ResolvedProfileRuntime | undefined
  /** Shipped template that replaces the named profile before boot. */
  fromDefaultProfile?: string | undefined
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
  args: readonly string[]
  /** Application-owned package runtime, scoped to plugin package operations. */
  packageManager?: ProfileContext['packageManager']
}

/**
 * 按指定 profile 启动应用：准备配置和公共服务，再交给 boot 加载插件并检查启动结果。
 * 公共服务必须先于配置中的插件就绪，插件才能使用一致的环境、模块位置和退出入口。
 * 返回只表示启动流程结束；服务器等插件可以继续维持进程，一次性任务也可能已在启动期间退出。
 * @param options - 启动环境快照、profile 名称、配置覆盖层及应用自身的参数。
 * @returns 启动流程结束后的根上下文和进程关闭控制器；上下文可能已在启动期间被释放。
 * @throws 启动失败时先清理已创建的资源；清理也失败时，将两个错误一并保留。
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  // 插件在启动时就可能请求网络，因此先让代理生效。
  // .env 在 Node 启动后才加载；使用这份环境快照，才能包含 NODE_USE_ENV_PROXY 启动时读不到的配置。
  const disposeProxy = await installProxyFromEnvironment(
    options.environment,
    (message) => { process.stderr.write(`${NAME}: ${message}\n`) },
  )

  // 启动尚未完成也可能收到退出请求；提前保存上下文，才能清理已经启动的插件。
  const app: { current?: Context } = {}
  let disposal: Promise<void> | undefined
  // 插件、信号和启动失败都可能请求清理；缓存 Promise，让这些调用等待同一次清理。
  const dispose = (): Promise<void> => (disposal ??= (async () => {
    const failures: unknown[] = []
    // 插件释放连接等资源时仍可能使用代理，因此最后才撤销代理；前一项失败也要继续清理。
    for (const release of [() => app.current?.fiber.dispose(), disposeProxy]) {
      try { await release() } catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'dsh: profile cleanup failed')
  })())
  try {
    // 一个 profile 的配置可能来自多个组合包和覆盖文件；先读齐这些输入，后面才能合成最终配置。
    const composed = await composeProfile(
      options.profile, options.patchFiles, options.fromDefaultProfile, options.resolvedProfile,
    )
    const appReady = createAppReady()
    const shutdown = createProcessShutdown(dispose)
    // 收到关闭信号后，启动任务仍可能继续返回；记住这次中断，避免随后误发 ready。
    const signalShutdown = new AbortController()
    const interrupt = (code: number): void => {
      signalShutdown.abort()
      shutdown.interrupt(code)
    }
    // 部分插件可能先启动服务器，其余插件还在加载；提前接管信号，才能在这段时间关闭已启动的资源。
    // SIGTERM 按常规停止请求以 0 退出，不表示业务任务完成；SIGINT 按用户中断以 130 退出。
    process.on('SIGTERM', () => { interrupt(0) })
    process.on('SIGINT', () => { interrupt(130) })
    // 未处理的致命错误会先输出诊断，再限时释放插件树，让终端等资源有机会恢复。
    installFailLoud(NAME, process, async () => {
      await app.current?.fiber.dispose()
    })

    const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME)
    // 插件后续重读配置或管理依赖时，需要知道本次使用的目录、覆盖层和包管理器。
    // 应用自带的安装位置优先于 CLI 默认位置，避免从另一份安装中查找依赖。
    const profileContext: ProfileContext = {
      name: options.profile,
      ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
      dir: composed.profile.dir, patchPath: composed.profile.patchPath,
      installAnchor: options.resolvedProfile?.installAnchor ?? INSTALL_ANCHOR,
      startedBundles: composed.profile.layers.map(layer => layer.packageName),
      cwd: process.cwd(), home: resolveDshHome(),
      overlays: composed.overlays, telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
    }
    // 配置中的插件一启动就可能读取环境、导入依赖或请求退出。
    // boot 先执行这个准备回调，再加载配置中的插件，保证它们用到的公共服务已经存在。
    const ctx = await boot(NAME, rootConfig, readProfilePatches(NAME, profileContext, composed.profile), async (hostCtx) => {
      app.current = hostCtx
      hostCtx.provide('profileContext', profileContext)
      // 所有插件读取同一份启动环境，避免各自在不同时间从 process.env 取值。
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
      // 配置里的 name 可能是包名；先安装解析规则，才能找到这个 profile 实际使用的依赖版本。
      await hostCtx.plugin(PluginPackages, {
        resolution: composed.resolution,
      })
      // 通过服务传递应用参数、统一的退出入口和就绪通知，让插件无需各自处理 argv 和进程退出。
      provideCmdline(hostCtx, {
        args: options.args,
        exit: code => void shutdown.shutdown(code),
        ready: appReady.service,
      })
    })
    app.current = ctx
    // 一次性任务可能在启动期间就释放了插件树；收到信号后也可能刚好走到这里。
    // 只向仍在运行的应用发布 ready，避免通知插件向已经关闭的应用继续提交工作。
    if (!signalShutdown.signal.aborted
      && ctx.fiber.state === FiberState.ACTIVE
      && ctx.get('loader') !== undefined) {
      appReady.commit()
    }
    return { ctx, shutdown }
  } catch (error) {
    // 代理安装后的启动失败统一回收已获取的资源；清理错误不能覆盖最初的启动错误。
    try { await dispose() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'dsh: profile startup and cleanup failed')
    }
    throw error
  }
}
