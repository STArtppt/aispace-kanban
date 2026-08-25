# 发布与 CI 指南

看板发成 npm 包 **`@startist/aispace-kanban`**，用的人一条命令就能起：

```bash
npx -y @startist/aispace-kanban@latest
```

本文讲三件事：**平时怎么验、发版怎么走、出问题怎么查**。
编码规范总则在 [AGENTS.md](../AGENTS.md)（第 5.6 节是三平台与打包的硬约束），本文不重复。

---

## 1. 一张图：从改代码到别人能装上

```
改代码
  ↓  pnpm typecheck    只覆盖 src/app，服务端全绿也不代表没错
  ↓  pnpm build        产出 dist/，非 dev 模式的服务伺服的就是它
  ↓  pnpm build:npm    组出 npm-package/（bin + src/server + dist + template）
  ↓  pnpm pack:npm     打成 startist-aispace-kanban-<版本>.tgz
  ↓  pnpm smoke:npm    ★ 干净目录装上真跑一遍
  ↓  git tag v0.0.2 && git push --tags
  ↓  CI 三平台冒烟 → npm publish → GitHub Release
别人 npx 得到的就是这个包
```

仓库里的 `package.json` **保持占位 `0.0.1`，发版不手改**。正式号以 `v*` tag 为准，
组包时 `--version` 注入进发出去的包。界面侧栏和 `aispace-kanban --version`
走同一套解析（环境变量 → 非占位 package.json → git tag → `0.0.0-dev`）。

**中间那颗 ★ 是重点。** 本仓 `src/server/**` 和 `bin/cli.mjs`
**没有类型检查、没有单测**，前两道闸全绿照样可能发出一个装上就白屏的包。

---

## 2. 日常：每次推代码 CI 干了什么

工作流在 [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)，
触发时机：**推 main** 和 **开 PR**。两个 job：

| Job | 平台 | 干什么 |
| --- | --- | --- |
| `build` | ubuntu | `pnpm typecheck` → `pnpm build` → 组包 → `npm pack`，把 tgz 存成 artifact |
| `smoke` | **ubuntu + windows + macOS** | 下载同一个 tgz，装进干净目录跑 `scripts/smoke-package.mjs` |

三个平台装的是**同一个 artifact**，不是各自重新构建的 ——
保证「测的包」和「发的包」是同一个文件。

### 冒烟脚本查的 12 件事

`scripts/smoke-package.mjs`（本地也能跑：`pnpm smoke:npm`）：

1. 干净目录能装上，且 `dist/index.html` 在包里 -- 挡「组包前忘了 build」
2. 服务能起来，`/api/health` 通，回报的 `platform` 是当前系统
3. 首页和 `assets/*.js` 都取得到 -- 挡「dist 不完整」
4. **新建工作空间**能成 -- 这一条串起 Python 解释器 + 模板 + 注册表三样，
   打包后最容易断的就是它
5. 铺出来的骨架完整：`project.yaml` / `AGENTS.md` / `.gitignore` /
   `input/raw/.gitkeep` / `input/.ingestignore` / `.claude/skills/**`，并且 `skills/` 真的能用
6. 扫描接口正常，读得到 `project.yaml`，工作空间标了 `canIngest`
7. **界面触发的转换能跑完**（`POST /ingest`，空 `raw/` 时脚本秒退）--
   串起「看板 spawn 工作空间自己的 ingest.py」这条链
8. **路径穿越被挡**（`../../../etc/passwd` 必须 403）-- 只读红线的回归测试
9. **单文件转换只认 `input/raw/`**：路径穿越 403、`raw/` 以外 400
10. **忽略接口能写 `input/.ingestignore`**：写完待转换清单里不再出现，
    `stats.ignored` 开始计数
11. **忽略同样只认 `input/raw/`**，越界路径 403 / 400
12. 注册表写在隔离的假 HOME 里 -- 顺便证明冒烟本身没污染你的看板

> 第 12 条是给**本地跑**准备的：脚本给子进程换了个假 `HOME` / `USERPROFILE`，
> 冒烟建出来的工作空间不会跑进你自己的 `~/.pmwork/dashboard/projects.json`。

### 本地想跑完整一轮

```bash
pnpm typecheck && pnpm build && pnpm build:npm && pnpm pack:npm && pnpm smoke:npm
```

冒烟要装依赖，得联网；「新建工作空间」和「触发转换」那两步要本机有 Python 3
（模板的 `init_workspace.py` 和 `ingest.py` 都靠它）。

---

## 3. 发版：推 tag 就发

工作流在 [`.github/workflows/release.yml`](../.github/workflows/release.yml)，触发时机：**推 `v*` tag**。

### 一次性准备

发布走 npm 的**可信发布（Trusted Publishing）**：GitHub Actions 用 OIDC 向 npm
证明「我是这个仓库的这个工作流」，发布凭证现场签发、用完即弃，
不需要创建、轮换长期 `NPM_TOKEN`。

但 Trusted Publisher 的配置入口在 npm 上**包自己的设置页**里——
`@startist/aispace-kanban` 还没发布过、这个页面还不存在。
所以一次性准备分两步：先手动把首版发出去（把包「生」出来），
再回头把包连到本仓库的工作流上。

#### 第一步：手动发首版（只做一次）

用当初发 `@startist/pentou` 的那个 npm 账号，在装了 Python 3 的本机上：

```bash
# 1. 登录：npm ≥ 9 的登录在浏览器里完成，终端发起后等它自己回来
npm login
npm whoami    # 确认登的是对 @startist 有发布权的账号

# 2. 组包时注入首版号（仓库 package.json 保持 0.0.1 占位，不必手改）
# 3. 本地闸门完整走一遍（冒烟别跳，首版就翻车最难看）
pnpm typecheck && pnpm build && pnpm build:npm -- --version 0.0.1 && pnpm pack:npm && pnpm smoke:npm

# 4. 发布：scope 包默认私有（restricted），必须显式 --access public 才是公开包
cd npm-package
npm publish --access public
```

- 账号开了双因素认证（2FA）的话，`publish` 会停下来要一次性验证码，
  照提示输入即可（也可以 `--otp=123456` 直接带上）。
- 发完用 `npm view @startist/aispace-kanban` 验一下，能列出版本信息就成了；
  此时浏览器里打开 npmjs.com 也能看到包页面了。
- **首版的版本号不要再推 tag**：CI 会试图再发同一个号，而 npm 不允许重发，
  `publish` 步骤一定挂。从下一个版本（如 0.0.2）开始走 tag 流程；
  首版想要 GitHub Release 记录的话，在 Releases 页面手动建一条就行。

#### 第二步：配置可信发布（只做一次）

1. 打开 npmjs.com 上 `@startist/aispace-kanban` 的包页面 →
   **Settings（设置）** → 找到 **Trusted Publisher** 一节，连到本仓库。
   字段对照着填：
   - **Repository owner**：本仓库的 GitHub owner（用户名或组织名）
   - **Repository name**：仓库名，即 `aispace-kanban`
   - **Workflow filename**：`release.yml`（只要文件名，不含 `.github/workflows/` 前缀）
   - **Environment**：可选。填了的话 `release.yml` 的 `publish` job 里要声明
     同名的 `environment:`，相当于发布前多一道环境确认；不填就都不用动
2. 配完发一个下一个小版本实测整条链路：推 `v0.0.2` tag →
   CI 三平台冒烟 → OIDC 自动发布。这次成功，可信发布就算接通了；
   仓库里如果以前配过 `NPM_TOKEN` secret，到这一步可以删掉。

### 每次发版

```bash
# 仓库 package.json 保持 0.0.1 占位，不手改。正式号以 tag 为准。
git tag v0.0.2
git push && git push --tags
```

推上去之后 CI 自己做：

1. **复用整套日常闸门**（三平台冒烟全过才继续）
2. 用 tag 的版本号组包（`build-npm-package.mjs --version 0.0.2`）
3. **再冒烟一次**：这次装的是真正要推上 npm 的那个 tgz
4. `npm publish --access public`（可信发布，工作流里没有长期令牌）
5. 建一条 GitHub Release，附上 tgz 和 `npx` 命令

> **tag 推上去就是要发。** 版本号以 tag 为准，别拿 tag 当草稿。
> 发错了不要删 tag 重发同一个号 —— npm 不允许重发同版本号，直接发下一个补丁版。

### 手动发（CI 挂了 / 内网应急 / 发首版）

先 `npm login` 登录对 `@startist` 有发布权的账号（详见上文「一次性准备」第一步），
然后：

```bash
pnpm build:npm -- --version 0.0.2     # 正式号注入发出去的包，不必改仓库 package.json
pnpm pack:npm && pnpm smoke:npm    # 别跳
cd npm-package && npm publish --access public
```

---

## 4. 包里有什么、没有什么

`scripts/build-npm-package.mjs` 组出来的目录（约 1.2 MB）：

```
npm-package/
├── bin/cli.mjs        入口（package.json 的 bin 指它）
├── src/server/        常驻服务，原样拷过去
├── dist/              构建好的前端
├── template/          工作空间模板（新建工作空间要用）
└── package.json       ★ 重新生成的，不是仓库根那份
```

**依赖是重算的**：扫 `src/server/**` 和 `bin/cli.mjs` 的 import 图，
只把真用到的挑进 `dependencies`（当前只有 `yaml`）。
前端那十来个包已经被 vite 打进 `dist/`，装包的人不该再下一遍。

> 服务端引了一个不在根 `dependencies` 里的包，**组包会直接报错**，
> 不会等到用户装上才 `ERR_MODULE_NOT_FOUND`。

包里**没有**：前端源码、devDependencies、`.claude/`、`node_modules`。
所以 `serve --dev` 在装好的包里会明确报错（它需要 Vite 和前端源码）。

### npm 打包会吃掉的两类东西（模板里踩过）

| 被吃掉的 | 怎么绕 |
| --- | --- |
| 任何叫 `.gitignore` 的文件（`files` 字段也救不回来） | 组包时改名存成 `template/gitignore`，`init_workspace.py` 认这个名字 |
| 软链接 | `template/skills` 不进包；新建工作空间时由 `init_workspace.py` 现建**相对**软链接，Windows 建不了就复制一份实体目录 |

改模板结构时留意这两条，冒烟脚本的第 5 步就是盯它们的。

---

## 5. 三平台差异写在哪

**只写在 [`src/server/platform.mjs`](../src/server/platform.mjs)**：开浏览器、
在文件管理器里定位文件、找 Python 解释器。别在别处再写第二次 `spawn('open', ...)` ——
reveal 接口曾经在非 macOS 上直接返 501，就是因为这段散在 `http.mjs` 里。

| 事情 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 开浏览器 | `open <url>` | `cmd /c start "" <url>` | `xdg-open <url>` |
| 定位文件 | `open -R <路径>` | `explorer /select,<路径>` | `xdg-open <所在目录>` |
| 用默认程序打开 | `open <路径>` | `cmd /c start "" <路径>` | `xdg-open <路径>` |
| Python | `python3` → `python` | `py -3` → `python` → `python3` | `python3` → `python` |

界面上跟系统有关的文案（「在访达中显示」）从 `/api/health` 的 `platform` 取，
经 `hooks/useFileManager.ts`——**不能用浏览器的 `navigator`**，
因为定位动作发生在**服务所在的机器**上（服务和浏览器可以不在一台机器）。

**Node 下限是 20**：Linux 上 `fs.watch` 的递归监听（也就是 SSE 自动刷新）从 20 才有。
`bin/cli.mjs` 开头会检查，版本不够给中文提示而不是原始堆栈。

---

## 6. 出问题怎么查

| 症状 | 先看这里 |
| --- | --- |
| CI 的 `build` 挂在 `pnpm install --frozen-lockfile` | 改了依赖没提交 `pnpm-lock.yaml` |
| CI 挂在 `pnpm/action-setup` | 根 `package.json` 的 `packageManager` 字段被删了或和实际版本对不上 |
| 冒烟第 1 步失败 | 组包前没 `pnpm build`，或 `dist/` 是脏的 —— 本地 `rm -rf dist && pnpm build` 重来 |
| 冒烟第 4 / 7 步失败且提示 Python | 那台机器没 Python 3（新建工作空间和触发转换都要它）；CI 里是 `actions/setup-python` 装的 |
| 冒烟第 5 步说骨架缺文件 | 多半又踩了 npm 的打包规则（见第 4 节的表） |
| 冒烟第 8-11 步失败（路径穿越 / 越界） | **停下来**。这是只读红线破了，比发版重要 |
| `publish` 步骤 401 / 403 | 可信发布没对上：npm 侧配的 owner / 仓库名 / 工作流文件名和实际不一致；`release.yml` 丢了 `id-token: write` 权限；npm 版本低于 11.5（工作流里应有升级步骤）；或 scope 不归你 |
| `publish` 说版本已存在 | npm 不允许重发同版本号，发下一个补丁版 |
| 装完打开是旧界面 | `dist/` 是上一次构建的；组包脚本只检查存在，不检查新旧 |

服务端的坑（接口 404、界面不刷新等）见
[`.claude/skills/systematic-debugging`](../.claude/skills/systematic-debugging/SKILL.md)。

---

## 7. 关于内网 Gitea

本仓当前的 remote 是内网 Gitea，**GitHub Actions 在那儿不会跑**。
两条路，按需要选：

- 把仓库推到 GitHub（哪怕是私有库），CI 立刻生效；
- 或者内网 Gitea 启用 Actions 并注册 `act_runner`，把 `.github/workflows/`
  复制一份到 `.gitea/workflows/`（语法基本兼容，`actions/*` 需要 runner 能访问外网拉取）。

在那之前，本地把这一行跑绿就等价于 CI 的单平台版本：

```bash
pnpm typecheck && pnpm build && pnpm build:npm && pnpm pack:npm && pnpm smoke:npm
```
