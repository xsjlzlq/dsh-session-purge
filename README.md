# dsh-session-purge

给 DeepSeek Harness 侧边栏会话加一个「真删除」右键菜单，外加「打开工作目录」和
「隐藏未分组会话」。

Harness 自带只有 archive / unarchive：归档之后会话日志目录、投影缓存文档和
workspace 记账条目全都留在磁盘上。这个 bundle 补上缺失的那一步。

## 右键菜单

在侧边栏会话行上右键：

| 菜单项 | 作用 |
| --- | --- |
| 删除会话 | 彻底删除，**不归档**：日志、投影缓存、记账、内存条目全部移除 |
| 打开文件夹 | 在系统文件管理器中打开该会话的当前工作目录 |

在「未分组」分组标题上右键：

| 菜单项 | 作用 |
| --- | --- |
| 隐藏未分组会话 | 能归位的归位到所属工作区，归位不了的归档隐藏 |

## 删除流程

删除是永久的，不经过 archive。顺序为「先磁盘、后记账、最后内存」：

1. 会话在官方 `workspace/session-activity` 接缝上仍报告活动时拒绝删除（运行中的
   turn、活跃 job、Host 任务）；
2. 删掉日志目录 `$DSH_HOME/sessions/<project>/<session-id>/` 与投影缓存文档；
   这一步失败会直接返回，记账与侧边栏行保持不变，不会出现半删除状态；
3. 从每个 workspace 记录里摘掉该 id —— 走 registry 自己的 `detachSession()`，
   因此 change frame 由官方机制发出，侧边栏行实时消失；同时清掉 archive / pin
   残留，让该 id 离开两个全局集合；
4. 清掉内存里的 header 索引，并触发 `sessionQuery.listSessions()` 让 SQLite 索引
   reconcile；
5. **驱逐内存条目**：`sessionQuery.listSessions()` 会把 `sessions.list()` 以 live
   优先级合并进结果，所以只删磁盘的话，会话仍会被列出——而它的记账已经没了，于是
   正好落进「未分组」。因此这里会先 `cancel` 掉 Agent（避免空闲驱动继续往已删除的
   日志追加），再把 id 从 `agents.store` 与 `sessions.store` 两个 Map 中移除。

完成之后该会话既不在原工作区、也不会出现在「未分组」，等同于隐身状态，重启后同样
不会残留。

只是「被加载」不算活动：在侧边栏打开会话会发布 live Session 并恢复 Agent，但日志
writer 每批只开/追加/关一次句柄，空闲会话没有可争用的句柄。

## 隐藏未分组

「未分组」不是存储位置，而是「没有任何 Workspace 记账」的会话在侧边栏的呈现。修复
分两级，优先归位：

1. **归位** —— cwd 的 `realpath` 与某个 Workspace 的 `path` 相等时，用
   `attachSession()` 把它放回该工作区，会话保持可用；
2. **归档** —— 找不到匹配工作区（或 cwd 无法校验）的，放进 registry 的归档集合，
   从所有分组过滤掉，日志不动；
3. 已经彻底不存在的 id 跳过并记录原因，不会让整批失败。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半边：删除 / 打开目录 / 隐藏未分组，一条 loopback-only 路由 |
| `client.js` | Client 半边：右键菜单与「未分组」分组菜单 |
| `cordis.patch.yml` | bundle patch，插入一条 `session-purge` 行 |
| `locale/{zh,en}.json` | 插件展示信息 |
| `icon.svg` | 插件图标 |

Host 与 Client 同包：纯 JS 本地 bundle 没有 typert schema，因此没有 `@Remote`
命名空间，两侧通过一条 loopback-only HTTP 路由通信。

`client.js` 整体包在 IIFE 里、每个顶层语句以分号收尾：多个 bundle 会被拼成同一个
wire batch，泄漏声明或缺少结尾分号会让整批加载失败（表现为页面白屏、启动日志报
`@local/dsh-session-purge: import failed`）。

## 安装

```bash
# 指向本目录安装
dsh plugin install /path/to/dsh-session-purge
```

或在 Harness 的 bundle 目录里 clone 之后用 `plugin_manager` 安装。
`package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`，注入
`@deepseek-ai/dsh-client-ui-workspace`。Host 侧改动 reload 插件即可，`client.js`
改动需要刷新页面。

## 许可

未声明。
