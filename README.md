# dsh-session-purge

给 DeepSeek Harness 侧边栏会话加一个「真删除」右键菜单。

Harness 自带只有 archive / unarchive：归档之后会话日志目录、投影缓存文档和
workspace 记账条目全都留在磁盘上。这个 bundle 补上缺失的那一步。

## 行为

删除顺序是「先磁盘、后记账」：

1. 会话在官方 `workspace/session-activity` 上仍报告活动时拒绝删除（运行中的
   turn、活跃 job、Host 任务）；
2. 删掉日志目录 `$DSH_HOME/sessions/<project>/<session-id>/` 与投影缓存；
3. 从每个 workspace 记录里摘掉该 id —— 这一步会发 change frame，侧边栏行实时消失；
4. 从 registry 全局的 archive / pin 集合以及内存 header 索引里移除该 id。

只是「被加载」不算活动：在侧边栏打开会话会发布 live Session 并恢复 Agent，但日志
writer 每批只开/追加/关一次句柄，空闲会话没有可争用的句柄。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半边：持有删除路由，仅 loopback 可访问 |
| `client.js` | Client 半边：画右键菜单 |
| `cordis.patch.yml` | bundle patch，插入一条 `session-purge` 行 |
| `locale/{zh,en}.json` | 菜单文案 |

Host 与 Client 同包：纯 JS 本地 bundle 没有 typert schema，因此没有 `@Remote`
命名空间，两侧通过一条 loopback-only HTTP 路由通信。

## 安装

```bash
# 在 Harness 的 bundle 目录里
git clone <this-repo> dsh-session-purge
```

`package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`，注入
`@deepseek-ai/dsh-client-ui-workspace`，重启 Harness 后生效。

## 许可

未声明。
