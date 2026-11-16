/**
 * Host half of the session-purge bundle.
 *
 * The shipped Harness only exposes archive/unarchive for a Session: the log
 * directory (`$DSH_HOME/sessions/<project>/<session-id>/`), the projection
 * cache document and the workspace accounting entry all survive an archive.
 * This plugin owns the missing "delete for real" operation and exposes it to
 * its own Client half over one loopback-only HTTP route, because a plain-JS
 * local bundle has no typert schema and therefore no `@Remote` namespace.
 *
 * Deletion is permanent — it never archives. The steps run disk first, then
 * accounting, so a failure leaves the row and the accounting whole:
 *   1. refuse while the Session still reports activity on the official
 *      `workspace/session-activity` seam — a running turn, a live job, or a
 *      Host task;
 *   2. remove the log directory and the projection cache from disk;
 *   3. detach the id from every workspace record — that domain write emits a
 *      change frame, which is what makes the sidebar row disappear live — and
 *      clear any archive/pin residue so the id leaves both global sets;
 *   4. forget the id in the registry's in-memory header index and reconcile the
 *      disposable search index, so later existence checks and `listSessions`
 *      agree with the disk.
 *
 * One case cannot be finished from a plugin: a Session still live in this
 * process is merged into `listSessions` with live precedence, and the detach
 * disposer that would drop it belongs to the agent lifecycle, which exposes no
 * "remove" entry point. Such a delete still removes every durable trace and
 * reports a warning that a restart is needed for the row to leave the list.
 *
 * Being merely loaded is not activity: opening a Session in the sidebar
 * publishes a live Session and resumes its Agent, but the log writer opens,
 * appends and closes one handle per batch, so an idle Session has no open
 * handle to fight over.
 *
 * @module @local/dsh-session-purge
 */
import { spawn } from 'node:child_process'
import { readdir, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Loader row name; matches the package name's last segment. */
export const name = 'session-purge'

/** Both services are mandatory: without them the operation cannot be complete. */
export const inject = ['webServer', 'workspaceRegistry']

/** One exact route, namespaced so it cannot collide with a shipped path. */
const ROUTE = '/dsh-session-purge/api'

/** A Session id is a path segment; anything else never reaches the filesystem. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/

const MAX_BODY_BYTES = 64 * 1024

/** Resolve the Harness home the same way the shipped home-paths package does. */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return join(homedir(), '.dsh')
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Loopback clients are always accepted: the desktop shell may present an
 * `app://` or `null` Origin while still being the local page.
 */
function requestAllowed(req) {
  const remote = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (loopback) return true
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Locate the on-disk log directory of one Session, if it was ever materialized. */
async function locateSessionDir(home, sessionId) {
  const sessionsRoot = join(home, 'sessions')
  let projects = []
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of projects) {
    if (!entry.isDirectory()) continue
    const dir = join(sessionsRoot, entry.name, sessionId)
    try {
      const info = await stat(dir)
      if (info.isDirectory()) return dir
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Resolve the working directory a Session currently uses.
 *
 * The `workingDirectory` service owns the effective directory of a live Session
 * and reflects a directory the user switched to mid-Session, which the immutable
 * header no longer carries. For a Session that is not loaded, the header is the
 * only authority: the workspace registry keeps a header index and the search
 * index projects every persisted header.
 */
async function resolveSessionCwd(ctx, sessionId) {
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  const live = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined

  const workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
  if (live !== undefined && workingDirectory && typeof workingDirectory.get === 'function') {
    try {
      const current = workingDirectory.get(live)
      if (typeof current === 'string' && current.length > 0) return current
    } catch {
      /* fall through to the header */
    }
  }

  const liveCwd = live && live.header ? live.header.cwd : undefined
  if (typeof liveCwd === 'string' && liveCwd.length > 0) return liveCwd

  const registry = ctx.workspaceRegistry
  const indexed = registry && registry.headers && typeof registry.headers.get === 'function'
    ? registry.headers.get(sessionId)
    : undefined
  const indexedCwd = indexed ? indexed.cwd : undefined
  if (typeof indexedCwd === 'string' && indexedCwd.length > 0) return indexedCwd

  const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
  if (query && typeof query.listSessions === 'function') {
    try {
      const records = await query.listSessions()
      for (const record of records) {
        if (!record || !record.header || record.header.id !== sessionId) continue
        const cwd = record.header.cwd
        if (typeof cwd === 'string' && cwd.length > 0) return cwd
      }
    } catch {
      /* fall through to "unknown" */
    }
  }
  return undefined
}

/** Hand one directory to the platform file manager; resolves once it launched. */
function revealDirectory(dir) {
  const [command, args] = process.platform === 'win32'
    ? ['explorer.exe', [dir]]
    : process.platform === 'darwin'
      ? ['open', [dir]]
      : ['xdg-open', [dir]]
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** Remove the log directory of one Session across every project bucket. */
async function removeSessionLog(home, sessionId, report) {
  const sessionsRoot = join(home, 'sessions')
  let projects = []
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    report.warnings.push(`no sessions directory at ${sessionsRoot}`)
  }
  for (const entry of projects) {
    if (!entry.isDirectory()) continue
    const dir = join(sessionsRoot, entry.name, sessionId)
    let info
    try {
      info = await stat(dir)
    } catch {
      continue
    }
    if (!info.isDirectory()) continue
    try {
      await rm(dir, { recursive: true, force: true })
      report.removed.push(dir)
    } catch (error) {
      report.errors.push(`remove ${dir}: ${error && error.message ? error.message : String(error)}`)
    }
  }
}

/** Remove the projection cache document of one Session. */
async function removeProjectionCache(home, sessionId, report) {
  const cache = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  try {
    await stat(cache)
  } catch {
    return
  }
  try {
    await rm(cache, { force: true })
    report.removed.push(cache)
  } catch (error) {
    report.errors.push(`remove ${cache}: ${error && error.message ? error.message : String(error)}`)
  }
}

/**
 * Detach the id from every workspace record. `WorkspaceEntity.detachSession`
 * is the registry's own single write path, so the domain change frame that the
 * Client follows is produced by the shipped machinery rather than by us.
 *
 * This only removes the Workspace accounting. The archive flag set earlier by
 * `archiveForRemoval` is what keeps the row out of the default sidebar view, so
 * it must be preserved here — never unarchive.
 */
async function detachFromWorkspaces(registry, sessionId, report) {
  const entities = registry && registry.entities
  if (entities && typeof entities.values === 'function') {
    for (const entity of [...entities.values()]) {
      const ids = entity && entity.record ? entity.record.sessionIds : undefined
      if (!Array.isArray(ids) || !ids.includes(sessionId)) continue
      try {
        await entity.detachSession(sessionId)
        report.workspaces.push(String(entity.id))
      } catch (error) {
        report.errors.push(`detach from workspace ${String(entity.id)}: ${error && error.message ? error.message : String(error)}`)
      }
    }
  } else {
    report.warnings.push('workspace registry exposes no entity map')
  }

  // Permanent deletion also drops any archive/pin residue so the id never
  // lingers in either registry-global set.
  try {
    const archived = registry && registry.archivedSessionIds
    if (Array.isArray(archived) && archived.includes(sessionId)) await registry.unarchiveSession(sessionId)
  } catch (error) {
    report.errors.push(`unarchive: ${error && error.message ? error.message : String(error)}`)
  }
  try {
    const pinned = registry && registry.pinnedSessionIds
    if (Array.isArray(pinned) && pinned.includes(sessionId)) await registry.unpinSession(sessionId)
  } catch (error) {
    report.errors.push(`unpin: ${error && error.message ? error.message : String(error)}`)
  }
}

/**
 * Evict a Session that is still resident in this process.
 *
 * `sessionQuery.listSessions()` merges `sessions.list()` over the persisted
 * records with live precedence, so a Session whose log was just deleted still
 * shows up — and therefore lands in Ungrouped once its Workspace accounting is
 * gone. Both registries keep their entries in a plain `Map`, so removing the id
 * here is what makes the row disappear immediately while leaving nothing behind
 * for the next start.
 *
 * The Agent is cancelled first so an idle driver cannot keep appending to a log
 * that no longer exists.
 */
function evictResident(ctx, sessionId, report) {
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  try {
    const entry = agents && agents.store && typeof agents.store.get === 'function'
      ? agents.store.get(sessionId)
      : undefined
    const agent = entry ? entry.agent : undefined
    if (agent && typeof agent.cancel === 'function') agent.cancel({ kind: 'disposed' }, { keepInbox: true })
  } catch (error) {
    report.warnings.push(`cancel: ${error && error.message ? error.message : String(error)}`)
  }

  try {
    if (agents && agents.store && typeof agents.store.delete === 'function' && agents.store.delete(sessionId)) {
      report.evicted.push('agent')
    }
  } catch (error) {
    report.warnings.push(`evict agent: ${error && error.message ? error.message : String(error)}`)
  }

  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  try {
    if (sessions && sessions.store && typeof sessions.store.delete === 'function' && sessions.store.delete(sessionId)) {
      report.evicted.push('session')
    }
  } catch (error) {
    report.warnings.push(`evict session: ${error && error.message ? error.message : String(error)}`)
  }
}

/**
 * Drop the id from the registry's in-memory header index. Without this, a later
 * `sessionKnown()` still answers true for a Session whose log is gone.
 */
function forgetHeaderIndex(registry, sessionId) {
  for (const key of ['headers', 'sessionPaths', 'missingSessionPaths', 'invalidSessionPaths']) {
    try {
      const index = registry ? registry[key] : undefined
      if (index && typeof index.delete === 'function') index.delete(sessionId)
    } catch {
      /* a private field of another package: never fatal */
    }
  }
}

/** Human wording for the activity families the shipped seams report. */
const ACTIVITY_LABELS = {
  turn: '正在执行回合',
  job: '有后台任务在跑',
  schedule: '有定时任务',
}

/**
 * Ask the official archive-admission seam whether the Session is doing work.
 * A missing seam answers with an empty list (nothing is running), while a
 * throwing seam is reported as unknown instead of being read as "idle".
 */
async function readActivity(ctx, sessionId) {
  try {
    const entries = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    return { entries: Array.isArray(entries) ? entries : [] }
  } catch (error) {
    return { failure: error && error.message ? error.message : String(error) }
  }
}

async function deleteSession(ctx, sessionId) {
  const report = { removed: [], workspaces: [], errors: [], warnings: [], evicted: [] }
  if (!SAFE_SESSION_ID.test(sessionId)) {
    return { ok: false, error: `会话 id 不合法: ${sessionId}` }
  }

  const activity = await readActivity(ctx, sessionId)
  if (activity.failure !== undefined) {
    return { ok: false, error: `无法确认该会话是否在运行（${activity.failure}），已取消删除。` }
  }
  if (activity.entries.length > 0) {
    const kinds = [...new Set(activity.entries.map((entry) => String(entry && entry.kind ? entry.kind : 'activity')))]
    const labels = kinds.map((kind) => ACTIVITY_LABELS[kind] || kind)
    return {
      ok: false,
      activity: kinds,
      error: `该会话仍在运行（${labels.join('、')}），先在会话里停止它，或切换到别的会话后再删除。`,
    }
  }

  const home = dshHome()
  const dir = await locateSessionDir(home, sessionId)

  // Permanent deletion — no archive step. Disk files go first: a failure here
  // leaves the accounting whole, so nothing ends up half-deleted.
  if (dir !== undefined) {
    await removeSessionLog(home, sessionId, report)
    await removeProjectionCache(home, sessionId, report)
    if (report.errors.length > 0) {
      return { ok: false, error: `删除会话文件失败：${report.errors.join('; ')}`, report }
    }
  }

  // Accounting: drop the id from every Workspace, clear archive/pin residue, and
  // forget the header index so later existence checks agree with the disk.
  await detachFromWorkspaces(ctx.workspaceRegistry, sessionId, report)
  forgetHeaderIndex(ctx.workspaceRegistry, sessionId)
  if (report.errors.length > 0) {
    return { ok: false, error: `会话文件已删除，但侧栏条目更新失败：${report.errors.join('; ')}`, report }
  }

  // Evict the resident entries. `listSessions` prefers live records, so the row
  // would otherwise survive the deleted log and reappear under Ungrouped once its
  // Workspace accounting is gone. Evicting leaves nothing for the next start.
  evictResident(ctx, sessionId, report)

  // Reconcile the disposable search index so a deleted persisted Session drops
  // out of `listSessions` on the next read instead of lingering as a cold row.
  try {
    const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
    if (query && typeof query.listSessions === 'function') await query.listSessions()
  } catch {
    /* the index reconciles on its own next read */
  }

  return { ok: true, report }
}

/**
 * Hide every Session in the sidebar's Ungrouped bucket.
 *
 * Ungrouped is not a stored place: it is what the sidebar shows for a Session no
 * Workspace accounts for. Two repairs are possible, and re-homing is preferred
 * because it keeps the Session usable and reachable:
 *
 *   1. **re-home** — a Workspace whose canonical path equals the Session's cwd
 *      already owns that directory, so `attachSession` puts the row back where
 *      it belongs. This covers the common case of a row that lost its
 *      accounting entry.
 *   2. **archive** — a Session with no matching Workspace (or none whose cwd can
 *      be validated) is put in the registry's archive set, which filters it out
 *      of every grouping surface without touching its log.
 *
 * Archiving needs the id to exist, so a Session that has vanished from both the
 * store and persistence is skipped with a warning instead of failing the batch.
 */
async function hideUngrouped(ctx) {
  const registry = ctx.workspaceRegistry
  const strays = await collectStrays(ctx)
  const result = { ok: true, rehomed: [], archived: [], skipped: [], errors: [] }

  const entities = registry && registry.entities ? [...registry.entities.values()] : []
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined

  for (const stray of strays) {
    const sessionId = stray.sessionId
    const cwd = await resolveSessionCwd(ctx, sessionId)

    let target
    if (typeof cwd === 'string' && cwd.length > 0) {
      const canonical = await canonicalDir(cwd)
      if (canonical !== undefined) {
        target = entities.find((entity) => entity && entity.record && entity.record.path === canonical)
      }
    }

    if (target !== undefined) {
      try {
        await target.attachSession(sessionId)
        result.rehomed.push({ sessionId, workspaceId: String(target.id) })
        continue
      } catch (error) {
        result.errors.push(`re-home ${sessionId}: ${error && error.message ? error.message : String(error)}`)
      }
    }

    const live = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) !== undefined : false
    const onDisk = (await locateSessionDir(dshHome(), sessionId)) !== undefined
    if (!live && !onDisk) {
      result.skipped.push({ sessionId, reason: '会话已不存在于内存与磁盘，无法归档' })
      continue
    }

    try {
      if (!registry.archivedSessionIds.includes(sessionId)) {
        await registry.archiveSession(sessionId, { stopActivity: true })
      }
      result.archived.push(sessionId)
    } catch (error) {
      result.errors.push(`archive ${sessionId}: ${error && error.message ? error.message : String(error)}`)
    }
  }

  result.remaining = (await collectStrays(ctx)).map((entry) => entry.sessionId)
  result.ok = result.errors.length === 0
  return result
}

/** Canonical directory for `path`, or `undefined` when it is not a directory. */
async function canonicalDir(path) {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) return undefined
  } catch {
    return undefined
  }
  try {
    // The registry stamps its records with an `fs.realpath` canon, so a match
    // must compare the same spelling.
    return await realpath(path)
  } catch {
    return undefined
  }
}

/** Sessions the sidebar shows under Ungrouped: unaccounted for and not archived. */
async function collectStrays(ctx) {
  const registry = ctx.workspaceRegistry
  const accounted = new Set()
  const entities = registry && registry.entities
  if (entities && typeof entities.values === 'function') {
    for (const entity of entities.values()) {
      for (const id of entity.record ? entity.record.sessionIds : []) accounted.add(id)
    }
  }
  const archived = new Set(registry && Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : [])
  const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
  let records = []
  if (query && typeof query.listSessions === 'function') records = await query.listSessions()
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  const home = dshHome()
  const strays = []
  for (const record of records) {
    const sessionId = record && record.header ? record.header.id : record && record.sessionId
    if (typeof sessionId !== 'string' || accounted.has(sessionId) || archived.has(sessionId)) continue
    strays.push({
      sessionId,
      live: sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) !== undefined : false,
      onDisk: (await locateSessionDir(home, sessionId)) !== undefined,
      cwd: record && record.header ? record.header.cwd : undefined,
      createdAt: record && record.header ? record.header.createdAt : undefined,
    })
  }
  return strays
}

/**
 * Report the Sessions a user can actually see in the sidebar's Ungrouped bucket:
 * no Workspace accounts for them and they are not archived. Each entry carries
 * the facts that decide whether a delete can be seen — on disk, live in this
 * Host, and the cwd the row would open.
 */
async function listStrays(ctx) {
  const registry = ctx.workspaceRegistry
  const strays = await collectStrays(ctx)
  const archival = Array.isArray(registry && registry.archivedSessionIds) ? registry.archivedSessionIds.length : 0
  const accounted = new Set()
  const entities = registry && registry.entities
  if (entities && typeof entities.values === 'function') {
    for (const entity of entities.values()) {
      for (const id of entity.record ? entity.record.sessionIds : []) accounted.add(id)
    }
  }
  return {
    ok: true,
    accounted: accounted.size,
    archivedHidden: archival,
    strays,
  }
}

/**
 * Host plugin entry: claim one exact route for the Client half.
 * @param ctx - plugin context carrying `webServer` and `workspaceRegistry`.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      if (!requestAllowed(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
        return
      }
      let request
      try {
        const raw = await readBody(req)
        request = raw.trim().length > 0 ? JSON.parse(raw) : {}
      } catch (error) {
        sendJson(res, 400, { ok: false, error: `bad request body: ${error && error.message ? error.message : String(error)}` })
        return
      }
      try {
        if (request.op === 'ping') {
          sendJson(res, 200, { ok: true, home: dshHome() })
          return
        }
        if (request.op === 'strays') {
          sendJson(res, 200, await listStrays(ctx))
          return
        }
        if (request.op === 'hide-ungrouped') {
          const result = await hideUngrouped(ctx)
          sendJson(res, result.ok ? 200 : 500, result)
          return
        }
        if (request.op === 'reveal') {
          const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
          if (sessionId.length === 0) {
            sendJson(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          if (!SAFE_SESSION_ID.test(sessionId)) {
            sendJson(res, 409, { ok: false, error: `会话 id 不合法: ${sessionId}` })
            return
          }
          // The Session's working directory is the target: the file manager opens
          // *inside* that folder, never at its parent.
          const target = await resolveSessionCwd(ctx, sessionId)
          if (target === undefined) {
            sendJson(res, 404, { ok: false, error: '该会话没有记录工作目录。' })
            return
          }
          let info
          try {
            info = await stat(target)
          } catch {
            sendJson(res, 404, { ok: false, error: `文件夹已不存在：${target}` })
            return
          }
          if (!info.isDirectory()) {
            sendJson(res, 409, { ok: false, error: `不是文件夹：${target}` })
            return
          }
          await revealDirectory(target)
          sendJson(res, 200, { ok: true, path: target, kind: 'workspace' })
          return
        }
        if (request.op === 'delete') {
          const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
          if (sessionId.length === 0) {
            sendJson(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          const result = await deleteSession(ctx, sessionId)
          sendJson(res, result.ok ? 200 : 409, result)
          return
        }
        sendJson(res, 400, { ok: false, error: `unknown op: ${String(request.op)}` })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
      }
    },
  }), 'session-purge: route')
}
