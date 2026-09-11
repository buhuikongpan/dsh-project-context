# dsh-project-context · 给 DSH 工作区一个「用途」

> 包名和仓库名是历史标识（它最早只做「项目上下文」）。**如今它实现的是工作区用途分层：
> 项目工作区自带项目约定，临时会话不继承任何项目级上下文。**

DSH 原生只有**工作区**（workspace），没有**用途**：每个目录都被当成项目。
可真实使用里并不都是项目——有时只想临时问点东西、试一段一次性代码、让 agent 干点跟任何仓库
都无关的事。这些东西现在有了落脚点：

- **侧边栏「新会话」下面多一颗「临时会话」按钮**：点它在固定的临时工作区里开一个新会话；
- **那一个固定目录就是唯一的临时会话沙箱**：`$DSH_HOME/workspace/default`，**首次运行自动创建**（空目录）；
- **会话头出现「临时会话」徽标**：一眼看出当前会话在哪个环境里；
- **只有项目工作区会拿到提示词**：临时会话什么都不注入——它落在自己的工作区目录里，这件事由目录本身表达。

---

## 它做了什么

### 1. 用途只有一个判据

用途是**工作区的属性**，而且只有两种：`conversation`（就是那个固定临时目录）与 `project`（其余一切）。

没有「把任意工作区标成临时」的入口，也没有**会话级开关**——用途不是会话偶然的属性，
一个会话在项目目录里却被标成临时，是无法自洽的状态。因此状态文件里只留一个指针：

```json
{ "version": 1, "conversationWorkspaceId": "<uuid|null>" }
```

位置：`$DSH_HOME/storages/workspace-purpose.json`（原子写：tmp + rename；损坏/缺失一律当缺省态，不阻塞启动）。

### 2. 首次运行创建临时工作区（幂等）

启动时（`ctx.inject(['workspaceRegistry'])` 之后）：

1. `mkdir -p $DSH_HOME/workspace/default` —— **只建目录，不预放任何文件**（连 `.gitkeep` 都不放）；
2. `workspaceRegistry.resolveByPath(dir)` 命中即复用，未命中才 `create(dir, '临时会话')`；
3. 把 id 记进状态文件。

失败（权限/只读/路径被占）**不阻塞插件加载**：写一条 host 日志，按钮进入禁用态并在 tooltip 说明原因，
下次启动或下次点击会自动重试。临时工作区被手工删除/归档后，只重建目录与登记，**不恢复历史会话**。

### 3. 只给项目工作区注入消息块（`agent/pre-step`）

与技能目录（`dsh-tool-skill`）同款机制：一条带 `source.kind = 'workspace-purpose'` 的**独立 user 消息**，
不参与系统提示词拼接。

```
<project_context>
Working directory "<cwd>" is a project workspace: files for this work belong here.
Build a mental model before changing: inspect structure and entry points, follow the call chain.
Code is ground truth; docs are reference.
An empty directory is a new project — files still live here.
Report your understanding and plan before making changes.
</project_context>
```

**临时会话什么都不注入**：它落在自己的工作区目录里，这件事由目录本身表达，不需要再写一段文字去
"告诉"模型（何况那段文字是 user 消息，会被 compaction 折掉）。

- **幂等**：扫会话历史里 `surface` 可见的那条同来源消息，内容不变不重发；变化时**原位替换**（不是追加）。
- **无 cwd 的会话**（系统/后台）不注入、不判定。
- 不写任何自定义**会话事件**——harness 的已知事件类型白名单不含仓库外插件事件，写日志会让重启后的
  会话恢复抛 `SessionFormatUnsupportedError`（v0.3.x 的教训，这一版沿用文件存储）。

### 4. 两处 UI

| 位置 | 插槽（kind） | 内容 |
| --- | --- | --- |
| 侧边栏「新会话」下面 | `sidebar.panellist`（list / root） | 「临时会话」按钮：点它 = `uiWorkspace.startSession(临时工作区)`；**当前已是空白会话时不重复新建**。entry 里用 `stopPropagation` 把点击从外壳的 `selectPanel` 劫持过来（见「已知边界」） |
| 会话头 | `conversation.session.header.actions`（list / session） | 不可点的「临时会话」Pill，仅在当前会话属于临时工作区时渲染 |

判定口径：**反查 `workspaces` 快照里 `sessionIds.includes(sessionId)`，再比 workspaceId**——
纯 uuid 比较，不碰 Windows 路径大小写/8.3 短名的坑。宿主侧另有 cwd 兜底（`realpath` + 大小写归一）。

宿主只暴露一个**只读**端点 `GET /__workspace-purpose/state` → `{ok, conversationWorkspaceId, path, ready}`。
用途完全由目录决定，客户端没有任何需要写回的状态。

---

## 安装 / 更新

```bash
# 安装（或更新到最新 commit；GitHub 依赖会解析到默认分支最新提交）
dsh plugin --profile web add "github:buhuikongpan/dsh-project-context"

# 更新
dsh plugin --profile web update dsh-project-context
```

装完**必须重启** `dsh web` 才生效。确认 bundle 已进 profile 清单：

```bash
dsh --profile web --dump-config | grep -i project-context   # 只应出现一次
```

> ⚠️ 本插件与旧版的「每会话开关」语义**不兼容**：旧状态文件
> `~/.dsh/storages/project-context.json`（`{modes:{...}}`）已不再读写，可以手工删除。
> 旧会话历史里已有的 `project-context` 消息不会被改写（不删除别人的历史），
> 只是从这一版起不再被当作开关依据。

> **0.9.0 是一次回退**：0.6–0.8 试过"每个临时会话一个子目录 + 侧边栏浮层"，现在回到
> **一个共享的临时工作区 + 侧边栏按钮**那一套——会话因此显示在官方工作区树里那个
> 「临时会话」文件夹下面（浮层做不到这一点，因为"往侧边栏里塞第二棵树"不是插件能做的事）。
>
> 两处刻意保留：判定继续用**路径前缀匹配**（等于临时目录**或在其之下**都算临时会话），
> 所以你在 0.6–0.8 期间建的那些子目录会话不会被误判成项目、吃上 `<project_context>`；
> 注入保持**临时会话什么都不注入**（v0.5.1 那段 `<workspace_purpose>` 不再回来）。
>
> 浮层那套（`shell.overlay` / `sidebar.panellist` / `main` 占位 / hover 卡 / 折叠 / 搜索 /
> 重命名·分叉·归档）已删除。想回到 0.8.0：`git checkout v0.8.0`（tag 都在）。

---

## 已知边界（由 DSH 0.1.5-rc.1 的插槽体系决定，非本插件的取舍）

- **按钮能放进「新会话」下面那一排，代价是这个槽的语义挪用。** 那一排是 `sidebar.panellist`
  （`list` / root，官方契约写的是 "Global panel icons"），位置正好在官方「新会话」按钮正下方，
  每项由外壳渲染成一个按钮（图标 + 宽模式下的标签）。两条约束：entry 的渲染结果被塞进一个固定
  尺寸的图标位，且**外层是官方自己的 button，它的 onClick 是 `selectPanel(id)`**。所以插件画一个
  图标，再铺一层覆盖点击区的透明层并 `stopPropagation`，把点击改成"开新会话"；同时注册一个渲染
  `null` 的 `main` 占位——`selectPanel` 会校验 `hasMainPanel(id)`，不注册会抛错。
- **进不了工作区列表（`sidebar.workspaces`）。** 那是 `single` 槽且被 `WorkspaceBrowser` 占用，
  要贴进去只能整包替换官方组件——那会连带失去搜索/分组/重命名/归档/目录选择，版本脆弱，本插件不做。
- **临时工作区会像普通工作区一样出现在列表里**，并因「新建工作区置顶」而排在最前。我们不做排序干预
  （会和用户手动拖拽打架）；靠标题「临时会话」区分。
- **`$DSH_HOME/AGENTS.md` 仍会注入临时会话**：它是 DSH 明确识别的**用户级全局指令**
  （`dsh-agent-instructions`），不属于项目级作用域，本插件不去改变这一点。
- 官方没有 workspace purpose / 临时工作区的任何概念（全量 grep 0 命中），所以用途只存在本插件自己的
  状态文件里；官方的 `workspaceRecord` schema 是 `z.core.$strip`（未知键会被剥掉），本插件也不去给它加字段。

---

## 开发与验证

```bash
npm run check   # 三个文件的语法 + 浏览器半边的 classic-script 语法
npm test        # node --test：38 个用例
```

测试覆盖：

- `test/state.test.js` —— 状态文件读写的损坏容错、id 归一、缓存与磁盘一致性、路径规范化
- `test/ensure.test.js` —— 宿主集成（隔离 `$DSH_HOME` + 假 registry）：建目录、登记、**幂等**
  （已登记不重复 create）、**并发只 create 一次**、失败降级、**失败后可重试**、不预放文件
- `test/inject.test.js` —— 用途判定（registry membership / cwd 兜底 / 无 cwd）、文本渲染、历史幂等与可见性

人工端到端观察点：

1. 启动后 `$DSH_HOME/workspace/default` 被**自动创建**并在工作区注册表里登记为「临时会话」；侧边栏官方「新会话」按钮**下面**出现「临时会话」按钮；
2. 点按钮 → 新会话，会话头出现 Pill，**侧边栏那个「临时会话」文件夹下面多出一行**；首轮确认模型**看不到** `<project_context>`（临时会话什么都不注入）；
3. 打开一个真实项目工作区 → `<project_context>` 仍在、无 Pill；
4. 再次重启 → 判定不变，会话恢复正常（无 `SessionFormatUnsupportedError`）。

---

## 结构

```
lib/index.js     宿主半边：ensure 临时工作区 / 用途判定 / pre-step 注入 / 只读端点
lib/state.js     状态层：状态文件读写（纯函数 + 可注入 DSH_HOME）、路径规范化
lib/client.js    浏览器半边：panellist 入口（图标 + 点击劫持）+ 会话头 Pill
                 （classic script，无 JSX，纯 createElement）
cordis.patch.yml profile 层激活行（id 稳定，勿与 profile 里的手写行重复）
test/            node --test
```

License: MIT
