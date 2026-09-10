# dsh-project-context · 给 DSH 一个「临时会话」

> 包名和仓库名是历史标识（它最早只做「项目上下文」）。**如今它做的是临时会话**：
> 每个临时会话有自己的目录，产出文件各写各的；项目工作区照旧拿到精简的项目约定，
> 临时会话什么提示词都不注入。

DSH 原生只有**工作区**（workspace），没有**临时会话**：每个目录都被当成项目，
而"随手问一句、试一段一次性代码"这类事没有落脚点。这个插件补上它：

- **侧边栏底部多一颗「临时会话」按钮**：点它在 `$DSH_HOME/workspace/default/` 下建一个专属子目录，并以它为 cwd 开一个新会话；
- **每个临时会话一个目录**：产出文件各写各的，不会堆在一起；
- **插件不动你的权限配置**：临时会话常被用来清盘、整理文件，把它钉进沙箱会让这些事做不了——告诉模型它在哪个目录就够了；
- **会话头出现「临时会话」徽标**：一眼看出当前会话是不是临时会话；
- **临时会话不注入任何提示词**：它有自己的目录，不需要被"告诉"什么。

---

## 它做了什么

### 1. 用途判定是一个纯路径问题

```
cwd 在 $DSH_HOME/workspace/default 之下（含等于）→ conversation
其余                                            → project
```

没有状态文件、没有 registry 查询、没有会话级开关。用途是**目录结构本身**，不是
一份需要维护的映射——所以它不会陈旧、不会和实际状态打架。

> 判定含"等于根目录"是为了兼容子目录方案之前的旧临时会话：它们的 cwd 就是根目录
> 本身，不算进来的话会突然被当成项目、吃上 `<project_context>`。

### 2. 隔离靠目录结构，不靠提示词，也不靠锁权限

每个临时会话的 cwd 是它自己的子目录，工具的相对路径都基于 cwd，所以产出文件天然
各写各的——这正是官方 stray 会话本来的样子（各自的 cwd 由创建者指定），插件只是把它
自动化了：自动建目录 + 自动以它为 cwd 创建会话。

**插件不改会话的沙箱模式或审批策略。** 两个理由：

1. 临时会话经常被用来清盘、删文件、整理磁盘，钉死 `workspace-write` 会让这些事做不了；
2. `permission.defaultPreset` 是用户的显式配置，插件不该覆盖它。

告诉模型自己在哪个目录，它就有足够的倾向留在那儿。

代价说清楚：这是**惯例，不是物理保证**——模型用绝对路径仍然能写到别处。要真正锁死，
手动把那个会话的权限切到 `workspace-write` 即可，可写边界正好是它自己的目录。

### 3. 注入只发生在项目侧（`agent/pre-step`）

与技能目录（`dsh-tool-skill`）同款机制：一条带 `source.kind = 'workspace-purpose'` 的
**独立 user 消息**，不参与系统提示词拼接。

```
<project_context>
Working directory "<cwd>" is a project workspace: files for this work belong here.
Build a mental model before changing: inspect structure and entry points, follow the call chain.
Code is ground truth; docs are reference.
An empty directory is a new project — files still live here.
Report your understanding and plan before making changes.
</project_context>
```

- **临时会话不注入任何东西**（空串 = 不注入），并且会清掉本轮批次里可能自带的旧块；
- **幂等**：扫会话历史里 `surface` 可见的那条同来源消息，内容不变不重发；变化时**原位替换**（不是追加）；
- **无 cwd 的会话**（系统/后台）不注入、不判定。

### 4. 两处 UI

| 位置 | 插槽（kind） | 内容 |
| --- | --- | --- |
| 侧边栏底部 | `sidebar.footer.action`（list / root） | 「临时会话」按钮：`POST /__workspace-purpose/new-conversation` 让宿主建好子目录，再 `sessions.create({sessionId, cwd})` + `sessions.open(...)`；**当前已是空白会话时不重复新建** |
| 会话头 | `conversation.session.header.actions`（list / session） | 不可点的「临时会话」Pill，仅在会话 cwd 落在临时根目录之下时渲染 |

判定口径：会话 cwd 与宿主给的 root 做**前缀比较**（分隔符统一 + 大小写归一）。
cwd 是宿主自己生成的路径，字符串前缀足够，不碰 Windows 短名。

宿主暴露两个端点：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/__workspace-purpose/state` | `{ok, root, ready}` |
| `POST` | `/__workspace-purpose/new-conversation` | 建子目录，返回 `{ok, sessionId, cwd}` |

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

> ⚠️ **0.6.0 是架构变动版**：临时会话从"一个共享工作区"改成"每会话一个子目录 + 沙箱边界"。
> - 旧状态文件 `~/.dsh/storages/workspace-purpose.json` 已不再读写，可以手工删除；
> - 更早的 `~/.dsh/storages/project-context.json`（每会话开关时代）同样可以删；
> - 旧会话的 cwd 是根目录本身，判定仍然认（见上一节），但它们历史里已有的
>   `<workspace_purpose>` 消息不会被改写——插件不删别人的历史。

---

## 已知边界

- **临时会话落在侧边栏的「未分组」桶里。** 它们不属于任何工作区，所以按 DSH 的工作区
  分组规则归入 ungrouped。**这个分组名改不了**：`group.ungrouped` 属于官方
  `ui-workspace` 命名空间，而 locale 是单占位（重复注册直接抛错），lookup 链也不会
  让别处的同名字符串生效。要贴进工作区列表只能整包替换官方组件，那会连带失去
  搜索/分组/重命名/归档/目录选择，版本脆弱，本插件不做。
- **每个临时会话的目录会累积**，插件不做自动清理。手工清理就是删
  `$DSH_HOME/workspace/default/` 下的子目录（目录名 = 会话 id 去掉 `session-` 前缀），
  建议先确认对应会话已不再需要。
- **`$DSH_HOME/AGENTS.md` 仍会注入临时会话**：它是 DSH 明确识别的**用户级全局指令**
  （`dsh-agent-instructions`），不属于项目级作用域，本插件不去改变这一点。项目级的
  `AGENTS.md` 因为临时目录是空的而天然不生效。
- **目录隔离不等于沙箱**：临时会话各自有目录，但插件不限制文件访问，模型仍然可以用
  绝对路径写到别处（这往往正是你要的——临时会话常用来清盘、整文件）。要真正锁死就
  手动把该会话的权限切到 `workspace-write`，可写边界恰好是它自己的目录。
- **官方没有 workspace purpose / 临时会话的任何概念**（全量 grep 0 命中），所以用途只
  存在于本插件的路径约定里；官方的 `workspaceRecord` schema 是 `z.core.$strip`（未知键
  会被剥掉），本插件也不去给它加字段。

---

## 开发与验证

```bash
npm run check   # 三个文件的语法 + 浏览器半边的 classic-script 语法
npm test        # node --test
```

测试覆盖：

- `test/state.test.js` —— 根目录/会话目录路径、前缀判定（含相似前缀 `default-other`
  不算、`.`/`..` 拒绝）、路径规范化
- `test/inject.test.js` —— 用途判定、渲染（临时会话不注入）、历史幂等与可见性、
  会话目录准备

人工端到端观察点：

1. 启动后侧边栏底部出现按钮，点它 → 新会话，会话头出现 Pill；
2. 该会话首轮确认**只有**系统提示词、**没有** `<project_context>`；
3. 在临时会话里让模型写文件 → 落在 `$DSH_HOME/workspace/default/<会话 id>/`；
4. 开第二个临时会话 → 目录不同，看不到上一个会话的文件；
5. 在真实项目工作区开会话 → `<project_context>` 仍在、无 Pill；
6. 临时会话的权限与你其他会话一致（插件没动过它）。

---

## 结构

```
lib/index.js     宿主半边：路径判定 / 建会话目录 / pre-step 注入 / 两个端点
lib/state.js     路径层：根目录、会话目录、前缀判定、规范化
lib/client.js    浏览器半边：footer 按钮 + 会话头 Pill（classic script，无 JSX）
cordis.patch.yml profile 层激活行（id 稳定，勿与 profile 里的手写行重复）
test/            node --test
```

License: MIT
